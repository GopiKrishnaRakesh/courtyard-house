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
    'oak':        dict(tex='oak_wood_planks', size=2.4, sat=0.28, bright=1.38, rough=0.65, normal=1.0, coat=(0.22, 0.35), color='#f5eee4'),
    'limestone':  dict(tex='marble_01', size=3.2, sat=0.45, bright=1.05, rough=0.8, normal=0.9, color='#f0ece4'),
    'paving':     dict(tex='marble_01', size=2.4, sat=0.45, bright=0.98, rough=0.95, normal=0.9),
    'travertine': dict(tex='travertine', size=1.8, sat=0.52, bright=1.04, rough=0.52, normal=0.7, coat=(0.28, 0.25), color='#eee7db'),
    'boucle':     dict(tex='boucle', nomap=True, size=0.22, rough=0.95, normal=1.2, color='#f2ece2', sheen='#fffdf8'),
    'plaster':    dict(tex='white_plaster_02', size=4.0, sat=0.0, bright=1.02, con=0.18, mean=0.98, rough=0.92, normal=0.25, color='#f7f4ee'),
    'roof':       dict(tex='white_plaster_02', size=5.0, sat=0.0, bright=1.0, con=0.12, mean=0.98, rough=0.95, normal=0.2, color='#f6f3ee'),
    'oakVeneer':  dict(tex='white_oak_veneer', size=1.6, sat=0.55, bright=1.08, rough=0.7, normal=1.0, coat=(0.28, 0.35)),
    'linen':      dict(tex='rough_linen', size=0.5, sat=0.0, bright=1.15, rough=1.0, normal=1.0, color='#eae3d6', sheen='#fff9f0'),
    'linenWarm':  dict(tex='rough_linen', size=0.5, sat=0.0, bright=1.1, rough=1.0, normal=1.0, color='#c7ad89', sheen='#f3e2cc'),
    'rug':        dict(tex='rough_linen', size=0.3, sat=0.0, bright=1.05, rough=1.0, normal=1.2, color='#dfd5c4', sheen='#f8f0e2'),
    'lawn':       dict(tex='leafy_grass', size=3.0, sat=0.75, bright=0.95, rough=1.0, normal=1.0, color='#9db37f'),
    'gravel':     dict(tex='gravel_floor_02', size=1.6, sat=0.5, bright=1.1, rough=1.0, normal=1.0),
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
EMIT = {'shade': ('#f4ecdd', '#ffd096', 3.0), 'lampGlow': ('#fff4e0', '#ffcf8f', 6.0), 'ledGlow': ('#fff6e8', '#ffe2b8', 14.0),
        'fireGlow': ('#3a2214', '#ff7a2a', 22.0)}


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
    n.interpolation = 'Cubic'
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

# Real joinery and stone never have knife edges: weld each box and bevel its hard edges (metres).
# Plaster walls and the roof are left alone: they are built from abutting boxes, so a bevel would draw joints.
BEVEL = {'H_limestone': 0.004, 'H_travertine': 0.004, 'H_oakVeneer': 0.0025, 'H_blackStone': 0.003, 'H_lacquer': 0.002,
         'H_steel': 0.0012, 'H_brass': 0.0012, 'H_porcelain': 0.003, 'H_paving': 0.004, 'H_oak': 0.002, 'H_rug': 0.006,
         'H_book1': 0.0015, 'H_book2': 0.0015, 'H_book3': 0.0015, 'H_book4': 0.0015, 'H_book5': 0.0015, 'H_book6': 0.0015}


def bevel(ob, width):
    import bmesh
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bm.to_mesh(me)
    bm.free()
    me.set_sharp_from_angle(angle=math.radians(35))
    m = ob.modifiers.new('Bevel', 'BEVEL')
    m.width = width
    m.segments = 2
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(35)
    m.harden_normals = True
    m.miter_outer = 'MITER_ARC'


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
    if len(me.loops) == len(I) and mat not in BEVEL:
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
    if mat in BEVEL:
        bevel(ob, BEVEL[mat])
    print('built', mat, len(P), 'verts')

# ---------- distant landscape (render only) ----------

# Rolling fields and tree clumps beyond the lawn, so the glass looks out on countryside, not a horizon line.
def fbm(x, y, seed=0):
    rng = np.random.default_rng(seed)
    h = np.zeros_like(x)
    amp, freq = 1.0, 1 / 420
    for _ in range(6):
        a = rng.uniform(0, 2 * np.pi)
        ph = rng.uniform(0, 2 * np.pi, 2)
        u = x * np.cos(a) + y * np.sin(a)
        v = -x * np.sin(a) + y * np.cos(a)
        h += amp * np.sin(u * freq * 2 * np.pi + ph[0]) * np.cos(v * freq * 1.7 * np.pi + ph[1])
        amp *= 0.5
        freq *= 2.1
    return h


