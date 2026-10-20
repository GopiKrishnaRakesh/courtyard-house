# Build the courtyard house in Blender from the site's own geometry, with Cycles materials and light.
#
#   blender -b -P blender/build.py -- <dump dir>
#
# <dump dir> holds house.json / house.bin / leaf.png written by blender/export.mjs.
# The result is saved as blender/house.blend (textures are referenced from assets/, not packed).

import bpy, json, math, os, sys
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DUMP = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else HERE
TEX = os.path.join(ROOT, 'assets', 'tex')
MODELS = os.path.join(ROOT, 'assets', 'models')

# Plan coordinates (three.js): x east, y up, z south. Blender: X east, Y north, Z up.
def to_bl(a):
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)

# ---------- scene ----------

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'

# ---------- materials ----------

# Mirrors SPECS in js/materials.js; `size` is metres per texture tile.
SPECS = {
    'oak':        dict(tex='oak_wood_planks', size=2.2, sat=0.45, bright=1.55, rough=0.62, normal=0.7, coat=(0.18, 0.4)),
    'limestone':  dict(tex='marble_01', size=3.2, sat=0.55, bright=1.05, rough=0.8, normal=0.5),
    'paving':     dict(tex='marble_01', size=2.4, sat=0.5, bright=0.95, rough=0.95, normal=0.9),
    'travertine': dict(tex='travertine', size=1.8, sat=0.85, bright=1.0, rough=0.5, normal=0.35, coat=(0.3, 0.25)),
    'boucle':     dict(tex='boucle', nomap=True, size=0.22, rough=1.0, normal=1.3, color='#efe8dc', sheen='#fff8ee'),
    'plaster':    dict(tex='white_plaster_02', size=5.0, sat=0.1, bright=1.0, con=0.2, mean=0.86, rough=0.95, normal=0.35, color='#efe8de'),
    'roof':       dict(tex='white_plaster_02', size=5.0, sat=0.1, bright=1.0, con=0.25, mean=0.84, rough=0.95, normal=0.35, color='#e9e0d3'),
    'oakVeneer':  dict(tex='white_oak_veneer', size=1.6, sat=0.85, bright=1.0, rough=0.7, normal=0.6, coat=(0.3, 0.35)),
    'linen':      dict(tex='rough_linen', size=0.7, sat=0.0, bright=1.15, rough=1.0, normal=0.8, color='#efe6d8', sheen='#fff6ea'),
    'linenWarm':  dict(tex='rough_linen', size=0.7, sat=0.0, bright=1.1, rough=1.0, normal=0.8, color='#c9ad88', sheen='#f3dcc0'),
    'rug':        dict(tex='rough_linen', size=0.45, sat=0.0, bright=1.05, rough=1.0, normal=1.0, color='#ddd2c0', sheen='#f6ecdc'),
    'lawn':       dict(tex='leafy_grass', size=3.0, sat=1.0, bright=0.9, rough=1.0, normal=1.0, color='#b4c59a'),
    'gravel':     dict(tex='gravel_floor_02', size=1.6, sat=0.6, bright=1.1, rough=1.0, normal=1.0),
    'book1': dict(color='#8c7b66', rough=0.75), 'book2': dict(color='#5c5853', rough=0.75),
    'book3': dict(color='#c2b293', rough=0.75), 'book4': dict(color='#3f4a50', rough=0.7),
    'book5': dict(color='#9b6a4c', rough=0.75), 'book6': dict(color='#e2d9c8', rough=0.8),
    'steel':      dict(color='#1d1c1b', metal=0.6, rough=0.4),
    'brass':      dict(color='#c39a5b', metal=1.0, rough=0.26),
    'blackStone': dict(color='#24211f', rough=0.3),
    'lacquer':    dict(color='#141312', rough=0.2, coat=(1.0, 0.05)),
    'porcelain':  dict(color='#f4f1ec', rough=0.22, coat=(0.8, 0.06)),
    'mirror':     dict(color='#dfe3e2', metal=1.0, rough=0.02),
    'bark':       dict(color='#5e5145', rough=0.95),
}
EMIT = {'shade': ('#f4ecdd', '#ffd096', 3.0), 'lampGlow': ('#fff4e0', '#ffcf8f', 6.0), 'ledGlow': ('#fff6e8', '#ffe2b8', 14.0)}


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def new_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    return m, nt, out


