# Render the site's camera stops from blender/house.blend with Cycles.
#
#   blender -b blender/house.blend -P blender/render.py -- [--stops entry,living] [--variants land,port]
#                                                          [--scale 1.0] [--samples 512] [--out assets/renders]
#
# Each stop is rendered from the exact pose the scroll camera rests at (blender/cameras.json, read
# from the live page), in two framings the page picks between:
#   land  2.4:1, vertical FOV widened 11% over the site's, so it covers any landscape window (aspect >= 1.25)
#   port  0.8:1, vertical FOV 80 deg, so it covers any portrait or squarish window (aspect < 1.25)

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

# Per-stop exposure (stops of light) and depth of field, tuned by eye.
LOOK = {
    'aerial':   dict(ev=0.0, fstop=None),
    'exterior': dict(ev=0.1, fstop=5.6),
    'entry':    dict(ev=0.7, fstop=4.0),
    'living':   dict(ev=0.4, fstop=4.0),
    'dining':   dict(ev=0.7, fstop=4.0),
    'kitchen':  dict(ev=0.7, fstop=4.0),
    'bedroom':  dict(ev=0.6, fstop=4.0),
    'bath':     dict(ev=0.8, fstop=4.0),
}
LAND = dict(w=2880, h=1200)
PORT = dict(w=1440, h=1800, vfov=80.0)

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
        scene.render.image_settings.quality = 86
        scene.render.filepath = os.path.join(out_dir, f'{stop}-{v}.webp')
        print('render', stop, v, scene.render.resolution_x, 'x', scene.render.resolution_y, flush=True)
        bpy.ops.render.render(write_still=True)
