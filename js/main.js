import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Materials, sharedUniforms, hookMaterial } from './materials.js';
import { buildHouse, ROOMS, SWEEP_ORIGINS, MODEL_PLACEMENTS, WALL_H } from './house.js';
import { Pipeline, NZ } from './pipeline.js';

const RECORD = new URLSearchParams(location.search).has('record');
const { lerp, smoothstep, degToRad } = THREE.MathUtils;

// ---------- renderer, scene, camera ----------

// Quality tiers. Phones get 1K textures, no decorative lamps and a lighter finishing pass;
// every tier then adapts its render resolution to keep the frame rate up.
const UA = navigator.userAgent;
const coarse = matchMedia('(pointer: coarse)').matches;
const isPhone = /iPhone|Android.+Mobile/.test(UA) || (coarse && Math.min(screen.width, screen.height) < 820);
const isTablet = !isPhone && (/iPad|Android/.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA)));
const TIER = RECORD ? 'high' : isPhone ? 'low' : isTablet ? 'mid' : 'high';
const Q = {
  high: { dprMax: 2, dprMin: 1, msaa: 4, shadow: 4096, ssr: true, shafts: true, taps: 12, dof: true, lamps: true, tex: 'assets/tex', aniso: 8, chroma: 0.0012 },
  mid: { dprMax: 1.5, dprMin: 0.85, msaa: 2, shadow: 2048, ssr: false, shafts: true, taps: 6, dof: false, lamps: true, tex: 'assets/tex1k', aniso: 4, chroma: 0.0008 },
  low: { dprMax: 1.25, dprMin: 0.7, msaa: 2, shadow: 2048, ssr: false, shafts: false, taps: 4, dof: false, lamps: false, tex: 'assets/tex1k', aniso: 4, chroma: 0 },
}[TIER];
document.documentElement.dataset.tier = TIER;

function unsupported() {
  document.querySelector('.loader__text').innerHTML = 'This 3D walk needs a browser with WebGL 2<br>(Safari 15 or later, Chrome, Edge or Firefox).';
  document.querySelector('.loader__line').style.display = 'none';
}

const canvas = document.getElementById('gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  unsupported();
  throw e;
}
if (!renderer.extensions.has('EXT_color_buffer_float')) {
  unsupported();
  throw new Error('Float render targets are not supported on this device');
}
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 1, 3000);

// The section cut: everything above it is removed. 1.2 m = plan drawing.
const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2);
// The roof is drawn in from the facade northwards as the camera comes down.
const roofPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -40);
const planes = { cut: [cutPlane], roof: [roofPlane] };

const manager = new THREE.LoadingManager();
const bar = document.getElementById('loader-bar');
manager.onProgress = (_url, done, total) => { bar.style.width = `${Math.round((done / total) * 100)}%`; };
manager.onError = (url) => console.warn('Could not load', url);
const loaded = new Promise((resolve) => { manager.onLoad = resolve; });

const mats = new Materials(manager, Math.min(renderer.capabilities.getMaxAnisotropy(), Q.aniso), Q.tex);
mats.setPlanes('cut', planes.cut);
mats.setPlanes('roof', planes.roof);

const house = buildHouse(mats);
scene.add(house.group);

const pipeline = new Pipeline(renderer, scene, camera, planes, { msaa: Q.msaa, ssr: Q.ssr, shafts: Q.shafts, taps: Q.taps });
pipeline.comp.uniforms.uChroma.value = Q.chroma;
for (const m of house.meshes) pipeline.register(m);

// ---------- light ----------

// golden hour: 24 degrees above the horizon, west-south-west
const SUN_DIR = new THREE.Vector3(-0.86, 0.41, 0.3).normalize();
const sun = new THREE.DirectionalLight('#ffd8ac', 6.4);
sun.target.position.set(16, 0, 18);
sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 70);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 160 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
pipeline.sun = sun;
scene.add(new THREE.HemisphereLight('#eef0e6', '#d8c3a6', 0.36));

const pendant = new THREE.PointLight('#ffc78c', 7, 9, 2);
pendant.position.set(17.25, 2.55, 22.4);
scene.add(pendant);
for (const x of [14.35, 17.65]) {
  const l = new THREE.PointLight('#ffc27a', 1.0, 4, 2);
  l.position.set(x, 2.35, 26.9);
  scene.add(l);
}

