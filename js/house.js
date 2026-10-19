import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Plan coordinates in metres: x runs east, z runs south (down the sheet), y is up.
// The footprint is 32 x 26 m on wall centrelines.
export const WALL_H = 3.8;
const T_EXT = 0.4;
const T_INT = 0.2;

export const ROOMS = [
  { id: 'living',  name: 'Living room',     rect: [0, 0, 10, 18],   label: [4.6, 2.1] },
  { id: 'dining',  name: 'Dining',          rect: [10, 0, 20, 8],   label: [16.3, 6.95] },
  { id: 'kitchen', name: 'Kitchen',         rect: [20, 0, 32, 8],   label: [26, 7.0] },
  { id: 'court',   name: 'Courtyard',       rect: [10, 8, 22, 18],  label: [17.4, 9.25], open: true },
  { id: 'bedroom', name: 'Primary bedroom', rect: [22, 8, 32, 18],  label: [27, 15.4] },
  { id: 'library', name: 'Library',         rect: [0, 18, 12, 26],  label: [9.2, 19.4] },
  { id: 'entry',   name: 'Entry hall',      rect: [12, 18, 20, 26], label: [14.9, 20.4] },
  { id: 'bath',    name: 'Bath',            rect: [20, 18, 32, 26], label: [24.4, 21.4] },
];

// Where each room's material sweep starts (the door the camera comes through).
export const SWEEP_ORIGINS = {
  living: [5.0, 18.0], dining: [10, 4], kitchen: [20, 4], court: [16, 18.0],
  bedroom: [23.7, 8], library: [12, 22], entry: [16.0, 26.0], bath: [29, 18],
};

// ---------- geometry helpers ----------

// Write UVs in metres by projecting along the dominant normal axis.
function worldUV(g) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

class Builder {
  constructor(mats) {
    this.mats = mats;
    this.group = new THREE.Group();
    this.meshes = [];
    this.f = { x: 0, z: 0, r: 0 };
  }

  // Run fn with a local frame: origin (x, z), rotated r radians about Y.
  at(x, z, r, fn) {
    const prev = this.f;
    const c = Math.cos(prev.r), s = Math.sin(prev.r);
    this.f = { x: prev.x + x * c + z * s, z: prev.z - x * s + z * c, r: prev.r + r };
    fn();
    this.f = prev;
  }

  _place(g, lx, ly, lz, lr = 0) {
    g.rotateY(lr + this.f.r);
    const c = Math.cos(this.f.r), s = Math.sin(this.f.r);
    g.translate(this.f.x + lx * c + lz * s, ly, this.f.z - lx * s + lz * c);
  }

  add(g, mat, o = {}) {
    if (!o.keepUV) worldUV(g);
    const clip = o.clip === true ? 'cut' : (o.clip || null);
    const m = new THREE.Mesh(g, this.mats.get(mat, clip));
    m.castShadow = o.cast !== false;
    m.receiveShadow = true;
    m.userData.kind = o.kind ?? (clip ? 2 : 0);
    m.userData.clip = clip;
    m.userData.info = o.info !== false;
    (o.parent || this.group).add(m);
    this.meshes.push(m);
    return m;
  }

  // Axis-aligned box in world coordinates (ignores the local frame).
  box(x0, y0, z0, x1, y1, z1, mat, o) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return this.add(g, mat, o);
  }

  // Rounded box in the local frame; ly is the bottom.
  rb(lx, ly, lz, w, h, d, r, mat, o = {}) {
    const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
    const g = rr > 0.002 ? new RoundedBoxGeometry(w, h, d, 3, rr) : new THREE.BoxGeometry(w, h, d);
    this._place(g, lx, ly + h / 2, lz, o.rot || 0);
    return this.add(g, mat, o);
  }

  cy(lx, ly, lz, rTop, rBot, h, mat, o = {}) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, o.seg || 48);
    this._place(g, lx, ly + h / 2, lz);
    return this.add(g, mat, o);
  }

  geo(g, mat, o = {}) {
    this._place(g, o.x || 0, o.y || 0, o.z || 0, o.rot || 0);
    return this.add(g, mat, o);
  }
}

// ---------- walls ----------

const G = (a, b, sill = 0, head = WALL_H, pane = 1.5) => ({ a, b, sill, head, glass: true, pane });
const O = (a, b, head = 3.2) => ({ a, b, sill: 0, head });

function glazing(B, axis, fixed, o) {
  const fw = 0.04, fd = 0.08, gt = 0.016;
  const bar = (p, q, y0, y1) => (axis === 'x'
    ? B.box(p, y0, fixed - fd / 2, q, y1, fixed + fd / 2, 'steel', { clip: true, kind: 1 })
    : B.box(fixed - fd / 2, y0, p, fixed + fd / 2, y1, q, 'steel', { clip: true, kind: 1 }));
  const y0 = o.sill, y1 = o.head;
  bar(o.a, o.b, y0, y0 + fw);
  bar(o.a, o.b, y1 - fw, y1);
  const n = Math.max(1, Math.round((o.b - o.a) / o.pane));
  for (let i = 0; i <= n; i++) {
    const p = o.a + ((o.b - o.a) * i) / n;
    bar(Math.max(o.a, p - fw / 2), Math.min(o.b, p + fw / 2), y0 + fw, y1 - fw);
  }
  if (axis === 'x') B.box(o.a, y0, fixed - gt / 2, o.b, y1, fixed + gt / 2, 'glass', { info: false, cast: false });
  else B.box(fixed - gt / 2, y0, o.a, fixed + gt / 2, y1, o.b, 'glass', { info: false, cast: false });
}

// A straight wall along x (at z = fixed) or along z (at x = fixed), with openings.
function wall(B, from, to, fixed, axis, t, ops = []) {
  const ext = axis === 'x' ? t / 2 : 0;
  let s = from - ext;
  const e = to + ext;
  const seg = (p, q, y0, y1) => {
    if (q - p < 1e-3 || y1 - y0 < 1e-3) return;
    if (axis === 'x') B.box(p, y0, fixed - t / 2, q, y1, fixed + t / 2, 'plaster', { clip: true, kind: 1 });
    else B.box(fixed - t / 2, y0, p, fixed + t / 2, y1, q, 'plaster', { clip: true, kind: 1 });
  };
  for (const o of [...ops].sort((m, n) => m.a - n.a)) {
    seg(s, o.a, 0, WALL_H);
    if (o.sill > 0) seg(o.a, o.b, 0, o.sill);
    if (o.head < WALL_H) seg(o.a, o.b, o.head, WALL_H);
    if (o.glass) glazing(B, axis, fixed, o);
    s = o.b;
  }
  seg(s, e, 0, WALL_H);
}

