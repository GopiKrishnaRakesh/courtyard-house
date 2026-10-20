# My House — a courtyard house you scroll through

A scroll-driven landing page. It opens on an ink floor plan cut at 1.2 m, the walls rise out of the drawing, and the camera walks through the entry, library, living room, dining room, kitchen, bedroom and bath. Each room stays a line drawing until the camera reaches it, then the real materials sweep across it.

Plain files, no build step: three.js, GSAP ScrollTrigger and Lenis load from CDNs.

## Run locally

The page must be served over http (opening `index.html` as a file will not load the models and textures):

```bash
npx http-server -p 8124 -c-1
```

Then open http://localhost:8124.

## Structure

- `index.html`, `css/style.css` — page, captions, title block
- `js/house.js` — the building, furniture and landscape, in plan metres
- `js/materials.js` — PBR materials and the indoor light correction
- `js/pipeline.js` — drawing pass, beauty pass, AO, reflections, light shafts, bloom, final grade
- `js/main.js` — scroll timeline, camera path, sweeps, annotations
- `assets/` — textures, sky, models and the Cycles renders
- `blender/` — scene export, Blender build and render scripts
- `.htaccess` — file types, compression and caching for Apache / LiteSpeed hosting

## Cycles renders

When the camera comes to rest in a room, a path-traced Blender render of that exact view fades in over the live WebGL frame (`assets/renders/`). The Blender scene is built from the site's own geometry, so the two always match:

```bash
# 1. dump the three.js scene and the camera pose at every stop (needs Chrome)
cd blender && npm i playwright && cd ..
node blender/export.mjs /tmp/house-dump && cp /tmp/house-dump/cameras.json blender/
# 2. build blender/house.blend: Cycles materials from assets/tex, golden-hour sun, sky, interior lamps
blender -b -P blender/build.py -- /tmp/house-dump
# 3. render every stop, landscape (2880x1200) and portrait (1440x1800), to assets/renders/*.webp
blender -b blender/house.blend -P blender/render.py
```

`render.py` takes `--stops entry,living`, `--variants land`, `--scale 0.25` and `--samples 64` for quick look-dev passes. Re-run all three steps after changing `js/house.js` or the camera path in `js/main.js`.

## Credits

All textures, the sky and the models are CC0: [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com).