const arcLamp = new THREE.PointLight('#ffc98e', 3.5, 7, 2);
arcLamp.position.set(3.6, 1.75, 9.1);
scene.add(arcLamp);
for (const [x, y, z, i] of [[24.5, 2.6, 18.7, 2.0], [27.6, 2.4, 24.0, 1.4], [2.25, 0.98, 5.15, 1.3], [6.95, 1.24, 20.95, 1.1]]) {
  const l = new THREE.PointLight('#ffcf98', i, 5, 2);
  l.position.set(x, y, z);
  scene.add(l);
}
for (const x of [26.35, 29.65]) {
  const l = new THREE.PointLight('#ffc27e', 1.6, 4, 2);
  l.position.set(x, 1.0, 8.62);
  scene.add(l);
}
for (const x of [25.0, 26.2, 27.4]) {
  const l = new THREE.PointLight('#ffcf98', 2.2, 5, 2);
  l.position.set(x, 2.05, 4.6);
  scene.add(l);
}
for (const x of [14.0, 16.0]) {
  const l = new THREE.PointLight('#ffc98e', 3, 6, 2);
  l.position.set(x, 1.85, 4.0);
  scene.add(l);
}

scene.fog = new THREE.Fog('#dcd2c2', 120, 460);
let skyTex = null;
new RGBELoader(manager).load('assets/hdri/sky_2k.hdr', (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping;
  skyTex = t;
  // The directional light is the sun; take the sun out of the sky image so it only fills and reflects.
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(clampSun(t, 6)).texture;
  pm.dispose();
  scene.environmentIntensity = 0.32;
  scene.backgroundIntensity = 0.9;
});

function clampSun(tex, k) {
  const src = tex.image.data;
  const half = src instanceof Uint16Array;
  const get = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const put = half ? THREE.DataUtils.toHalfFloat : (v) => v;
  const n = src.length / 4;
  const samples = [];
  for (let i = 0; i < n; i += 37) samples.push(0.2126 * get(src[i * 4]) + 0.7152 * get(src[i * 4 + 1]) + 0.0722 * get(src[i * 4 + 2]));
  samples.sort((a, b) => a - b);
  const cap = samples[Math.floor(samples.length / 2)] * k;
  const out = new src.constructor(src.length);
  for (let i = 0; i < n; i++) {
    const r = get(src[i * 4]), g = get(src[i * 4 + 1]), b = get(src[i * 4 + 2]);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const f = l > cap ? cap / l : 1;
    out[i * 4] = put(r * f); out[i * 4 + 1] = put(g * f); out[i * 4 + 2] = put(b * f); out[i * 4 + 3] = src[i * 4 + 3];
  }
  const t2 = new THREE.DataTexture(out, tex.image.width, tex.image.height, THREE.RGBAFormat, tex.type);
  t2.mapping = THREE.EquirectangularReflectionMapping;
  t2.colorSpace = tex.colorSpace;
  t2.needsUpdate = true;
  return t2;
}

// ---------- CC0 models ----------

const gltfLoader = new GLTFLoader(manager);
const modelIds = [...new Set(MODEL_PLACEMENTS.map((p) => p.id))];
for (const id of modelIds) {
  gltfLoader.load(`assets/models/${id}/${id}_1k.gltf`, (gltf) => {
    gltf.scene.traverse((o) => {
      if (o.isMesh && !o.material.userData.hooked) { hookMaterial(o.material); o.material.userData.hooked = true; }
    });
    for (const p of MODEL_PLACEMENTS.filter((q) => q.id === id)) placeModel(gltf.scene.clone(true), p);
  });
}

function placeModel(obj, p) {
  obj.rotation.y = p.rot || 0;
  obj.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  obj.scale.setScalar(p.height ? p.height / size.y : p.width / Math.max(size.x, size.z));
  obj.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x += p.at[0] - c.x;
  obj.position.z += p.at[2] - c.z;
  obj.position.y += p.hang ? p.at[1] - box.max.y : p.at[1] - box.min.y;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (p.clip) {
      const m = o.material.clone();
      m.onBeforeCompile = o.material.onBeforeCompile;
      m.customProgramCacheKey = o.material.customProgramCacheKey;
      m.clippingPlanes = planes.cut;
      m.side = THREE.DoubleSide;
      o.material = m;
      o.userData.clip = 'cut';
      o.userData.kind = 2;
    }
    pipeline.register(o);
  });
  scene.add(obj);
}

// ---------- material sweeps (one zone per room) ----------