function buildWalls(B) {
  // exterior
  wall(B, 0, 32, 0, 'x', T_EXT, [G(1.5, 8.5, 0, 3.4, 1.4), G(12, 18, 0, 3.4), G(22.5, 29.5, 1.05, 2.6, 1.4)]);
  wall(B, 0, 32, 26, 'x', T_EXT, [G(2, 8, 0.45, 3.2), O(15.1, 16.9, 3.4), G(26, 30, 1.8, 3.2, 1.33)]);
  wall(B, 0, 26, 0, 'z', T_EXT, [G(1.5, 16.5, 0, WALL_H, 2.5)]);
  wall(B, 0, 26, 32, 'z', T_EXT, [G(2, 6, 1.05, 2.6, 1.33), G(9, 17, 0, WALL_H, 2.67), G(20, 24, 1.8, 3.2, 1.33)]);
  // interior
  wall(B, 0, 18, 10, 'z', T_INT, [O(2, 6), G(8.1, 17.9, 0, WALL_H, 2.45)]);
  wall(B, 0, 8, 20, 'z', T_INT, [O(1, 7)]);
  wall(B, 10, 32, 8, 'x', T_INT, [G(10.1, 21.9, 0, WALL_H, 2.95), O(23, 24.4, 2.7)]);
  wall(B, 8, 18, 22, 'z', T_INT, [G(8.1, 17.9, 0, WALL_H, 2.45)]);
  wall(B, 0, 32, 18, 'x', T_INT, [O(3, 7), G(10.1, 19.9, 0, WALL_H, 2.45), O(28, 30, 3.0)]);
  wall(B, 18, 26, 12, 'z', T_INT, [O(20.5, 23.5)]);
  wall(B, 18, 26, 20, 'z', T_INT, []);

  // large-format limestone cladding on the entry block's street face
  for (const [x0, x1] of [[11.6, 14.75], [17.25, 20.4]]) {
    const n = Math.round((x1 - x0) / 1.05);
    for (let i = 0; i < n; i++) {
      const a = x0 + ((x1 - x0) * i) / n + 0.006, b = x0 + ((x1 - x0) * (i + 1)) / n - 0.006;
      for (let j = 0; j < 3; j++) B.box(a, j * (3.8 / 3) + 0.006, 26.2, b, (j + 1) * (3.8 / 3) - 0.006, 26.3, 'limestone', { clip: true, kind: 1 });
    }
  }
  // limestone portal around the front door
  B.box(14.75, 0, 26.2, 15.1, 3.75, 26.36, 'limestone', { clip: true, kind: 1 });
  B.box(16.9, 0, 26.2, 17.25, 3.75, 26.36, 'limestone', { clip: true, kind: 1 });
  B.box(15.1, 3.4, 26.2, 16.9, 3.75, 26.36, 'limestone', { clip: true, kind: 1 });
}

// ---------- floors, courtyard, site ----------

const FLOOR = { living: 'oak', dining: 'oak', kitchen: 'limestone', bedroom: 'oak', library: 'oak', entry: 'limestone', bath: 'limestone' };
export const POOL = [13.0, 10.6, 20.0, 17.0];

function buildGround(B) {
  for (const r of ROOMS) {
    if (r.open) continue;
    const [x0, z0, x1, z1] = r.rect;
    B.box(x0 === 0 ? -0.2 : x0, -0.4, z0 === 0 ? -0.2 : z0, x1 === 32 ? 32.2 : x1, 0, z1 === 26 ? 26.2 : z1, FLOOR[r.id], { cast: false });
  }
  // courtyard paving around the pool, one step down
  const [px0, pz0, px1, pz1] = POOL;
  const pv = (x0, z0, x1, z1) => B.box(x0, -0.4, z0, x1, -0.06, z1, 'paving', { cast: false });
  pv(10, 8, 22, pz0); pv(10, pz1, 22, 18); pv(10, pz0, px0, pz1); pv(px1, pz0, 22, pz1);
  B.box(px0, -0.6, pz0, px1, -0.17, pz1, 'water', { cast: false });
  // gravel bed under the olive tree
  B.box(10.35, -0.06, 8.35, 12.45, -0.035, 10.25, 'gravel', { cast: false });

  // lawn around the house (a frame, so the pool and floors are not covered)
  // shape y is world -z, so the sheet faces up after rotateX(-90deg)
  const R = 220;
  const lawn = new THREE.Shape([[-R, R], [R + 32, R], [R + 32, -R - 26], [-R, -R - 26]].map(([x, y]) => new THREE.Vector2(x, y)));
  lawn.holes.push(new THREE.Path([[-0.2, 0.2], [-0.2, -26.2], [32.2, -26.2], [32.2, 0.2]].map(([x, y]) => new THREE.Vector2(x, y))));
  const lg = new THREE.ShapeGeometry(lawn);
  lg.rotateX(-Math.PI / 2);
  lg.translate(0, -0.1, 0);
  B.add(lg, 'lawn', { cast: false });

  // front court: limestone forecourt and two long planted beds
  B.box(11.2, -0.12, 26.2, 20.8, 0, 42, 'paving', { cast: false });
  B.box(7.0, -0.1, 28.0, 11.0, 0.03, 40.5, 'gravel', { cast: false });
  B.box(21.0, -0.1, 28.0, 25.0, 0.03, 40.5, 'gravel', { cast: false });
}

function buildRoof(B, parent) {
  const y0 = WALL_H - 0.005, y1 = WALL_H + 0.42;
  const R = (x0, z0, x1, z1) => B.box(x0, y0, z0, x1, y1, z1, 'roof', { clip: 'roof', kind: 1, parent });
  R(-0.35, -0.35, 32.35, 8.1);
  R(-0.35, 8.1, 10.1, 17.9);
  R(21.9, 8.1, 32.35, 17.9);
  R(-0.35, 17.9, 15.4, 26.35);
  R(16.6, 17.9, 26.0, 26.35);
  R(29.2, 17.9, 32.35, 26.35);
  R(26.0, 17.9, 29.2, 22.6);
  R(26.0, 24.9, 29.2, 26.35);
  R(15.4, 17.9, 16.6, 19.5);
  R(15.4, 25.0, 16.6, 26.35);
  R(11.6, 26.35, 20.4, 29.0); // entrance canopy
  B.box(15.4, y1 - 0.03, 19.5, 16.6, y1 - 0.01, 25.0, 'glass', { info: false, cast: false, parent }); // skylight
  B.box(26.0, y1 - 0.03, 22.6, 29.2, y1 - 0.01, 24.9, 'glass', { info: false, cast: false, parent }); // bath skylight
}