def principled(nt):
    return nt.nodes.new('ShaderNodeBsdfPrincipled')


def img(nt, path, srgb_space, vec):
    n = nt.nodes.new('ShaderNodeTexImage')
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = 'sRGB' if srgb_space else 'Non-Color'
    n.image = im
    nt.links.new(vec, n.inputs['Vector'])
    return n


def mix_rgb(nt, fac, a, b, blend='MIX'):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'RGBA'
    n.blend_type = blend
    n.inputs[0].default_value = fac
    ins = [i for i in n.inputs if i.type == 'RGBA']
    outs = [o for o in n.outputs if o.type == 'RGBA']
    for slot, v in ((ins[0], a), (ins[1], b)):
        if isinstance(v, tuple): slot.default_value = v
        else: nt.links.new(v, slot)
    return outs[0]


def spec_material(name, s):
    m, nt, out = new_mat('H_' + name)
    p = principled(nt)
    nt.links.new(p.outputs[0], out.inputs[0])
    p.inputs['Roughness'].default_value = s.get('rough', 0.9)
    p.inputs['Metallic'].default_value = s.get('metal', 0.0)
    base = srgb(s.get('color', '#ffffff'))
    p.inputs['Base Color'].default_value = base
    if 'tex' in s:
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        k = 1.0 / s['size']
        mp.inputs['Scale'].default_value = (k, k, k)
        nt.links.new(tc.outputs['UV'], mp.inputs['Vector'])
        vec = mp.outputs['Vector']
        t = s['tex']
        col = None
        if not s.get('nomap'):
            d = img(nt, os.path.join(TEX, t + '_diff.jpg'), True, vec)
            hs = nt.nodes.new('ShaderNodeHueSaturation')
            hs.inputs['Saturation'].default_value = s.get('sat', 1.0)
            hs.inputs['Value'].default_value = s.get('bright', 1.0)
            nt.links.new(d.outputs['Color'], hs.inputs['Color'])
            col = hs.outputs['Color']
            if 'con' in s:
                mv = s.get('mean', 1.0)
                col = mix_rgb(nt, s['con'], (mv, mv, mv, 1.0), col)
            col = mix_rgb(nt, 1.0, col, base, 'MULTIPLY')
            nt.links.new(col, p.inputs['Base Color'])
        r = img(nt, os.path.join(TEX, t + '_rough.jpg'), False, vec)
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = s['rough']
        mul.use_clamp = True
        nt.links.new(r.outputs['Color'], mul.inputs[0])
        nt.links.new(mul.outputs[0], p.inputs['Roughness'])
        nm = img(nt, os.path.join(TEX, t + '_nor_gl.jpg'), False, vec)
        nmap = nt.nodes.new('ShaderNodeNormalMap')
        nmap.inputs['Strength'].default_value = s['normal']
        nt.links.new(nm.outputs['Color'], nmap.inputs['Color'])
        nt.links.new(nmap.outputs['Normal'], p.inputs['Normal'])
    if 'coat' in s:
        p.inputs['Coat Weight'].default_value = s['coat'][0]
        p.inputs['Coat Roughness'].default_value = s['coat'][1]
    if 'sheen' in s:
        p.inputs['Sheen Weight'].default_value = 1.0
        p.inputs['Sheen Roughness'].default_value = 0.6
        p.inputs['Sheen Tint'].default_value = srgb(s['sheen'])
    return m