ROOMS.forEach((r, i) => {
  const [x0, z0, x1, z1] = r.rect;
  pipeline.zone.uZoneRect.value[i].set(x0, z0, x1, z1);
  const [ox, oz] = SWEEP_ORIGINS[r.id];
  const far = Math.max(...[[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => Math.hypot(x - ox, z - oz, WALL_H * 0.6)));
  pipeline.zone.uZoneSweep.value[i].set(ox, oz, far + 1.5, 0);
});
const zoneIndex = Object.fromEntries(ROOMS.map((r, i) => [r.id, i]));
pipeline.zone.uExtSweep.value.set(16.25, 37, 140, 0);
if (ROOMS.length > NZ) throw new Error('Too many sweep zones');

// ---------- scroll state ----------

const state = {
  labels: 1, cue: 1, aerial: 0, cut: 1.2, s: 0, d: 0, roof: 0, ext: 0, door: 0, entry: 0, court: 0, caption: 0,
  library: 0, living: 0, caption2: 0, dining: 0, caption3: 0, kitchen: 0, caption4: 0, bedroom: 0, caption5: 0, bath: 0, caption6: 0, fin: 0, end: 0,
};

const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
tl.to(state, { cue: 0, duration: 0.03 }, 0.0)
  .to(state, { labels: 0, duration: 0.07 }, 0.06)
  .to(state, { aerial: 1, duration: 0.2, ease: 'power2.inOut' }, 0.06)
  .to(state, { cut: 4.6, duration: 0.18, ease: 'power1.inOut' }, 0.12)
  .to(state, { d: () => KL[3], duration: 0.36, ease: 'sine.inOut' }, 0.26)
  .to(state, { roof: 1, duration: 0.12, ease: 'power1.inOut' }, 0.33)
  .to(state, { ext: 1, duration: 0.17, ease: 'power1.inOut' }, 0.44)
  .to(state, { door: 1, duration: 0.1, ease: 'power2.inOut' }, 0.615)
  .to(state, { entry: 1, duration: 0.16, ease: 'power1.inOut' }, 0.7)
  .to(state, { d: () => KL[7], duration: 0.29, ease: 'sine.inOut' }, 0.63)
  .to(state, { court: 1, duration: 0.18, ease: 'power1.inOut' }, 0.78)
  .to(state, { caption: 1, duration: 0.05 }, 0.9)
  // checkpoint 2: entry -> library -> living room
  .to(state, { caption: 0, duration: 0.04 }, 1.0)
  .to(state, { d: () => KL[13], duration: 0.76, ease: 'sine.inOut' }, 1.02)
  .to(state, { library: 1, duration: 0.22, ease: 'power1.inOut' }, 1.12)
  .to(state, { living: 1, duration: 0.24, ease: 'power1.inOut' }, 1.42)
  .to(state, { caption2: 1, duration: 0.05 }, 1.8)
  // checkpoint 3: living room -> dining
  .to(state, { caption2: 0, duration: 0.04 }, 1.85)
  .to(state, { d: () => KL[17], duration: 0.58, ease: 'sine.inOut' }, 1.87)
  .to(state, { dining: 1, duration: 0.24, ease: 'power1.inOut' }, 2.05)
  .to(state, { caption3: 1, duration: 0.05 }, 2.45)
  // checkpoint 4: dining -> kitchen
  .to(state, { caption3: 0, duration: 0.04 }, 2.5)
  .to(state, { d: () => KL[21], duration: 0.54, ease: 'sine.inOut' }, 2.52)
  .to(state, { kitchen: 1, duration: 0.24, ease: 'power1.inOut' }, 2.7)
  .to(state, { caption4: 1, duration: 0.05 }, 3.08)
  // checkpoint 5: kitchen -> primary bedroom
  .to(state, { caption4: 0, duration: 0.04 }, 3.13)
  .to(state, { d: () => KL[25], duration: 0.55, ease: 'sine.inOut' }, 3.15)
  .to(state, { bedroom: 1, duration: 0.26, ease: 'power1.inOut' }, 3.3)
  .to(state, { caption5: 1, duration: 0.05 }, 3.72)
  // checkpoint 6: bedroom -> bath
  .to(state, { caption5: 0, duration: 0.04 }, 3.77)
  .to(state, { d: () => KL[29], duration: 0.54, ease: 'sine.inOut' }, 3.79)
  .to(state, { bath: 1, duration: 0.24, ease: 'power1.inOut' }, 3.94)
  .to(state, { caption6: 1, duration: 0.05 }, 4.36)
  // finale: the ceiling opens, the camera rises and lands back on the plan, now in material
  .to(state, { caption6: 0, duration: 0.04 }, 4.48)
  .to(state, { roof: 0, duration: 0.08, ease: 'power1.inOut' }, 4.5)
  .to(state, { fin: 1, duration: 0.22, ease: 'power2.inOut' }, 4.54)
  .to(state, { cut: 1.2, duration: 0.18, ease: 'power1.inOut' }, 4.7)
  .to(state, { aerial: 0, duration: 0.22, ease: 'power2.inOut' }, 4.76)
  .to(state, { labels: 1, duration: 0.06 }, 4.92)
  .to(state, { end: 1, duration: 0.04 }, 4.98)
  .to({}, { duration: 0.06 }, 5.02);

// ---------- camera ----------

const AER = { D: 58, fov: 35, polar: degToRad(52), az: -0.35 };
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

function planFrame(aspect) {
  const wide = aspect > 1.2;
  return { H: Math.max(18.6, (wide ? 23 : 21) / aspect), tx: wide ? 17 : 14.6, tz: wide ? 9.6 : 9.4 };
}

function aerialPose(a, aspect, pos, tgt) {
  const pf = planFrame(aspect);
  const fov = Math.exp(lerp(Math.log(1.2), Math.log(AER.fov), a));
  const H = lerp(pf.H, AER.D * Math.tan(degToRad(AER.fov / 2)), a);
  const D = H / Math.tan(degToRad(fov / 2));
  const k = smoothstep(a, 0.12, 1);
  const polar = lerp(0.0004, AER.polar, k);
  const az = lerp(0, AER.az, k);
  tgt.set(lerp(pf.tx, 16, a), 0, lerp(pf.tz, 13, a));
  pos.set(tgt.x + D * Math.sin(polar) * Math.sin(az), D * Math.cos(polar), tgt.z + D * Math.sin(polar) * Math.cos(az));
  return fov;
}

const p0 = v3(), t0 = v3();
aerialPose(1, 1.6, p0, t0);
const posCurve = new THREE.CatmullRomCurve3([
  p0, v3(8, 16, 52), v3(16.35, 4.2, 41), v3(16.35, 1.65, 33.5), v3(16.4, 1.65, 28.4),
  v3(16.3, 1.65, 25.0), v3(15.0, 1.65, 23.0), v3(14.25, 1.62, 21.4),
  v3(13.4, 1.62, 22.1), v3(11.2, 1.62, 22.0), v3(8.3, 1.62, 20.2), v3(5.4, 1.62, 18.0),
  v3(7.7, 1.6, 15.4), v3(8.4, 1.6, 13.2),
  v3(9.0, 1.62, 10.2), v3(8.4, 1.62, 4.3), v3(10.7, 1.62, 4.2), v3(11.7, 1.6, 6.6),
  v3(15.0, 1.62, 6.75), v3(18.6, 1.62, 6.2), v3(20.8, 1.62, 6.5), v3(21.6, 1.6, 7.0),
  v3(23.4, 1.62, 6.9), v3(23.7, 1.62, 8.5), v3(25.0, 1.62, 12.4), v3(25.4, 1.58, 15.2),
  v3(27.4, 1.62, 16.4), v3(29.0, 1.62, 18.4), v3(27.0, 1.62, 20.4), v3(25.0, 1.5, 21.6),
], false, 'centripetal');
const tgtCurve = new THREE.CatmullRomCurve3([
  t0, v3(16, 1.2, 20), v3(16.35, 2.2, 26), v3(16.35, 2.1, 26), v3(16.3, 1.9, 20),
  v3(16.0, 1.7, 14), v3(17.2, 1.5, 11.8), v3(18.8, 1.45, 12.2),
  v3(8.0, 1.55, 22.2), v3(6.0, 1.5, 20.0), v3(5.4, 1.5, 15.0), v3(5.8, 1.45, 11.0),
  v3(3.6, 1.3, 7.0), v3(2.6, 1.15, 5.0),
  v3(8.9, 1.5, 2.0), v3(14.0, 1.45, 4.0), v3(16.0, 1.3, 3.4), v3(17.6, 1.1, 2.4),
  v3(20.5, 1.5, 5.5), v3(24.0, 1.45, 4.5), v3(27.0, 1.3, 3.5), v3(29.0, 1.1, 2.2),
  v3(23.7, 1.5, 12.0), v3(26.5, 1.45, 13.5), v3(29.0, 1.3, 12.5), v3(29.4, 1.05, 9.8),
  v3(29.0, 1.5, 20.0), v3(27.6, 1.4, 22.5), v3(27.6, 1.0, 24.0), v3(28.4, 0.75, 24.3),
], false, 'centripetal');
const KNOTS = 29;

// Arc length at each knot, so the camera moves at an even walking pace between stops.
const ARC_N = 4000;
const ARC = posCurve.getLengths(ARC_N);
const ARC_TOTAL = ARC[ARC_N];
const KL = Array.from({ length: KNOTS + 1 }, (_, i) => ARC[Math.round((i / KNOTS) * ARC_N)]);
function knotFromDist(d) {
  for (let i = 0; i < KNOTS; i++) if (d <= KL[i + 1]) return i + (d - KL[i]) / Math.max(1e-6, KL[i + 1] - KL[i]);
  return KNOTS;
}
const _t = v3();
function targetAt(d, out) {
  // average the authored look target over a short stretch of path so turns lead and settle softly
  out.set(0, 0, 0);
  for (let k = -2; k <= 2; k++) {
    const dd = Math.min(ARC_TOTAL, Math.max(0, d + k * 0.35));
    tgtCurve.getPoint(posCurve.getUtoTmapping(dd / ARC_TOTAL), _t);
    out.add(_t);
  }
  return out.multiplyScalar(0.2);
}
let simTime = 0;

// On a portrait screen a fixed vertical lens leaves almost no width; widen it to match 5:4.
function fitFov(v, aspect) {
  if (aspect >= 1.25) return v;
  const h = 2 * Math.atan(Math.tan(degToRad(v / 2)) * 1.25);
  return Math.min(78, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect)));
}