// ---------- furniture ----------

// Deep boucle sofa: recessed plinth, rounded arms, loose seat and back cushions, a throw over one arm.
function sofa(B, x, z, rot, len, depth = 1.05, mat = 'boucle') {
  B.at(x, z, rot, () => {
    B.rb(0, 0, 0, len - 0.16, 0.07, depth - 0.16, 0.02, 'blackStone');
    B.rb(0, 0.07, 0, len, 0.3, depth, 0.1, mat);
    const arm = 0.24;
    for (const sx of [-1, 1]) B.rb(sx * (len / 2 - arm / 2), 0.07, 0, arm, 0.56, depth, 0.11, mat);
    B.rb(0, 0.3, -depth / 2 + 0.08, len - 0.02, 0.5, 0.16, 0.07, mat);
    const inner = len - 2 * arm;
    const n = Math.max(2, Math.round(inner / 1.0));
    const w = inner / n;
    for (let i = 0; i < n; i++) {
      const cx = -inner / 2 + w * (i + 0.5);
      B.rb(cx, 0.37, 0.1, w - 0.015, 0.17, depth - 0.34, 0.08, mat);
      B.rb(cx, 0.45, -depth / 2 + 0.3, w - 0.03, 0.4, 0.22, 0.1, mat, { rot: 0 });
    }
    B.rb(-inner / 2 + 0.32, 0.54, -depth / 2 + 0.47, 0.5, 0.44, 0.14, 0.06, 'linenWarm', { rot: 0.1 });
    B.rb(-inner / 2 + 0.72, 0.53, -depth / 2 + 0.47, 0.44, 0.38, 0.13, 0.06, 'rug', { rot: -0.05 });
    B.rb(inner / 2 - 0.34, 0.54, -depth / 2 + 0.47, 0.5, 0.44, 0.14, 0.06, 'linenWarm', { rot: -0.1 });
    // throw draped over the right arm
    B.rb(len / 2 - arm / 2, 0.625, 0.08, arm + 0.06, 0.025, 0.62, 0.01, 'linenWarm');
    B.rb(len / 2 + 0.02, 0.22, 0.08, 0.025, 0.42, 0.62, 0.01, 'linenWarm');
  });
}

// Table lamp: travertine base, glowing linen shade.
function tableLamp(B, x, y, z) {
  B.at(x, z, 0, () => {
    B.cy(0, y, 0, 0.06, 0.1, 0.3, 'travertine', { seg: 32 });
    B.cy(0, y + 0.3, 0, 0.012, 0.012, 0.1, 'brass', { seg: 8 });
    B.cy(0, y + 0.36, 0, 0.15, 0.19, 0.24, 'shade', { seg: 48, cast: false, clip: true, kind: 2 });
  });
}

// A short stack of books lying flat.
function bookStack(B, x, y, z, rot, n = 3) {
  const cols = ['book3', 'book6', 'book1', 'book4'];
  B.at(x, z, rot, () => {
    let h = y;
    for (let i = 0; i < n; i++) {
      const t = 0.03 + (i % 2) * 0.012;
      B.rb((i % 2) * 0.012, h, (i % 3) * 0.008, 0.3 - i * 0.025, t, 0.22 - i * 0.015, 0.004, cols[i % cols.length], { rot: (i - 1) * 0.06 });
      h += t;
    }
  });
}

// Fluted (reeded) oak: thin half-buried rods across a cabinet face.
function fluted(B, axis, fixed, a0, a1, y0, y1, pitch = 0.028) {
  const parts = [];
  const n = Math.floor((a1 - a0) / pitch);
  for (let i = 0; i < n; i++) {
    const g = new THREE.CylinderGeometry(pitch * 0.52, pitch * 0.52, y1 - y0, 8);
    const a = a0 + pitch * (i + 0.5);
    if (axis === 'x') g.translate(a, (y0 + y1) / 2, fixed); else g.translate(fixed, (y0 + y1) / 2, a);
    parts.push(g);
  }
  B.add(mergeGeometries(parts), 'oakVeneer');
}

// Open oak shelving against a wall, filled with books (merged per colour to keep draw calls low).
// axis 'z': runs along z with its back on x = x0; axis 'x': runs along x with its back on z = z0.
function shelving(B, x0, z0, x1, z1, h, axis, seed = 5) {
  let k = seed * 7907 + 3;
  const rnd = () => { k = (k * 16807) % 2147483647; return (k % 100000) / 100000; };
  const len = axis === 'z' ? z1 - z0 : x1 - x0;
  const dep = axis === 'z' ? x1 - x0 : z1 - z0;
  const carc = [];
  const books = { book1: [], book2: [], book3: [], book4: [], book5: [], book6: [] };
  const keys = Object.keys(books);
  const put = (a0, a1, y0, y1, d0, d1, list) => {
    const g = new THREE.BoxGeometry(a1 - a0, y1 - y0, d1 - d0);
    if (axis === 'z') { g.rotateY(Math.PI / 2); g.translate(x0 + (d0 + d1) / 2, (y0 + y1) / 2, z0 + (a0 + a1) / 2); }
    else g.translate(x0 + (a0 + a1) / 2, (y0 + y1) / 2, z0 + (d0 + d1) / 2);
    list.push(g);
  };
  put(0, len, 0, h, 0, 0.02, carc);
  const bays = Math.max(1, Math.round(len / 1.0));
  const bay = len / bays;
  for (let i = 0; i <= bays; i++) put(Math.max(0, i * bay - 0.015), Math.min(len, i * bay + 0.015), 0, h, 0, dep, carc);
  const levels = [];
  for (let y = 0.1; y < h - 0.2; y += 0.42) levels.push(y);
  for (const y of levels) put(0, len, y - 0.025, y, 0, dep, carc);
  put(0, len, h - 0.03, h, 0, dep, carc);
  for (let b = 0; b < bays; b++) {
    for (const y of levels) {
      let a = b * bay + 0.03;
      const end = (b + 1) * bay - 0.03;
      while (a < end - 0.04) {
        if (rnd() < 0.06) { a += 0.12 + rnd() * 0.15; continue; } // a gap, or an object would sit here
        const w = 0.022 + rnd() * 0.03;
        const bh = 0.2 + rnd() * 0.15;
        const d = 0.17 + rnd() * 0.06;
        put(a, Math.min(a + w, end), y, y + bh, 0.03, 0.03 + d, books[keys[Math.floor(rnd() * keys.length)]]);
        a += w + 0.002;
      }
    }
  }
  B.add(mergeGeometries(carc), 'oakVeneer', { clip: true, kind: 2 });
  for (const key of keys) if (books[key].length) B.add(mergeGeometries(books[key]), key, { clip: true, kind: 2 });
}

