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
- `assets/` — textures, sky and models
- `.htaccess` — file types, compression and caching for Apache / LiteSpeed hosting

## Credits

All textures, the sky and the models are CC0: [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com).