const camPos = v3(), camTgt = v3();
const endPos = v3(), endTgt = v3(), aerPos = v3(), aerTgt = v3();
function updateCamera(aspect) {
  let fov;
  if (state.fin > 0) {
    // rise from the last stop straight up and out, then settle back onto the plan
    posCurve.getPoint(1, endPos);
    targetAt(ARC_TOTAL, endTgt);
    const fovB = aerialPose(state.aerial, aspect, aerPos, aerTgt);
    const k = state.fin;
    camPos.lerpVectors(endPos, aerPos, k);
    camTgt.lerpVectors(endTgt, aerTgt, k);
    fov = Math.exp(lerp(Math.log(55), Math.log(fovB), k));
  } else if (state.d <= 0) {
    fov = aerialPose(state.aerial, aspect, camPos, camTgt);
  } else {
    posCurve.getPointAt(Math.min(1, state.d / ARC_TOTAL), camPos);
    targetAt(state.d, camTgt);
    fov = lerp(AER.fov, 55, smoothstep(state.s, 0, 2.2));
  }
  // a barely-there handheld drift once we are on foot
  const hh = smoothstep(state.s, 3.0, 4.0) * (1 - state.fin);
  if (hh > 0) {
    const t = simTime;
    camPos.x += hh * (0.006 * Math.sin(t * 0.53) + 0.003 * Math.sin(t * 1.31 + 2.0));
    camPos.y += hh * (0.005 * Math.sin(t * 0.71 + 1.0) + 0.002 * Math.sin(t * 1.7));
    camTgt.x += hh * 0.025 * Math.sin(t * 0.37);
    camTgt.y += hh * 0.014 * Math.sin(t * 0.45 + 2.0);
    camTgt.z += hh * 0.022 * Math.sin(t * 0.29 + 4.0);
  }
  const fitWeight = state.fin > 0 ? smoothstep(state.aerial, 0.5, 1) : (state.d > 0 ? 1 : smoothstep(state.aerial, 0.5, 1));
  camera.fov = lerp(fov, fitFov(fov, aspect), fitWeight);
  camera.aspect = aspect;
  camera.position.copy(camPos);
  camera.lookAt(camTgt);
  const dist = camPos.distanceTo(camTgt);
  camera.near = Math.max(0.05, dist - 120);
  camera.far = dist + 900;
  camera.updateProjectionMatrix();
  // haze starts beyond the house whether we stand inside it or look down from far above
  scene.fog.near = dist + 110;
  scene.fog.far = dist + 460;
}