// Upholstered barrel-back chair on tapered oak legs.
function diningChair(B, x, z, rot) {
  B.at(x, z, rot, () => {
    for (const [lx, lz] of [[-0.19, -0.17], [0.19, -0.17], [-0.19, 0.19], [0.19, 0.19]]) B.cy(lx, 0, lz, 0.016, 0.024, 0.42, 'oakVeneer', { seg: 12 });
    B.rb(0, 0.4, 0.02, 0.5, 0.1, 0.48, 0.045, 'linen');
    for (let i = 0; i < 7; i++) {
      const a = Math.PI - 0.85 + (i * 1.7) / 6;
      B.rb(Math.sin(a) * 0.25, 0.5, Math.cos(a) * 0.25 + 0.04, 0.13, 0.34, 0.06, 0.025, 'linen', { rot: a });
    }
  });
}

// Sheer linen gathered at the end of a run of glass: a pleated vertical sheet.
function curtain(B, x, z0, z1, h = 3.7) {
  const w = z1 - z0;
  const g = new THREE.PlaneGeometry(w, h, Math.round(w * 40), 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 31.4) * 0.035);
  g.computeVertexNormals();
  g.rotateY(Math.PI / 2);
  B.geo(g, 'sheer', { x, y: h / 2 + 0.03, z: (z0 + z1) / 2, cast: false, clip: true, kind: 2 });
}

// Freestanding tub: an oval lathe shell with water inside.
function tub(B, x, z, rot) {
  const pts = [[0, 0.02], [0.3, 0.0], [0.42, 0.07], [0.47, 0.32], [0.49, 0.56], [0.5, 0.6], [0.47, 0.61], [0.44, 0.58], [0.42, 0.38], [0.35, 0.18], [0, 0.16]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  B.at(x, z, rot, () => {
    const g = new THREE.LatheGeometry(pts, 72);
    g.scale(1.85, 1, 0.92);
    B.geo(g, 'porcelain');
    const w = new THREE.CircleGeometry(0.43, 64).rotateX(-Math.PI / 2);
    w.scale(1.85, 1, 0.92);
    B.geo(w, 'water', { y: 0.45, cast: false });
  });
}

function rectTable(B, x, z, rot, w, d, top = 'oakVeneer', base = 'oakVeneer') {
  B.at(x, z, rot, () => {
    B.rb(0, 0.71, 0, w, 0.05, d, 0.012, top);
    B.rb(-w / 2 + 0.5, 0, 0, 0.12, 0.71, d - 0.3, 0.01, base);
    B.rb(w / 2 - 0.5, 0, 0, 0.12, 0.71, d - 0.3, 0.01, base);
  });
}

function roundTable(B, x, z, r, h, top, base) {
  B.at(x, z, 0, () => {
    B.cy(0, 0, 0, r * 0.42, r * 0.5, h - 0.06, base);
    B.cy(0, h - 0.06, 0, r, r, 0.06, top, { seg: 72 });
  });
}

function rug(B, x0, z0, x1, z1, mat = 'rug') {
  B.box(x0, 0, z0, x1, 0.014, z1, mat, { cast: false });
}

function pianoShape() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(1.5, 0);
  s.lineTo(1.5, 0.6);
  s.bezierCurveTo(1.5, 1.4, 1.1, 1.5, 0.95, 1.75);
  s.bezierCurveTo(0.8, 2.05, 0.75, 2.1, 0.45, 2.1);
  s.bezierCurveTo(0.12, 2.1, 0, 1.9, 0, 1.6);
  s.lineTo(0, 0);
  return s;
}

function piano(B, x, z, rot) {
  B.at(x, z, rot, () => {
    const g = new THREE.ExtrudeGeometry(pianoShape(), { depth: 0.3, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 32 });
    g.rotateX(Math.PI / 2);
    g.translate(-0.75, 0.98, -1.0);
    B.geo(g, 'lacquer');
    for (const [lx, lz] of [[-0.62, -0.85], [0.62, -0.85], [-0.3, 0.9]]) B.cy(lx, 0, lz, 0.05, 0.04, 0.68, 'lacquer');
    B.rb(0, 0.68, -1.05, 1.42, 0.12, 0.3, 0.01, 'lacquer');
    B.rb(0, 0, -1.65, 0.8, 0.48, 0.38, 0.02, 'lacquer');
  });
}

function bed(B, x, z, rot) {
  // local: headboard at -z, foot at +z
  B.at(x, z, rot, () => {
    B.rb(0, 0, 0.05, 2.1, 0.3, 2.25, 0.03, 'oakVeneer');
    B.rb(0, 0.3, 0.07, 2.0, 0.26, 2.1, 0.08, 'linen');
    B.rb(0, 0.56, 0.45, 2.04, 0.05, 1.45, 0.02, 'linenWarm');
    B.rb(-0.5, 0.56, -0.78, 0.8, 0.2, 0.42, 0.09, 'linen', { rot: 0.04 });
    B.rb(0.5, 0.56, -0.78, 0.8, 0.2, 0.42, 0.09, 'linen', { rot: -0.04 });
    B.rb(-0.42, 0.6, -0.5, 0.6, 0.16, 0.36, 0.07, 'linenWarm', { rot: 0.1 });
    B.rb(0.42, 0.6, -0.5, 0.6, 0.16, 0.36, 0.07, 'linenWarm', { rot: -0.1 });
    B.rb(0, 0.58, -0.38, 0.5, 0.14, 0.26, 0.06, 'rug');
    for (let i = 0; i < 9; i++) B.rb(-1.3 + 0.2889 * (i + 0.5), 0.02, -1.06, 0.28, 1.3, 0.15, 0.07, 'boucle');
    for (const sx of [-1.65, 1.65]) {
      B.rb(sx, 0, -0.78, 0.6, 0.5, 0.45, 0.02, 'oakVeneer');
      B.cy(sx, 0.5, -0.78, 0.06, 0.09, 0.32, 'travertine');
    }
    B.rb(0, 0, 1.55, 1.8, 0.46, 0.45, 0.04, 'linenWarm');
  });
}