def glass_material():
    # Thin architectural glass: reflective to the camera, transparent to every other ray, so sun and
    # sky reach the rooms without caustic noise and reflections never bounce between the two faces of a pane.
    m, nt, out = new_mat('H_glass')
    lp = nt.nodes.new('ShaderNodeLightPath')
    gl = nt.nodes.new('ShaderNodeBsdfGlossy')
    gl.inputs['Roughness'].default_value = 0.0
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    tr.inputs['Color'].default_value = (0.97, 0.98, 0.975, 1)
    fr = nt.nodes.new('ShaderNodeFresnel')
    fr.inputs['IOR'].default_value = 1.52
    face = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(fr.outputs[0], face.inputs[0])
    nt.links.new(tr.outputs[0], face.inputs[1])
    nt.links.new(gl.outputs[0], face.inputs[2])
    sh = nt.nodes.new('ShaderNodeMath')
    sh.operation = 'SUBTRACT'
    sh.inputs[0].default_value = 1.0
    nt.links.new(lp.outputs['Is Camera Ray'], sh.inputs[1])
    # the inner face of a pane reflects nothing (otherwise its Fresnel turns into total internal reflection)
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    back = nt.nodes.new('ShaderNodeMath')
    back.operation = 'MAXIMUM'
    nt.links.new(sh.outputs[0], back.inputs[0])
    nt.links.new(geo.outputs['Backfacing'], back.inputs[1])
    sh = back
    fin = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(sh.outputs[0], fin.inputs[0])
    nt.links.new(face.outputs[0], fin.inputs[1])
    tr2 = nt.nodes.new('ShaderNodeBsdfTransparent')
    nt.links.new(tr2.outputs[0], fin.inputs[2])
    nt.links.new(fin.outputs[0], out.inputs[0])
    return m


def water_material():
    m, nt, out = new_mat('H_water')
    p = principled(nt)
    p.inputs['Base Color'].default_value = srgb('#0f2d2c')
    p.inputs['Roughness'].default_value = 0.02
    p.inputs['IOR'].default_value = 1.33
    # gentle ripples
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = 1.6
    n.inputs['Detail'].default_value = 4
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.06
    nt.links.new(n.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    nt.links.new(p.outputs[0], out.inputs[0])
    return m


def emit_material(name, base, glow, strength):
    m, nt, out = new_mat('H_' + name)
    p = principled(nt)
    p.inputs['Base Color'].default_value = srgb(base)
    p.inputs['Roughness'].default_value = 0.6
    p.inputs['Emission Color'].default_value = srgb(glow)
    p.inputs['Emission Strength'].default_value = strength
    nt.links.new(p.outputs[0], out.inputs[0])
    return m


def sheer_material():
    m, nt, out = new_mat('H_sheer')
    tl = nt.nodes.new('ShaderNodeBsdfTranslucent')
    tl.inputs['Color'].default_value = srgb('#f6f1e8')
    df = nt.nodes.new('ShaderNodeBsdfDiffuse')
    df.inputs['Color'].default_value = srgb('#f6f1e8')
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    a = nt.nodes.new('ShaderNodeMixShader')
    a.inputs[0].default_value = 0.5
    nt.links.new(df.outputs[0], a.inputs[1])
    nt.links.new(tl.outputs[0], a.inputs[2])
    b = nt.nodes.new('ShaderNodeMixShader')
    b.inputs[0].default_value = 0.72
    nt.links.new(tr.outputs[0], b.inputs[1])
    nt.links.new(a.outputs[0], b.inputs[2])
    nt.links.new(b.outputs[0], out.inputs[0])
    return m


def leaf_material(name, tint):
    m, nt, out = new_mat('H_' + name)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(os.path.join(DUMP, 'leaf.png'), check_existing=True)
    tex.image.pack()
    tex.interpolation = 'Cubic'
    col = mix_rgb(nt, 1.0, tex.outputs['Color'], srgb(tint), 'MULTIPLY')
    p = principled(nt)
    p.inputs['Roughness'].default_value = 0.65
    nt.links.new(col, p.inputs['Base Color'])
    tl = nt.nodes.new('ShaderNodeBsdfTranslucent')
    nt.links.new(col, tl.inputs['Color'])
    mx = nt.nodes.new('ShaderNodeMixShader')
    mx.inputs[0].default_value = 0.3
    nt.links.new(p.outputs[0], mx.inputs[1])
    nt.links.new(tl.outputs[0], mx.inputs[2])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    cut = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(tex.outputs['Alpha'], cut.inputs[0])
    nt.links.new(tr.outputs[0], cut.inputs[1])
    nt.links.new(mx.outputs[0], cut.inputs[2])
    nt.links.new(cut.outputs[0], out.inputs[0])
    return m


def house_material(name):
    if name == 'glass': return glass_material()
    if name == 'water': return water_material()
    if name == 'sheer': return sheer_material()
    if name == 'leaves': return leaf_material('leaves', '#ffffff')
    if name == 'leavesDark': return leaf_material('leavesDark', '#5d7350')
    if name in EMIT: return emit_material(name, *EMIT[name])
    return spec_material(name, SPECS[name])


# Poly Haven models: import each glTF once just to take its materials.
def model_materials():
    have = {}
    for mid in sorted(os.listdir(MODELS)):
        f = os.path.join(MODELS, mid, mid + '_1k.gltf')
        if not os.path.exists(f): continue
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=f)
        for o in set(bpy.data.objects) - before:
            for s in getattr(o, 'material_slots', []):
                if s.material: have[s.material.name] = s.material
            bpy.data.objects.remove(o, do_unlink=True)
    return have