// ---------- annotations anchored to the model ----------

const labelsEl = document.getElementById('labels');
const labelEls = ROOMS.map((r) => {
  const [x0, z0, x1, z1] = r.rect;
  const w = x1 - x0, d = z1 - z0;
  const el = document.createElement('div');
  el.className = 'room';
  el.innerHTML = `<div class="room__name">${r.name}</div><div class="room__dim">${w.toFixed(1)} &times; ${d.toFixed(1)} m &middot; ${Math.round(w * d)} m&sup2;</div>`;
  labelsEl.appendChild(el);
  return { el, p: v3(r.label[0], 0, r.label[1]) };
});

const SVGNS = 'http://www.w3.org/2000/svg';
const dimsEl = document.getElementById('dims');
// chains of points on a line outside the walls; vertical chains run down the west side
const DIM_CHAINS = [
  { pts: [0, 10, 20, 32], fixed: -2.0, axis: 'x' },
  { pts: [0, 32], fixed: -3.4, axis: 'x' },
  { pts: [0, 18, 26], fixed: -2.0, axis: 'z' },
  { pts: [0, 26], fixed: -3.4, axis: 'z' },
];
const dims = DIM_CHAINS.map((ch) => {
  const g = document.createElementNS(SVGNS, 'g');
  dimsEl.appendChild(g);
  const line = document.createElementNS(SVGNS, 'line');
  g.appendChild(line);
  const ticks = ch.pts.map(() => { const t = document.createElementNS(SVGNS, 'line'); g.appendChild(t); return t; });
  const texts = ch.pts.slice(1).map((p, i) => {
    const t = document.createElementNS(SVGNS, 'text');
    t.textContent = (p - ch.pts[i]).toFixed(2);
    t.setAttribute('text-anchor', 'middle');
    g.appendChild(t);
    return t;
  });
  return { ch, line, ticks, texts };
});