// Tree: tube trunk and branches; canopy of leaf cards with normals bent outward
// from each cluster centre so the foliage shades like a volume.
function tree(B, x, z, s, seed = 1, leafScale = 1) {
  let k = seed * 7919 + 13;
  const rnd = () => { k = (k * 16807) % 2147483647; return (k % 100000) / 100000; };
  B.at(x, z, 0, () => {
    const trunk = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.14 * s, 0.7 * s, 0.05 * s),
      new THREE.Vector3(-0.1 * s, 1.4 * s, 0.12 * s), new THREE.Vector3(0.05 * s, 2.0 * s, -0.05 * s),
    ]);
    B.geo(new THREE.TubeGeometry(trunk, 24, 0.13 * s, 10, false), 'bark');
    const top = new THREE.Vector3(0.05 * s, 2.0 * s, -0.05 * s);
    const clusters = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rnd() * 0.8;
      const tip = new THREE.Vector3(Math.cos(a) * 1.15 * s, (2.6 + rnd() * 0.9) * s, Math.sin(a) * 1.15 * s);
      const c = new THREE.CatmullRomCurve3([top, top.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, 0.25 * s, 0)), tip]);
      B.geo(new THREE.TubeGeometry(c, 12, 0.05 * s, 8, false), 'bark');
      clusters.push({ c: tip, r: (0.85 + rnd() * 0.35) * s });
    }
    clusters.push({ c: new THREE.Vector3(0, 3.5 * s, 0), r: 1.0 * s });
    const cards = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
    const card = new THREE.PlaneGeometry(0.42 * leafScale, 0.42 * leafScale);
    for (const { c, r } of clusters) {
      for (let i = 0; i < 230; i++) {
        const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.4);
        const sq = Math.sqrt(1 - u * u);
        const p = new THREE.Vector3(sq * Math.cos(th) * r * rr, u * r * rr * 0.7, sq * Math.sin(th) * r * rr).add(c);
        e.set(rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2);
        q.setFromEuler(e);
        const k2 = 0.8 + rnd() * 0.5;
        m.compose(p, q, sc.set(k2, k2, k2));
        const g = card.clone().applyMatrix4(m);
        const n = p.clone().sub(c).add(new THREE.Vector3(0, 0.35 * r, 0)).normalize();
        const na = g.attributes.normal;
        for (let j = 0; j < na.count; j++) na.setXYZ(j, n.x, n.y, n.z);
        cards.push(g);
      }
    }
    B.geo(mergeGeometries(cards), 'leaves', { keepUV: true, kind: 3 });
  });
}

// Italian cypress: a narrow column of dark leaf cards around a short trunk.
function cypress(B, x, z, h, seed = 1) {
  let k = seed * 104729 + 7;
  const rnd = () => { k = (k * 16807) % 2147483647; return (k % 100000) / 100000; };
  B.at(x, z, 0, () => {
    B.cy(0, 0, 0, 0.08, 0.14, h * 0.25, 'bark', { seg: 8 });
    const cards = [];
    const card = new THREE.PlaneGeometry(0.5, 0.5);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
    const n = Math.round(h * 70);
    for (let i = 0; i < n; i++) {
      const t = rnd();
      const y = 0.15 * h + t * 0.85 * h;
      const prof = Math.sin(Math.min(1, (t + 0.08) / 1.0) * Math.PI) * (1 - 0.35 * t);
      const r = (0.25 + 0.55 * prof) * (h / 9) * Math.pow(rnd(), 0.35);
      const a = rnd() * Math.PI * 2;
      const p = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
      q.setFromEuler(e);
      m.compose(p, q, sc.setScalar(0.8 + rnd() * 0.5));
      const g = card.clone().applyMatrix4(m);
      const nn = new THREE.Vector3(p.x, 0.25, p.z).normalize();
      const na = g.attributes.normal;
      for (let j = 0; j < na.count; j++) na.setXYZ(j, nn.x, nn.y, nn.z);
      cards.push(g);
    }
    B.geo(mergeGeometries(cards), 'leavesDark', { keepUV: true, kind: 3 });
  });
}

function buildLandscape(B) {
  // cypress rows along the east and west edges of the garden, and a screen behind the house
  let s = 1;
  for (let z = -6; z <= 44; z += 3.6) {
    cypress(B, -45, z * 1.6 - 20, 8.5 + ((s * 37) % 7) * 0.35, s++);
    cypress(B, 39.5, z + 1.2, 8.5 + ((s * 53) % 7) * 0.35, s++);
  }
  for (let x = -2; x <= 34; x += 3.4) cypress(B, x, -12, 9.5 + ((s * 29) % 5) * 0.4, s++);
  // olive grove on the lawn either side of the approach
  const olives = [[-1.5, 36], [2.5, 44], [-3, 50], [30.5, 36.5], [34, 44], [29, 50.5], [4.5, 55], [27.5, 57]];
  olives.forEach(([x, z], i) => tree(B, x, z, 1.0 + (i % 3) * 0.12, 20 + i));
  // a distant tree line closes the view
  for (let i = 0; i < 26; i++) {
    const x = -70 + i * 6.5 + ((i * 13) % 5);
    cypress(B, x, -48 - ((i * 7) % 9), 10 + ((i * 11) % 6), 100 + i);
  }
}