CX, CY = 16.0, -13.0
n = 241
gx, gy = np.meshgrid(np.linspace(-1600, 1600, n) + CX, np.linspace(-1600, 1600, n) + CY)
r = np.hypot(gx - CX, gy - CY)
ramp = np.clip((r - 235) / 320, 0, 1) ** 1.6
gz = -0.4 + ramp * (14 + 26 * fbm(gx, gy, 3))
gz = np.where(r < 235, -0.6, np.maximum(gz, -0.4))
verts = np.stack([gx, gy, gz], -1).reshape(-1, 3)
quads = []
for j in range(n - 1):
    for i in range(n - 1):
        k = j * n + i
        quads.append((k, k + 1, k + n + 1, k + n))
hm = bpy.data.meshes.new('Hills')
hm.from_pydata(verts.tolist(), [], quads)
hm.shade_smooth()
hills = bpy.data.objects.new('Hills', hm)
coll.objects.link(hills)
fm, ft, fo = new_mat('Fields')
fp = principled(ft)
fp.inputs['Roughness'].default_value = 1.0
tco = ft.nodes.new('ShaderNodeTexCoord')
fn = ft.nodes.new('ShaderNodeTexNoise')
fn.inputs['Scale'].default_value = 0.006
fn.inputs['Detail'].default_value = 6
ft.links.new(tco.outputs['Object'], fn.inputs['Vector'])
ramp_n = ft.nodes.new('ShaderNodeValToRGB')
ramp_n.color_ramp.elements[0].color = srgb('#6f7a4c')
ramp_n.color_ramp.elements[1].color = srgb('#a9a66b')
ft.links.new(fn.outputs['Fac'], ramp_n.inputs['Fac'])
ft.links.new(ramp_n.outputs['Color'], fp.inputs['Base Color'])
ft.links.new(fp.outputs[0], fo.inputs[0])
hm.materials.append(fm)

# tree clumps scattered over the hills, denser in hedgerow lines
rng = np.random.default_rng(11)
pts = []
while len(pts) < 1400:
    x, y = rng.uniform(-1500, 1500, 2) + (CX, CY)
    rr = np.hypot(x - CX, y - CY)
    if rr < 260: continue
    line = abs(np.sin((x + 0.6 * y) / 90.0)) < 0.12 or abs(np.sin((y - 0.3 * x) / 140.0)) < 0.1
    if not line and rng.random() > 0.25: continue
    i = int(np.clip((x - CX + 1600) / 3200 * (n - 1), 0, n - 1)); j = int(np.clip((y - CY + 1600) / 3200 * (n - 1), 0, n - 1))
    pts.append((x, y, gz[j, i], rng.uniform(4, 9)))
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
blob = bpy.context.active_object
bv = np.array([v.co[:] for v in blob.data.vertices])
bf = [tuple(p.vertices) for p in blob.data.polygons]
bpy.data.objects.remove(blob, do_unlink=True)
tv, tf = [], []
for k, (x, y, z, s_) in enumerate(pts):
    sq = 0.8 + rng.random() * 0.7
    # irregular but smooth crowns: a few soft bulges over the sphere, not per-vertex noise
    ph = rng.uniform(0, 2 * np.pi, 3)
    lump = (1 + 0.13 * np.sin(2.3 * bv[:, 0] + ph[0]) * np.cos(2.1 * bv[:, 1] + ph[1])
            + 0.09 * np.sin(3.1 * bv[:, 2] + ph[2]))[:, None]
    tv.append(bv * lump * (s_ * rng.uniform(0.8, 1.25), s_ * rng.uniform(0.8, 1.25), s_ * sq) + (x, y, z + s_ * sq * 0.7))
    tf += [tuple(len(bv) * k + q for q in f) for f in bf]