const tmp = v3();
function toScreen(p, w, h) {
  tmp.copy(p).project(camera);
  return [(tmp.x * 0.5 + 0.5) * w, (-tmp.y * 0.5 + 0.5) * h];
}

const annotEl = document.getElementById('annot');
const sheetEl = document.querySelector('.sheet');
const cueEl = document.querySelector('.cue');
const endEl = document.querySelector('.end');
const capEls = [['cap-entry', 'caption'], ['cap-living', 'caption2'], ['cap-dining', 'caption3'], ['cap-kitchen', 'caption4'], ['cap-bedroom', 'caption5'], ['cap-bath', 'caption6']].map(([id, k]) => [document.getElementById(id), k]);
const stopEls = [...document.querySelectorAll('.stops li')];

function updateOverlay(w, h) {
  const o = state.labels;
  annotEl.style.opacity = o;
  sheetEl.style.opacity = o;
  cueEl.style.opacity = state.cue;
  endEl.style.opacity = state.end;
  if (o > 0.001) {
    for (const { el, p } of labelEls) {
      const [x, y] = toScreen(p, w, h);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
    for (const d of dims) {
      const { pts, fixed, axis } = d.ch;
      const sp = pts.map((v) => toScreen(axis === 'x' ? v3(v, 0, fixed) : v3(fixed, 0, v), w, h));
      d.line.setAttribute('x1', sp[0][0]); d.line.setAttribute('y1', sp[0][1]);
      d.line.setAttribute('x2', sp[sp.length - 1][0]); d.line.setAttribute('y2', sp[sp.length - 1][1]);
      sp.forEach(([x, y], i) => {
        const t = d.ticks[i];
        t.setAttribute('x1', x - 4); t.setAttribute('y1', y + 4);
        t.setAttribute('x2', x + 4); t.setAttribute('y2', y - 4);
      });
      d.texts.forEach((t, i) => {
        const mx = (sp[i][0] + sp[i + 1][0]) / 2, my = (sp[i][1] + sp[i + 1][1]) / 2;
        if (axis === 'x') { t.setAttribute('x', mx); t.setAttribute('y', my - 6); t.removeAttribute('transform'); }
        else { t.setAttribute('x', mx - 6); t.setAttribute('y', my); t.setAttribute('transform', `rotate(-90 ${mx - 6} ${my})`); }
      });
    }
  }
  for (const [el, key] of capEls) {
    el.style.opacity = state[key];
    el.style.transform = `translateY(${(1 - state[key]) * 14}px)`;
  }
  document.body.classList.toggle('is-real', state.ext > 0.55 && state.fin < 0.6);
  const active = state.fin > 0.5 ? 'plan' : state.s >= 27.5 ? 'bath' : state.s >= 23.5 ? 'bedroom' : state.s >= 19.5 ? 'kitchen' : state.s >= 15.5 ? 'dining' : state.s >= 10.5 ? 'living' : state.s >= 4.6 ? 'entry' : 'plan';
  for (const li of stopEls) li.classList.toggle('is-active', li.dataset.stop === active);
}

// ---------- path-traced stills ----------

// Cycles renders of each stop (blender/render.py), from the pose the camera rests at while the
// room's caption is up. 'land' covers windows of aspect >= 1.25, 'port' everything narrower.
const STILLS = [['entry', 'caption'], ['living', 'caption2'], ['dining', 'caption3'], ['kitchen', 'caption4'], ['bedroom', 'caption5'], ['bath', 'caption6']];
const STILL_FRAMES = {
  land: { aspect: 2.4, tanHalf: Math.tan(degToRad(27.5)) * 1.109 },
  port: { aspect: 0.8, tanHalf: Math.tan(degToRad(40)) },
};
const stillEl = document.getElementById('still');
const stillImg = stillEl.querySelector('img');
const stillCache = {};
let stillKey = '', stillSince = 0;

function stillFrame(aspect) { return aspect >= 1.25 ? 'land' : 'port'; }

function preloadStills(variant) {
  for (const [id] of STILLS) {
    const src = `assets/renders/${id}-${variant}.webp`;
    if (stillCache[src]) continue;
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
    stillCache[src] = im;
  }
}

function updateStill(w, h, now) {
  if (RECORD) return;
  const variant = stillFrame(w / h);
  const hit = STILLS.find(([, k]) => state[k] > 0.5);
  const src = hit ? `assets/renders/${hit[0]}-${variant}.webp` : '';
  const im = stillCache[src];
  const ready = im && im.complete && im.naturalWidth > 0;
  if (src !== stillKey) { stillKey = src; stillSince = now; }
  // wait for the scroll to settle on the stop before fading the render in
  const on = ready && now - stillSince > 220;
  if (on) {
    if (stillImg.getAttribute('src') !== src) stillImg.src = src;
    // match the live camera: scale by the ratio of the render's vertical FOV to the screen's
    const f = STILL_FRAMES[variant];
    const hh = h * f.tanHalf / Math.tan(degToRad(camera.fov / 2));
    stillImg.style.height = `${hh}px`;
    stillImg.style.width = `${hh * f.aspect}px`;
  }
  stillEl.classList.toggle('is-on', on);
}

// ---------- frame ----------

let W = 0, H = 0;
let dprCur = Math.min(window.devicePixelRatio || 1, Q.dprMax);
let resizeAt = 0;
function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  renderer.setPixelRatio(dprCur);
  renderer.setSize(W, H, false);
  pipeline.setSize(W, H, dprCur);
}
window.addEventListener('resize', () => { resizeAt = performance.now(); });
resize();