# ---------- geometry ----------

man = json.load(open(os.path.join(DUMP, 'house.json')))
raw = open(os.path.join(DUMP, 'house.bin'), 'rb').read()

groups = {}
for e in man:
    off = e['off']
    nv, ni = e['nv'], e['ni']
    P = np.frombuffer(raw, np.float32, nv * 3, off).reshape(-1, 3); off += nv * 12
    N = np.frombuffer(raw, np.float32, nv * 3, off).reshape(-1, 3); off += nv * 12
    U = np.frombuffer(raw, np.float32, nv * 2, off).reshape(-1, 2); off += nv * 8
    I = np.frombuffer(raw, np.uint32, ni, off)
    groups.setdefault(e['mat'], []).append((P, N, U, I))

mod_mats = model_materials()
coll = bpy.data.collections.new('House')
scene.collection.children.link(coll)

for mat, parts in groups.items():
    Ps, Ns, Us, Is = [], [], [], []
    base = 0
    for P, N, U, I in parts:
        Ps.append(P); Ns.append(N); Us.append(U); Is.append(I.astype(np.int64) + base)
        base += len(P)
    P = to_bl(np.concatenate(Ps)); N = to_bl(np.concatenate(Ns)); U = np.concatenate(Us); I = np.concatenate(Is)
    nt = len(I) // 3
    me = bpy.data.meshes.new(mat)
    me.vertices.add(len(P))
    me.vertices.foreach_set('co', P.astype(np.float32).ravel())
    me.loops.add(len(I))
    me.loops.foreach_set('vertex_index', I.astype(np.int32))
    me.polygons.add(nt)
    me.polygons.foreach_set('loop_start', np.arange(0, len(I), 3, dtype=np.int32))
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', U[I].astype(np.float32).ravel())
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    if len(me.loops) == len(I):
        me.normals_split_custom_set(N[I].tolist())
    if mat.startswith('H_'):
        m = bpy.data.materials.get(mat) or house_material(mat[2:])
    else:
        m = mod_mats.get(mat[2:])
        if m is None:
            print('missing model material', mat)
            m = spec_material(mat[2:], dict(color='#bbbbbb', rough=0.6))
    me.materials.append(m)
    ob = bpy.data.objects.new(mat, me)
    coll.objects.link(ob)
    if mat == 'H_glass':
        ob.visible_shadow = False
    print('built', mat, len(P), 'verts')

# ---------- light ----------