function buildFurniture(B) {
  // ---- entry hall (x12-20, z18-26) ----
  roundTable(B, 17.25, 22.4, 0.85, 0.76, 'travertine', 'travertine');
  B.box(18.6, 0, 18.45, 19.25, 1.05, 19.1, 'blackStone', { clip: true, kind: 2 }); // plinth for the bust
  B.box(12.15, 0, 24.3, 12.6, 0.45, 25.75, 'oakVeneer'); // bench by the door
  B.box(19.82, 1.2, 20.6, 19.88, 2.9, 24.2, 'oakVeneer', { clip: true, kind: 2 }); // frame
  B.box(19.81, 1.25, 20.65, 19.82, 2.85, 24.15, 'rug', { clip: true, kind: 2, cast: false }); // canvas
  B.geo(new THREE.CircleGeometry(0.5, 64).rotateY(-Math.PI / 2), 'linenWarm', { x: 19.805, y: 2.05, z: 21.6, clip: true, kind: 2, cast: false });
  B.box(19.802, 1.45, 22.3, 19.81, 2.65, 23.4, 'blackStone', { clip: true, kind: 2, cast: false });
  B.box(19.8, 1.6, 21.0, 19.806, 1.62, 23.7, 'brass', { clip: true, kind: 2, cast: false });
  bookStack(B, 16.75, 0.76, 22.7, 0.5, 3);

  // ---- living room (x0-10, z0-18) ----
  rug(B, 1.6, 3.6, 8.6, 12.4);
  sofa(B, 4.6, 5.0, 0, 3.6);
  sofa(B, 4.6, 11.0, Math.PI, 3.6);
  roundTable(B, 4.6, 8.0, 0.75, 0.36, 'travertine', 'travertine');
  B.cy(1.5, 0, 8.0, 0.28, 0.28, 0.5, 'travertine');
  piano(B, 5.0, 15.0, Math.PI * 0.85);
  // side tables, books and a bowl on the coffee table
  B.cy(2.25, 0, 5.15, 0.24, 0.24, 0.5, 'travertine');
  B.cy(6.95, 0, 10.85, 0.24, 0.24, 0.5, 'travertine');
  tableLamp(B, 2.25, 0.5, 5.15);
  B.rb(4.25, 0.36, 7.95, 0.34, 0.05, 0.26, 0.004, 'linenWarm', { rot: 0.2 });
  B.rb(4.27, 0.41, 7.97, 0.3, 0.04, 0.22, 0.004, 'oakVeneer', { rot: 0.25 });

  // brass arc lamp reaching over the seating
  B.at(2.0, 12.1, 0, () => {
    B.cy(0, 0, 0, 0.2, 0.2, 0.035, 'blackStone');
    const arc = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(-0.05, 1.4, -0.2), new THREE.Vector3(0.3, 2.25, -1.2),
      new THREE.Vector3(1.1, 2.3, -2.4), new THREE.Vector3(1.6, 2.05, -3.0),
    ]);
    B.geo(new THREE.TubeGeometry(arc, 48, 0.014, 8, false), 'brass', { clip: true, kind: 2 });
    const shade = new THREE.SphereGeometry(0.24, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    B.geo(shade, 'brass', { x: 1.6, y: 1.9, z: -3.0, clip: true, kind: 2 });
    B.geo(new THREE.CircleGeometry(0.2, 32).rotateX(Math.PI / 2), 'lampGlow', { x: 1.6, y: 1.9, z: -3.0, clip: true, kind: 2, cast: false });
  });
  B.cy(9.0, 0, 3.4, 0.22, 0.22, 0.55, 'oakVeneer');

  // sheer curtains gathered at the ends of the big glass runs
  curtain(B, 0.38, 1.55, 2.45);
  curtain(B, 0.38, 15.55, 16.45);
  curtain(B, 31.62, 9.05, 9.85);
  curtain(B, 31.62, 16.15, 16.95);
  // recessed LED lines in the ceilings
  const led = (x0, z0, x1, z1) => B.box(x0, WALL_H - 0.02, z0, x1, WALL_H - 0.005, z1, 'ledGlow', { clip: true, kind: 2, cast: false });
  led(9.42, 0.6, 9.47, 17.4);
  led(10.6, 0.6, 10.65, 7.4);
  led(20.8, 0.55, 31.4, 0.6);
  led(22.6, 8.55, 31.4, 8.6);
  led(19.42, 18.6, 19.47, 25.4);
  led(22.6, 18.55, 26.4, 18.6);

  // ---- dining (x10-20, z0-8) ----
  rug(B, 11.6, 1.6, 18.4, 6.4);
  rectTable(B, 15, 4, 0, 4.2, 1.2);
  for (let i = 0; i < 4; i++) {
    const x = 13.35 + i * 1.1;
    diningChair(B, x, 3.0, 0);
    diningChair(B, x, 5.0, Math.PI);
  }
  diningChair(B, 12.45, 4, -Math.PI / 2);
  diningChair(B, 17.55, 4, Math.PI / 2);
  B.box(12.0, 0, 0.25, 18.0, 0.5, 0.75, 'oakVeneer'); // low sideboard under the glazing
  // a single brass line over the table, hung on two rods
  B.box(13.4, 1.95, 3.97, 16.6, 2.0, 4.03, 'brass', { clip: true, kind: 2 });
  B.box(13.45, 1.935, 3.98, 16.55, 1.95, 4.02, 'lampGlow', { clip: true, kind: 2, cast: false });
  for (const x of [13.7, 16.3]) B.cy(x, 2.0, 4.0, 0.004, 0.004, 1.8, 'brass', { clip: true, kind: 2, seg: 6 });

  // ---- kitchen (x20-32, z0-8) ----
  B.at(26.2, 4.6, 0, () => {
    B.rb(0, 0, 0, 4.4, 0.86, 1.2, 0.01, 'oakVeneer');
    B.rb(0, 0.86, 0, 4.6, 0.06, 1.3, 0.01, 'travertine');
  });
  for (let i = 0; i < 4; i++) B.at(24.6 + i * 1.07, 5.75, 0, () => {
    B.cy(0, 0, 0, 0.03, 0.03, 0.7, 'brass');
    B.cy(0, 0.7, 0, 0.21, 0.21, 0.06, 'linenWarm');
  });
  B.box(20.6, 0, 0.2, 31.8, 0.9, 0.85, 'oakVeneer');
  B.box(20.6, 0.9, 0.18, 31.8, 0.94, 0.88, 'travertine');
  B.box(31.15, 0, 0.85, 31.8, 2.7, 2.0, 'oakVeneer', { clip: true, kind: 2 });
  B.box(31.15, 0, 6.0, 31.8, 2.7, 7.8, 'oakVeneer', { clip: true, kind: 2 });
  B.box(31.15, 0, 2.0, 31.8, 0.9, 6.0, 'oakVeneer');
  B.box(31.1, 0.9, 2.0, 31.8, 0.94, 6.0, 'travertine');
  B.box(25.4, 0.94, 0.3, 26.9, 0.952, 0.8, 'lacquer'); // induction hob
  B.box(25.6, 0.92, 4.22, 26.5, 0.928, 4.72, 'blackStone'); // sink
  B.cy(26.05, 0.92, 4.15, 0.016, 0.02, 0.36, 'brass');
  B.box(26.035, 1.26, 4.15, 26.065, 1.285, 4.42, 'brass');
  fluted(B, 'x', 4.0, 24.0, 28.4, 0.04, 0.85);
  fluted(B, 'x', 5.2, 24.0, 28.4, 0.04, 0.85);
  fluted(B, 'z', 24.0, 4.0, 5.2, 0.04, 0.85);
  fluted(B, 'z', 28.4, 4.0, 5.2, 0.04, 0.85);
  // handleless door reveals on the back run and the tall units
  for (let x = 21.2; x < 31.6; x += 0.6) B.box(x - 0.003, 0.08, 0.849, x + 0.003, 0.88, 0.856, 'lacquer', { cast: false });
  B.box(20.6, 0.62, 0.849, 31.8, 0.626, 0.856, 'lacquer', { cast: false });
  for (const [z0, z1] of [[0.85, 2.0], [6.0, 7.8]]) {
    for (let z = z0 + 0.58; z < z1; z += 0.58) B.box(31.144, 0.08, z - 0.003, 31.151, 2.65, z + 0.003, 'lacquer', { cast: false, clip: true, kind: 2 });
  }

  // ---- primary bedroom (x22-32, z8-18) ----
  rug(B, 25.0, 8.6, 31.0, 13.8);
  bed(B, 28.0, 9.4, 0);
  bookStack(B, 26.25, 0.5, 8.75, 0.3, 2);
  bookStack(B, 29.8, 0.5, 8.75, -0.2, 3);
  B.box(26.6, 1.55, 8.1, 29.4, 3.05, 8.15, 'oakVeneer', { clip: true, kind: 2 }); // frame
  B.box(26.66, 1.61, 8.15, 29.34, 2.99, 8.17, 'rug', { clip: true, kind: 2, cast: false }); // canvas
  B.geo(new THREE.CircleGeometry(0.42, 64), 'blackStone', { x: 27.55, y: 2.36, z: 8.175, clip: true, kind: 2, cast: false });
  B.box(28.25, 1.85, 8.17, 28.95, 2.75, 8.18, 'travertine', { clip: true, kind: 2, cast: false });
  B.box(26.95, 1.86, 8.17, 28.95, 1.88, 8.185, 'brass', { clip: true, kind: 2, cast: false });
  // reading corner by the garden glass
  B.cy(30.55, 0, 15.25, 0.26, 0.26, 0.48, 'travertine');
  for (const x of [26.35, 29.65]) B.cy(x, 0.82, 8.62, 0.09, 0.09, 0.03, 'lampGlow', { cast: false });
  B.at(24.0, 15.6, 0, () => B.cy(0, 0, 0, 0.32, 0.32, 0.42, 'travertine'));

  // ---- bath (x20-32, z18-26) ----
  tub(B, 27.6, 23.9, 0);
  B.box(22.4, 0, 18.15, 26.6, 0.85, 18.75, 'oakVeneer');
  fluted(B, 'x', 18.75, 22.4, 26.6, 0.04, 0.84);
  for (let i = 0; i < 3; i++) B.rb(30.9, 0.45 + i * 0.07, 23.4, 0.45, 0.07, 0.32, 0.03, i === 1 ? 'linenWarm' : 'linen');
  B.box(22.35, 0.85, 18.12, 26.65, 0.9, 18.8, 'travertine');
  B.box(29.9, 0, 18.1, 30.0, 2.4, 21.0, 'glass', { info: false, cast: false });
  B.box(30.0, 0, 18.1, 31.8, 0.02, 21.0, 'blackStone', { cast: false });
  B.box(20.8, 0, 24.9, 21.3, 0.42, 25.6, 'porcelain');
  // limestone wall behind the tub, up to the window sill
  for (let i = 0; i < 6; i++) {
    const a = 24.6 + i * 1.2 + 0.004, b = 24.6 + (i + 1) * 1.2 - 0.004;
    for (const [y0, y1] of [[0.004, 0.896], [0.904, 1.796]]) B.box(a, y0, 25.72, Math.min(b, 31.79), y1, 25.8, 'limestone', { clip: true, kind: 1 });
  }
  // two basins, taps and a mirror over the vanity
  for (const x of [23.4, 25.6]) {
    B.cy(x, 0.9, 18.47, 0.2, 0.16, 0.13, 'porcelain', { seg: 48 });
    B.cy(x, 0.9, 18.2, 0.012, 0.014, 0.32, 'brass');
    B.box(x - 0.012, 1.2, 18.2, x + 0.012, 1.215, 18.4, 'brass');
  }
  B.box(22.6, 1.25, 18.1, 26.4, 2.55, 18.13, 'mirror', { clip: true, kind: 2, cast: false });
  // floor-standing tub filler, towel bench, stool
  B.cy(26.35, 0, 23.9, 0.018, 0.022, 0.95, 'brass');
  B.box(26.35, 0.93, 23.89, 26.62, 0.95, 23.91, 'brass');
  B.box(30.4, 0, 22.8, 31.6, 0.45, 25.2, 'oakVeneer');
  B.cy(29.4, 0, 24.8, 0.2, 0.2, 0.45, 'travertine');

  // ---- library (x0-12, z18-26) ----
  shelving(B, 0.2, 18.4, 0.6, 25.6, 3.2, 'z', 5);
  shelving(B, 0.65, 18.1, 2.85, 18.5, 3.2, 'x', 9);
  tableLamp(B, 6.95, 0.76, 20.95);
  rug(B, 2.4, 19.6, 9.6, 24.6);
  rectTable(B, 6.0, 21.2, 0, 2.4, 1.0, 'oakVeneer', 'blackStone');
  diningChair(B, 6.0, 22.1, Math.PI);
  sofa(B, 6.0, 25.0, Math.PI, 2.6, 0.95, 'linenWarm');

  // ---- courtyard ----
  for (const lz of [12.0, 14.6]) {
    B.at(21.05, lz, 0, () => {
      B.rb(0, 0, 0, 0.72, 0.3, 1.95, 0.03, 'oakVeneer');
      B.rb(0, 0.3, 0.15, 0.68, 0.08, 1.55, 0.04, 'linen');
      B.rb(0, 0.3, -0.72, 0.68, 0.36, 0.42, 0.05, 'linen', { rot: 0 });
    });
  }
  tree(B, 11.4, 9.3, 1.05, 7, 0.8);

  // ---- front court ----
  tree(B, 9.0, 31.5, 1.3, 3);
  tree(B, 23.0, 33.0, 1.2, 11);
}