// Width changes resize at once. Height-only changes (the iOS address bar sliding while you scroll)
// wait until the scroll settles, so render targets are not reallocated mid-gesture.
function checkSize(now) {
  const iw = window.innerWidth, ih = window.innerHeight;
  if (iw !== W || !H) return resize();
  if (ih !== H && (Math.abs(ih - H) > 160 || now - resizeAt > 300)) resize();
}

// Adaptive resolution: step down when frames run slow, back up when there is headroom.
let perfAcc = 0, perfN = 0, lastT = 0, good = 0;
function adapt(now) {
  if (lastT) { const dt = now - lastT; if (dt < 200) { perfAcc += dt; perfN++; } }
  lastT = now;
  if (perfN < 45) return;
  const avg = perfAcc / perfN;
  perfAcc = 0; perfN = 0;
  const ceiling = Math.min(window.devicePixelRatio || 1, Q.dprMax);
  if (avg > 24 && dprCur > Q.dprMin) { dprCur = Math.max(Q.dprMin, dprCur - 0.25); good = 0; resize(); }
  else if (avg < 17.5 && dprCur < ceiling) { if (++good >= 3) { dprCur = Math.min(ceiling, dprCur + 0.25); good = 0; resize(); } }
  else good = 0;
}

const clock = new THREE.Clock();
function frame(t) {
  // A hidden pane or background tab can report a 0-px window; a 0 aspect turns the camera,
  // and with it the section planes, into NaN. Wait until there is something to draw into.
  const now = performance.now();
  checkSize(now);
  if (!W || !H) return;
  if (!RECORD) adapt(now);
  simTime = t ?? clock.getElapsedTime();
  state.s = state.d > 0 ? knotFromDist(state.d) : 0;
  updateCamera(W / H);

  cutPlane.constant = state.cut >= 4.59 ? 100 : state.cut;
  // section poche and hatch exist only while something is actually cut (roof reveal counts)
  pipeline.zone.uCutOn.value = state.cut < 4.59 || (state.roof > 0.001 && state.roof < 0.999) ? 1 : 0;
  // roof reveal edge moves from the canopy (z = 29.5) to the north wall (z = -0.6)
  roofPlane.constant = -lerp(29.5, -0.6, state.roof);
  house.roof.visible = state.roof > 0.001;
  house.door.rotation.y = 1.5 * state.door;

  pipeline.zone.uExtSweep.value.w = state.ext;
  pipeline.zone.uZoneSweep.value[zoneIndex.entry].w = state.entry;
  pipeline.zone.uZoneSweep.value[zoneIndex.court].w = state.court;
  pipeline.zone.uZoneSweep.value[zoneIndex.library].w = state.library;
  pipeline.zone.uZoneSweep.value[zoneIndex.living].w = state.living;
  pipeline.zone.uZoneSweep.value[zoneIndex.dining].w = state.dining;
  pipeline.zone.uZoneSweep.value[zoneIndex.kitchen].w = state.kitchen;
  pipeline.zone.uZoneSweep.value[zoneIndex.bedroom].w = state.bedroom;
  pipeline.zone.uZoneSweep.value[zoneIndex.bath].w = state.bath;

  const u = pipeline.comp.uniforms;
  u.uSkyM.value = smoothstep(state.ext, 0.25, 0.9);
  u.uReal.value = smoothstep(state.ext, 0.3, 1.0);
  const inside = smoothstep(state.s, 4.2, 6.2);
  // the living room is full of sun; bring exposure back down as we enter it
  u.uExposure.value = lerp(lerp(lerp(0.95, 1.32, inside), 1.0, smoothstep(state.s, 10.5, 12.5)), 1.2, smoothstep(state.s, 14.5, 16.5));
  u.uExposure.value = lerp(u.uExposure.value, 1.32, smoothstep(state.s, 18.5, 20.5));
  u.uExposure.value = lerp(u.uExposure.value, 1.0, smoothstep(state.s, 22.5, 24.5));
  u.uExposure.value = lerp(u.uExposure.value, 1.3, smoothstep(state.s, 26.5, 28.5));
  u.uExposure.value = lerp(u.uExposure.value, 1.0, state.fin);
  // light in the air only reads indoors, where the beams have shadow around them
  u.uShaftAmp.value = Q.shafts ? 0.42 * inside * (1 - state.fin) : 0;
  // shallow depth of field on foot, focused where the camera is looking
  u.uFocus.value = camera.position.distanceTo(camTgt);
  u.uDof.value = Q.dof ? 0.3 * inside * (1 - state.fin) : 0;
  sharedUniforms.uIndoor.value = 0.5;

  const beauty = state.ext > 0 || state.entry > 0 || state.court > 0;
  pipeline.render({ beauty, background: beauty ? skyTex : null, time: simTime });
  updateOverlay(W, H);
  updateStill(W, H, now);
}