world = bpy.data.worlds.new('Golden hour')
scene.world = world
world.use_nodes = True
wt = world.node_tree
wt.nodes.clear()
wo = wt.nodes.new('ShaderNodeOutputWorld')
env = wt.nodes.new('ShaderNodeTexEnvironment')
env.image = bpy.data.images.load(os.path.join(ROOT, 'assets', 'hdri', 'sky_2k.hdr'))
# Camera rays see the real sky; light rays see it with the sun clipped out (the sun lamp is the sun).
clamp = wt.nodes.new('ShaderNodeVectorMath')
clamp.operation = 'MINIMUM'
clamp.inputs[1].default_value = (3.0, 3.0, 3.0)
wl = wt.links
wl.new(env.outputs['Color'], clamp.inputs[0])
bg_cam = wt.nodes.new('ShaderNodeBackground'); bg_cam.inputs['Strength'].default_value = 0.85
bg_lit = wt.nodes.new('ShaderNodeBackground'); bg_lit.inputs['Strength'].default_value = 0.42
wl.new(env.outputs['Color'], bg_cam.inputs['Color'])
wl.new(clamp.outputs[0], bg_lit.inputs['Color'])
lp = wt.nodes.new('ShaderNodeLightPath')
mx = wt.nodes.new('ShaderNodeMixShader')
wl.new(lp.outputs['Is Camera Ray'], mx.inputs[0])
wl.new(bg_lit.outputs[0], mx.inputs[1])
wl.new(bg_cam.outputs[0], mx.inputs[2])
wl.new(mx.outputs[0], wo.inputs['Surface'])

# Golden-hour sun, same direction as js/main.js SUN_DIR (-0.86, 0.41, 0.3) -> Blender (x, -z, y).
sun_dir = Vector((-0.86, -0.3, 0.41)).normalized()
sd = bpy.data.lights.new('Sun', 'SUN')
sd.energy = 5.2
sd.color = srgb('#ffd2a0')[:3]
sd.angle = math.radians(0.8)
sun = bpy.data.objects.new('Sun', sd)
sun.rotation_euler = (-sun_dir).to_track_quat('-Z', 'Y').to_euler()
scene.collection.objects.link(sun)


def point(name, xyz, watts, col, radius=0.08):
    l = bpy.data.lights.new(name, 'POINT')
    l.energy = watts
    l.color = srgb(col)[:3]
    l.shadow_soft_size = radius
    o = bpy.data.objects.new(name, l)
    x, y, z = xyz
    o.location = (x, -z, y)
    scene.collection.objects.link(o)


# interior lamps from js/main.js, in plan coordinates
point('Pendant', (17.25, 2.55, 22.4), 90, '#ffc78c', 0.12)
for x in (14.35, 17.65): point('Portal', (x, 2.35, 26.9), 18, '#ffc27a', 0.05)
point('Arc lamp', (3.6, 1.75, 9.1), 45, '#ffc98e', 0.1)
for i, (x, y, z, w) in enumerate([(24.5, 2.6, 18.7, 35), (27.6, 2.4, 24.0, 25), (2.25, 0.98, 5.15, 22), (6.95, 1.24, 20.95, 22)]):
    point(f'Lamp {i}', (x, y, z), w, '#ffcf98', 0.1)
for x in (26.35, 29.65): point('Bedside', (x, 1.0, 8.62), 14, '#ffc27e', 0.05)
for x in (25.0, 26.2, 27.4): point('Globe', (x, 2.05, 4.6), 28, '#ffcf98', 0.09)
for x in (14.0, 16.0): point('Dining', (x, 1.85, 4.0), 30, '#ffc98e', 0.1)

# ---------- camera and render ----------

cd = bpy.data.cameras.new('Camera')
cd.sensor_fit = 'VERTICAL'
cam = bpy.data.objects.new('Camera', cd)
scene.collection.objects.link(cam)
scene.camera = cam

scene.render.engine = 'CYCLES'
c = scene.cycles
c.device = 'GPU'
c.samples = 384
c.adaptive_threshold = 0.02
c.use_denoising = True
c.denoiser = 'OPENIMAGEDENOISE'
c.max_bounces = 10
c.diffuse_bounces = 5
c.glossy_bounces = 4
c.transmission_bounces = 8
c.transparent_max_bounces = 24
c.caustics_reflective = False
c.caustics_refractive = False
c.blur_glossy = 1.0
c.sample_clamp_indirect = 8.0
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - High Contrast'

out = os.path.join(HERE, 'house.blend')
bpy.ops.wm.save_as_mainfile(filepath=out, relative_remap=True)
print('saved', out)
