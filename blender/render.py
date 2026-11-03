# Render the site's camera stops from blender/house.blend with Cycles.
#
#   blender -b blender/house.blend -P blender/render.py -- [--stops entry,living] [--variants land,port]
#                                                          [--scale 1.0] [--samples 512] [--out assets/renders]
#
# Each stop is rendered from the exact pose the scroll camera rests at (blender/cameras.json, read
# from the live page), in two framings the page picks between:
#   land  2.4:1 (4608x1920), vertical FOV widened 11% over the site's, so it covers any landscape window (aspect >= 1.25)
#   port  0.8:1 (2048x2560), vertical FOV 80 deg, so it covers any portrait or squarish window (aspect < 1.25)

import bpy, json, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(bpy.data.filepath))
ROOT = os.path.dirname(HERE)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = {argv[i].lstrip('-'): argv[i + 1] for i in range(0, len(argv) - 1, 2)}

cams = json.load(open(os.path.join(HERE, 'cameras.json')))
stops = opt.get('stops', ','.join(cams)).split(',')
variants = opt.get('variants', 'land,port').split(',')
scale = float(opt.get('scale', 1.0))
out_dir = os.path.join(ROOT, opt.get('out', 'assets/renders'))
os.makedirs(out_dir, exist_ok=True)

scene = bpy.context.scene
scene.cycles.samples = int(opt.get('samples', scene.cycles.samples))

# Metal GPU
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.get_devices()
for d in prefs.devices: d.use = d.type == 'METAL'
scene.cycles.device = 'GPU'

# Tune architectural lighting across the scene to match the reference Entry Hall photographic quality
WARM_WHITE = (1.0, 0.88, 0.74)  # 3000K clean warm white for recessed lights, pendants, globes
COZY_WHITE = (1.0, 0.82, 0.65)  # 2800K cozy warm white for bedside sconces

for o in bpy.data.objects:
    if o.type == 'LIGHT':
        l = o.data
        if 'Fire' in o.name:
            l.color = (1.0, 0.58, 0.25)
            l.energy = 12.0
            l.shadow_soft_size = 0.35
        elif 'Sun' in o.name:
            l.color = (1.0, 0.96, 0.90)
            l.energy = 4.8
            l.angle = 0.015
        elif 'Bedside' in o.name:
            l.color = COZY_WHITE
            l.energy = 7.5
            l.shadow_soft_size = 0.18
        elif 'Pendant' in o.name:
            l.color = WARM_WHITE
            l.energy = 36.0
            l.shadow_soft_size = 0.25
        elif 'Dining' in o.name:
            l.color = WARM_WHITE
            l.energy = 14.0
            l.shadow_soft_size = 0.20
        elif 'Globe' in o.name:
            l.color = WARM_WHITE
            l.energy = 12.0
            l.shadow_soft_size = 0.18
        elif 'Arc lamp' in o.name:
            l.color = WARM_WHITE
            l.energy = 18.0
            l.shadow_soft_size = 0.22
        elif 'Bath sconce' in o.name:
            l.color = WARM_WHITE
            l.energy = 8.0
            l.shadow_soft_size = 0.15
        elif 'Portal' in o.name:
            l.color = WARM_WHITE
            l.energy = 10.0
            l.shadow_soft_size = 0.18
        else:
            l.color = WARM_WHITE
            l.energy = min(l.energy, 14.0)
            l.shadow_soft_size = 0.20

# Per-stop exposure (stops of light), calibrated to match the Entry Hall benchmark
LOOK = {
    'aerial':   dict(ev=0.0, fstop=None),
    'exterior': dict(ev=0.05, fstop=None),
    'entry':    dict(ev=0.45, fstop=None),
    'living':   dict(ev=-0.08, fstop=None),
    'dining':   dict(ev=0.35, fstop=None),
    'kitchen':  dict(ev=0.35, fstop=None),
    'bedroom':  dict(ev=0.25, fstop=None),
    'bath':     dict(ev=0.35, fstop=None),
}
# sized for 2x screens: the page shows a landscape still ~1.11x the window height
LAND = dict(w=4608, h=1920)
PORT = dict(w=2048, h=2560, vfov=80.0)

cam = scene.camera
deps = bpy.context.evaluated_depsgraph_get()


def bl(v):
    return Vector((v[0], -v[2], v[1]))


for stop in stops:
    c = cams[stop]
    pos, d = bl(c['pos']), bl(c['dir']).normalized()
    cam.location = pos
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    look = LOOK.get(stop, dict(ev=0.0, fstop=None))
    scene.view_settings.exposure = look['ev']
    hit, loc, *_ = scene.ray_cast(deps, pos, d)
    cd = cam.data
    cd.clip_start = 0.05
    cd.clip_end = 2000
    cd.dof.use_dof = bool(look['fstop']) and hit
    if cd.dof.use_dof:
        cd.dof.focus_distance = (loc - pos).length
        cd.dof.aperture_fstop = look['fstop']
    for v in variants:
        if v == 'land':
            r = LAND
            vfov = 2 * math.atan(math.tan(math.radians(c['fov']) / 2) * 1.109)
        else:
            r = PORT
            vfov = math.radians(r['vfov'])
        cd.sensor_fit = 'VERTICAL'
        cd.angle_y = vfov
        scene.render.resolution_x = int(r['w'] * scale)
        scene.render.resolution_y = int(r['h'] * scale)
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = 'WEBP'
        scene.render.image_settings.quality = 90
        scene.render.filepath = os.path.join(out_dir, f'{stop}-{v}.webp')
        print('render', stop, v, scene.render.resolution_x, 'x', scene.render.resolution_y, flush=True)
        bpy.ops.render.render(write_still=True)