// ---------- start ----------

// Phones skip the decorative lamps; their glowing shades and bloom still read as lit.
if (!Q.lamps) {
  const lamps = [];
  scene.traverse((o) => { if (o.isPointLight) lamps.push(o); });
  lamps.forEach((l) => l.removeFromParent());
}

// Never hang on the loader: start after 30 s even if a model or texture is slow or missing.
const loadedOrTimeout = Promise.race([loaded, new Promise((r) => setTimeout(r, 30000))]);
const ready = Promise.all([loadedOrTimeout, document.fonts ? document.fonts.ready : Promise.resolve()]).then(() => {
  try { frame(); } catch (e) { console.error(e); }
  document.getElementById('loader').classList.add('is-done');
  if (!RECORD) {
    preloadStills(stillFrame(window.innerWidth / window.innerHeight));
    window.addEventListener('resize', () => preloadStills(stillFrame(window.innerWidth / window.innerHeight)));
  }
});

if (RECORD) {
  document.body.classList.add('is-record');
  // Deterministic capture: the recorder seeks the timeline directly.
  window.__ready = ready.then(() => true);
  // t: seconds of film time (drives grain and handheld drift); still: no motion blur from the previous frame
  window.__seek = (p, t = 0, still = false) => { tl.progress(p); if (still) pipeline.resetHistory(); frame(t); return true; };
  // Scene access for the Blender export and for reading the camera at each stop.
  window.__three = { THREE, scene, camera, house, state, tl };
} else {
  gsap.registerPlugin(ScrollTrigger);
  const lenis = new Lenis({ lerp: 0.085, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  ScrollTrigger.create({ trigger: '#scroll', start: 'top top', end: 'bottom bottom', scrub: 1, animation: tl });
  ready.then(() => gsap.ticker.add(() => frame()));
}