tm = bpy.data.meshes.new('Distant trees')
tm.from_pydata(np.concatenate(tv).tolist(), [], tf)
tm.shade_smooth()
trees = bpy.data.objects.new('Distant trees', tm)
coll.objects.link(trees)
dm, dt, do = new_mat('Distant foliage')
dp = principled(dt)
dp.inputs['Base Color'].default_value = srgb('#3f4a2e')
dp.inputs['Roughness'].default_value = 1.0
dn = dt.nodes.new('ShaderNodeTexNoise'); dn.inputs['Scale'].default_value = 1.5; dn.inputs['Detail'].default_value = 8
db = dt.nodes.new('ShaderNodeBump'); db.inputs['Strength'].default_value = 0.8
dt.links.new(dn.outputs['Fac'], db.inputs['Height']); dt.links.new(db.outputs['Normal'], dp.inputs['Normal'])
dt.links.new(dp.outputs[0], do.inputs[0])
tm.materials.append(dm)

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
bg_lit = wt.nodes.new('ShaderNodeBackground'); bg_lit.inputs['Strength'].default_value = 0.75
wl.new(env.outputs['Color'], bg_cam.inputs['Color'])
wl.new(clamp.outputs[0], bg_lit.inputs['Color'])
lp = wt.nodes.new('ShaderNodeLightPath')
mx = wt.nodes.new('ShaderNodeMixShader')
wl.new(lp.outputs['Is Camera Ray'], mx.inputs[0])
wl.new(bg_lit.outputs[0], mx.inputs[1])
wl.new(bg_cam.outputs[0], mx.inputs[2])
wl.new(mx.outputs[0], wo.inputs['Surface'])
# Aerial perspective: a low layer of hazy air over the land softens the distance. It is a bounded box
# (a world volume would swallow the sun, which arrives from infinitely far away).
# The box is hollow around the house (+-70 m), so rays inside the rooms never pay for volume sampling.
def box(x0, y0, z0, x1, y1, z1, inward=False):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, [tuple(reversed(q)) for q in f] if inward else f
ov, of = box(16 - 1700, -13 - 1700, -50, 16 + 1700, -13 + 1700, 60)
iv, if_ = box(16 - 70, -13 - 70, -5, 16 + 70, -13 + 70, 30, inward=True)
am = bpy.data.meshes.new('Haze')
am.from_pydata(ov + iv, [], of + [tuple(i + 8 for i in q) for q in if_])
air = bpy.data.objects.new('Haze', am)
bpy.context.scene.collection.objects.link(air)
hm_, ht, ho = new_mat('Haze')
hz = ht.nodes.new('ShaderNodeVolumePrincipled')
hz.inputs['Color'].default_value = srgb('#e3e9ef')
hz.inputs['Density'].default_value = 0.0009
hz.inputs['Anisotropy'].default_value = 0.6
ht.links.new(hz.outputs[0], ho.inputs['Volume'])
air.data.materials.append(hm_)
air.visible_shadow = True

# Golden-hour sun, same direction as js/main.js SUN_DIR (-0.86, 0.41, 0.3) -> Blender (x, -z, y).
sun_dir = Vector((-0.86, -0.3, 0.41)).normalized()
sd = bpy.data.lights.new('Sun', 'SUN')
sd.energy = 4.6
sd.color = srgb('#ffe4c6')[:3]
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
point('Fire', (9.45, 0.7, 7.05), 60, '#ff8a3a', 0.25)
for x in (25.3, 31.0): point('Bath sconce', (x, 2.12, 25.45), 12, '#ffcf98', 0.05)

# ---------- camera and render ----------

cd = bpy.data.cameras.new('Camera')
cd.sensor_fit = 'VERTICAL'
cam = bpy.data.objects.new('Camera', cd)
scene.collection.objects.link(cam)
scene.camera = cam

scene.render.engine = 'CYCLES'
c = scene.cycles
c.device = 'GPU'
c.samples = 512
c.adaptive_threshold = 0.012
c.use_denoising = True
c.denoiser = 'OPENIMAGEDENOISE'
# denoise guided by albedo and normals, at full quality, so grain in wood, stone and linen survives
c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
c.denoising_prefilter = 'ACCURATE'
c.denoising_quality = 'HIGH'
c.max_bounces = 10
c.diffuse_bounces = 5
c.glossy_bounces = 4
c.transmission_bounces = 8
c.transparent_max_bounces = 24
c.caustics_reflective = False
c.caustics_refractive = False
c.blur_glossy = 0.5
c.sample_clamp_indirect = 8.0
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
# neutralise the golden-hour cast so whites read white; the sun patches stay warm
scene.view_settings.use_white_balance = True
scene.view_settings.white_balance_temperature = 5200

out = os.path.join(HERE, 'house.blend')
bpy.ops.wm.save_as_mainfile(filepath=out, relative_remap=True)
print('saved', out)