// Models placed after loading (CC0, Poly Haven).
export const MODEL_PLACEMENTS = [
  { id: 'marble_bust_01', at: [18.92, 1.05, 18.78], height: 0.64, rot: -2.4, clip: true },
  { id: 'ceramic_vase_01', at: [17.05, 0.76, 22.25], height: 0.62 },
  { id: 'ceramic_vase_03', at: [17.6, 0.76, 22.75], height: 0.4 },
  { id: 'modern_ceiling_lamp_01', at: [17.25, 3.8, 22.4], height: 1.25, hang: true, clip: true },
  { id: 'potted_plant_02', at: [12.85, 0, 18.85], height: 1.6 },
  { id: 'potted_plant_02', at: [19.2, 0, 25.3], height: 1.4, rot: 1.2 },
  { id: 'modern_wooden_cabinet', at: [19.55, 0, 22.4], width: 2.4, rot: -Math.PI / 2 },
  { id: 'potted_plant_02', at: [0.9, 0, 17.0], height: 1.8, rot: 0.6 },
  { id: 'potted_plant_02', at: [9.1, 0, 0.9], height: 1.7, rot: 2.1 },
  { id: 'mid_century_lounge_chair', at: [7.75, 0, 7.0], height: 0.95, rot: -Math.PI / 2 - 0.25 },
  { id: 'mid_century_lounge_chair', at: [7.75, 0, 9.0], height: 0.95, rot: -Math.PI / 2 + 0.25 },
  { id: 'ceramic_vase_03', at: [14.3, 0.76, 3.95], height: 0.34 },
  { id: 'wooden_bowl_02', at: [4.95, 0.36, 8.2], height: 0.11 },
  { id: 'ceramic_vase_04', at: [4.15, 0.36, 8.4], height: 0.24 },
  { id: 'ceramic_vase_02', at: [6.95, 0.5, 10.85], height: 0.34 },
  { id: 'jug_01', at: [13.2, 0.5, 0.5], height: 0.3, rot: 0.5 },
  { id: 'wooden_bowl_02', at: [15.2, 0.5, 0.5], height: 0.1 },
  { id: 'brass_vase_03', at: [14.2, 0.5, 0.5], height: 0.36 },
  { id: 'wooden_bowl_02', at: [27.7, 0.92, 4.75], height: 0.12, rot: 1.0 },
  { id: 'jug_01', at: [22.2, 0.94, 0.5], height: 0.28, rot: -0.6 },
  { id: 'ceramic_vase_02', at: [30.3, 0.94, 0.5], height: 0.3 },
  { id: 'book_encyclopedia_set_01', at: [5.2, 0.76, 21.15], width: 0.5, rot: 0.2 },
  { id: 'ceramic_vase_04', at: [24.5, 0.9, 18.42], height: 0.2 },
  { id: 'potted_plant_02', at: [31.0, 0, 21.7], height: 1.5, rot: 1.1 },
  { id: 'potted_plant_02', at: [19.3, 0, 7.3], height: 1.6, rot: 0.3 },
  { id: 'potted_plant_02', at: [11.4, 0, 25.35], height: 1.5, rot: 2.2 },
  { id: 'ceramic_vase_01', at: [1.25, 0, 0.85], height: 0.95, rot: 0.7 },
  ...[25.0, 26.2, 27.4].map((x) => ({ id: 'modern_ceiling_lamp_01', at: [x, 3.8, 4.6], height: 1.6, hang: true, clip: true })),
  { id: 'potted_plant_02', at: [30.9, 0.94, 3.0], height: 0.7, rot: 0.8 },
  { id: 'potted_plant_02', at: [31.1, 0, 17.1], height: 1.7, rot: 2.6 },
  { id: 'ceramic_vase_03', at: [30.9, 0.45, 24.6], height: 0.32, rot: 0.4 },
  { id: 'potted_plant_02', at: [21.0, 0, 19.0], height: 1.3, rot: 1.9 },
  { id: 'ceramic_vase_01', at: [15.4, 0.76, 4.05], height: 0.46 },
  { id: 'ceramic_vase_01', at: [16.6, 0.5, 0.5], height: 0.7, rot: 1.0 },
  { id: 'mid_century_lounge_chair', at: [23.4, 0, 16.3], height: 0.95, rot: 2.5 },
  { id: 'mid_century_lounge_chair', at: [30.4, 0, 14.1], height: 0.95, rot: Math.PI / 2 + 0.35 },
  { id: 'mid_century_lounge_chair', at: [30.4, 0, 16.4], height: 0.95, rot: Math.PI / 2 - 0.35 },
  { id: 'mid_century_lounge_chair', at: [3.0, 0, 21.6], height: 0.95, rot: 0.6 },
  ...[29.3, 31.4, 33.5, 35.6, 37.7, 39.6].flatMap((z, i) => [
    { id: 'shrub_02', at: [8.2 + (i % 2) * 1.4, 0.03, z], height: 0.95, rot: i * 1.7 },
    { id: 'shrub_02', at: [22.3 + ((i + 1) % 2) * 1.4, 0.03, z], height: 0.95, rot: i * 2.3 },
  ]),
  { id: 'shrub_02', at: [12.0, -0.035, 10.0], height: 0.6, rot: 0.4 },
  { id: 'shrub_02', at: [10.8, -0.035, 8.8], height: 0.5, rot: 2.4 },
];

export function buildHouse(mats) {
  const B = new Builder(mats);
  buildWalls(B);
  buildGround(B);
  buildFurniture(B);
  buildLandscape(B);

  const roof = new THREE.Group();
  B.group.add(roof);
  buildRoof(B, roof);

  // pivot front door, 1.8 x 3.4 m white oak, pivot 0.45 m from the west jamb
  const door = new THREE.Group();
  door.position.set(15.45, 0, 26.0);
  B.group.add(door);
  const panel = new THREE.BoxGeometry(1.78, 3.36, 0.08);
  panel.translate(0.54, 1.7, 0);
  B.add(panel, 'oakVeneer', { parent: door, clip: true, kind: 1 });
  const pull = new THREE.CylinderGeometry(0.018, 0.018, 1.3, 16);
  pull.translate(1.25, 1.15, 0.09);
  B.add(pull, 'brass', { parent: door });

  // wall lights either side of the portal
  for (const x of [14.35, 17.65]) B.box(x - 0.06, 2.2, 26.2, x + 0.06, 2.55, 26.32, 'lampGlow', { cast: false });

  return { group: B.group, meshes: B.meshes, roof, door, builder: B };
}
