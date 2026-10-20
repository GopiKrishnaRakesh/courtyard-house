// Dump the site's three.js scene (world-space meshes tagged with material names) and the camera
// pose at every stop, for blender/build.py and blender/render.py.
//
//   npm i playwright && node blender/export.mjs <out dir>
//
// Writes <out dir>/house.json, house.bin, leaf.png and cameras.json (copy that one into blender/).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = (process.argv[2] || '.').replace(/\/?$/, '/');
fs.mkdirSync(OUT, { recursive: true });
const srv = spawn('python3', ['-m', 'http.server', '8125'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('crash', () => console.log('page crashed'));
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:8125/?record', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
await page.evaluate(() => window.__ready);
await page.waitForTimeout(1500);

// Timeline times (in tl seconds) where the camera rests at each stop.
const STOPS = { aerial: 0.26, exterior: 0.6, entry: 0.97, living: 1.84, dining: 2.49, kitchen: 3.12, bedroom: 3.76, bath: 4.45 };
const cams = await page.evaluate((stops) => {
  const { THREE, camera, tl } = window.__three;
  const out = {};
  for (const [k, t] of Object.entries(stops)) {
    window.__seek(t / tl.duration(), 0, true);
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    out[k] = { progress: t / tl.duration(), pos: camera.position.toArray(), dir: d.toArray(), fov: camera.fov };
  }
  return out;
}, STOPS);
fs.writeFileSync(OUT + 'cameras.json', JSON.stringify(cams, null, 2));
console.log('cameras', Object.keys(cams).length);

const chunks = [];
await page.exposeFunction('__save', (c) => { chunks.push(c); });
const manifest = await page.evaluate(async () => {
  const { THREE, scene, house } = window.__three;
  window.__seek(0.12, 0, true); // roof on
  house.door.rotation.y = 1.5;
  house.roof.visible = true;
  scene.updateMatrixWorld(true);
  const matName = new Map();
  for (const [key, m] of Object.entries(house.builder.mats.cache)) {
    matName.set(m, 'H_' + key.split('|')[0]);
    if (key.startsWith('leaves|')) window.__leafPng = m.map.image.toDataURL('image/png');
  }
  const list = [];
  const parts = [];
  let off = 0;
  const nm = new THREE.Matrix3();
  scene.traverseVisible((o) => {
    if (!o.isMesh) return;
    let g = o.geometry;
    if (!g.attributes.position) return;
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    const n = pos.count;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
    const v = new THREE.Vector3();
    nm.getNormalMatrix(o.matrixWorld);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); P.set([v.x, v.y, v.z], i * 3);
      if (nor) { v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); N.set([v.x, v.y, v.z], i * 3); }
      if (uv) U.set([uv.getX(i), uv.getY(i)], i * 2);
    }
    let I;
    if (g.index) I = new Uint32Array(g.index.array);
    else { I = new Uint32Array(n); for (let i = 0; i < n; i++) I[i] = i; }
    const det = o.matrixWorld.determinant();
    if (det < 0) for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const mat = matName.get(m) || ('M_' + (m.name || 'unnamed'));
    list.push({ mat, nv: n, ni: I.length, off, uv: !!uv, nor: !!nor });
    for (const a of [P, N, U, I]) { parts.push(new Uint8Array(a.buffer)); off += a.byteLength; }
  });
  // stream out in 1 MB base64 chunks
  const all = new Uint8Array(off);
  let o2 = 0;
  for (const p of parts) { all.set(p, o2); o2 += p.length; }
  for (let i = 0; i < all.length; i += 1 << 20) {
    let s = '';
    const part = all.subarray(i, i + (1 << 20));
    for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
    await window.__save(btoa(s));
  }
  return list;
});
fs.writeFileSync(OUT + 'house.bin', Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64'))));
fs.writeFileSync(OUT + 'house.json', JSON.stringify(manifest));
const leaf = await page.evaluate(() => window.__leafPng);
fs.writeFileSync(OUT + 'leaf.png', Buffer.from(leaf.split(',')[1], 'base64'));
console.log('meshes', manifest.length, 'bytes', fs.statSync(OUT + 'house.bin').size);
console.log('mats', [...new Set(manifest.map((m) => m.mat))].join(' '));
await browser.close();
srv.kill();
