import * as THREE from 'three';

// Passes per frame:
//   info    -> view normal (xy), linear depth, and per-pixel "how real" (0 = ink drawing, 1 = materials).
//              Back faces of cut solids come out as poche (-1) or hatch (-2).
//   beauty  -> lit, textured render (HDR, MSAA).
//   ao      -> screen-space ambient occlusion from the info buffer (half res, blurred).
//   bloom   -> bright pass, blurred at 1/4 and 1/10 res.
//   finish  -> paper + ink from the info buffer, blended into the graded beauty render.

export const NZ = 8;

const INFO_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vWorld;
varying vec3 vWorldN;
varying vec3 vViewN;
varying float vDepth;
#ifdef ALPHA_CUT
varying vec2 vUv;
#endif
void main() {
  #include <begin_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorld = wp.xyz;
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vViewN = normalize(normalMatrix * normal);
  vec4 mvPosition = viewMatrix * wp;
  vDepth = -mvPosition.z;
  #ifdef ALPHA_CUT
  vUv = uv;
  #endif
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const INFO_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec4 uZoneRect[${NZ}];
uniform vec4 uZoneSweep[${NZ}];
uniform vec4 uExtSweep;
uniform float uWallTop;
uniform float uKind;
uniform float uCutOn;
#ifdef ALPHA_CUT
uniform sampler2D uAlphaMap;
varying vec2 vUv;
#endif
varying vec3 vWorld;
varying vec3 vWorldN;
varying vec3 vViewN;
varying float vDepth;

// Radial sweep from the doorway: s = (originX, originZ, radius, progress)
float sweep(vec4 s, vec3 p) {
  float band = 1.6;
  float r = s.w * (s.z + band);
  float d = length(vec3(p.x - s.x, p.y * 0.6, p.z - s.y));
  return clamp((r - d) / band, 0.0, 1.0);
}

void main() {
  #include <clipping_planes_fragment>
  #ifdef ALPHA_CUT
  if (texture2D(uAlphaMap, vUv).a < 0.5) discard;
  #endif
  vec3 n = normalize(vWorldN);
  vec3 vn = normalize(vViewN);
  if (!gl_FrontFacing) { n = -n; vn = -vn; }
  // A surface belongs to the room it faces.
  vec3 q = vWorld + n * 0.25;
  vec4 s = uExtSweep;
  for (int i = 0; i < ${NZ}; i++) {
    vec4 r = uZoneRect[i];
    if (q.x > r.x && q.x < r.z && q.z > r.y && q.z < r.w && q.y > -1.5 && q.y < uWallTop) s = uZoneSweep[i];
  }
  float a = sweep(s, vWorld);
  if (uKind > 2.5) a += 2.0;
  else if (!gl_FrontFacing && uKind > 0.5 && uCutOn > 0.5) a = uKind < 1.5 ? -1.0 : -2.0;
  gl_FragColor = vec4(vn.xy, vDepth, a);
}`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const AO_FRAG = /* glsl */ `
uniform sampler2D tInfo;
uniform vec2 uTanHalf;
uniform vec2 uRes;
uniform float uRadius;
uniform vec3 uKernel[16];
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z); }
void main() {
  vec4 i = texture2D(tInfo, vUv);
  if (i.b <= 0.0 || i.a < 0.0 || i.a > 1.5) { gl_FragColor = vec4(1.0); return; }
  float z = i.b;
  vec3 n = vec3(i.xy, sqrt(max(0.0, 1.0 - dot(i.xy, i.xy))));
  vec3 p = viewPos(vUv, z);
  float a = hash(vUv * uRes) * 6.2831853;
  vec3 rv = vec3(cos(a), sin(a), 0.0);
  vec3 t = normalize(rv - n * dot(rv, n));
  mat3 tbn = mat3(t, cross(n, t), n);
  float rad = uRadius * (0.6 + 0.4 * clamp(z / 12.0, 0.0, 1.0));
  float occ = 0.0;
  for (int k = 0; k < 16; k++) {
    vec3 s = p + tbn * uKernel[k] * rad;
    float sz = -s.z;
    vec2 suv = (s.xy / (sz * uTanHalf)) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float d = texture2D(tInfo, suv).b;
    d = d <= 0.0 ? 1e5 : d;
    float range = smoothstep(0.0, 1.0, rad / abs(z - d));
    occ += (d < sz - 0.03 ? 1.0 : 0.0) * range;
  }
  gl_FragColor = vec4(vec3(1.0 - occ / 16.0), 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tSrc, vUv) * 0.2270270270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846153846) + texture2D(tSrc, vUv - uDir * 1.3846153846)) * 0.3162162162;
  c += (texture2D(tSrc, vUv + uDir * 3.2307692308) + texture2D(tSrc, vUv - uDir * 3.2307692308)) * 0.0702702703;
  gl_FragColor = c;
}`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * uExposure;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 2.0 + 0.5, l), 1.0);
}`;

// Light in the air: march each view ray through the sun's shadow map and count lit samples.
const SHAFT_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tInfo;
uniform sampler2D tShadow;
uniform mat4 uShadowMat;
uniform mat4 uCamWorld;
uniform vec2 uTanHalf;
uniform float uMaxDist;
uniform vec3 uSunDir;
varying vec2 vUv;
float sunAt(vec3 w) {
  vec4 sc = uShadowMat * vec4(w, 1.0);
  vec3 s = sc.xyz / sc.w;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return step(s.z - 0.0015, unpackRGBAToDepth(texture2D(tShadow, s.xy)));
}
void main() {
  float z = texture2D(tInfo, vUv).b;
  z = z <= 0.0 ? uMaxDist : min(z, uMaxDist);
  vec2 f = mod(gl_FragCoord.xy, 4.0);
  float j = mod(f.x * 4.0 + f.y * 9.0 + f.x * f.y, 16.0) / 16.0;
  float acc = 0.0;
  for (int i = 0; i < 24; i++) {
    float d = z * (float(i) + j) / 24.0;
    vec3 vp = vec3((vUv * 2.0 - 1.0) * uTanHalf * d, -d);
    acc += sunAt((uCamWorld * vec4(vp, 1.0)).xyz);
  }
  vec3 rd = normalize(mat3(uCamWorld) * vec3((vUv * 2.0 - 1.0) * uTanHalf, -1.0));
  float phase = 0.3 + 1.7 * pow(max(dot(rd, uSunDir), 0.0), 6.0);
  gl_FragColor = vec4(acc / 24.0 * z * phase, 0.0, 0.0, 1.0);
}`;

// Screen-space reflections for upward-facing real surfaces (floors, tabletops, the pool).
const SSR_FRAG = /* glsl */ `
uniform sampler2D tInfo;
uniform sampler2D tBeauty;
uniform vec2 uTanHalf;
uniform mat4 uCamWorld;
uniform float uStrength;
varying vec2 vUv;
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z); }
vec2 toUv(vec3 p) { return (p.xy / (-p.z * uTanHalf)) * 0.5 + 0.5; }
void main() {
  vec4 i = texture2D(tInfo, vUv);
  if (i.b <= 0.0 || i.a < 0.5 || i.a > 1.5) { gl_FragColor = vec4(0.0); return; }
  vec3 n = vec3(i.xy, sqrt(max(0.0, 1.0 - dot(i.xy, i.xy))));
  vec3 wn = mat3(uCamWorld) * n;
  if (wn.y < 0.6) { gl_FragColor = vec4(0.0); return; }
  vec3 p = viewPos(vUv, i.b);
  vec3 v = normalize(p);
  vec3 r = normalize(reflect(v, n));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-v, n), 0.0), 5.0);
  float stepLen = 0.05;
  vec3 q = p + n * 0.02;
  float hit = 0.0;
  vec2 huv = vec2(0.0);
  for (int k = 0; k < 40; k++) {
    q += r * stepLen;
    stepLen *= 1.09;
    if (q.z > -0.05) break;
    vec2 uv = toUv(q);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float d = texture2D(tInfo, uv).b;
    if (d <= 0.0) continue;
    float dz = -q.z - d;
    if (dz > 0.0 && dz < 0.3 + stepLen) {
      vec3 a = q - r * stepLen, b = q;
      for (int j = 0; j < 5; j++) {
        vec3 mid = (a + b) * 0.5;
        if (-mid.z > texture2D(tInfo, toUv(mid)).b) b = mid; else a = mid;
      }
      huv = toUv(b);
      q = b;
      hit = 1.0;
      break;
    }
  }
  if (hit < 0.5) { gl_FragColor = vec4(0.0); return; }
  vec2 e = smoothstep(0.0, 0.1, huv) * smoothstep(0.0, 0.1, 1.0 - huv);
  float fade = (1.0 - smoothstep(3.0, 9.0, length(q - p))) * e.x * e.y;
  gl_FragColor = vec4(texture2D(tBeauty, huv).rgb, fres * fade * uStrength);
}`;

const FINISH_FRAG = /* glsl */ `
uniform sampler2D tBeauty;
uniform sampler2D tInfo;
uniform sampler2D tAO;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform sampler2D tShaft;
uniform sampler2D tSSR;
uniform float uSSR;
uniform mat4 uCamWorld;
uniform mat4 uPrevVP;
uniform vec2 uTanHalf;
uniform float uShutter;
uniform float uTaps;
uniform float uFocus;
uniform float uDof;
uniform float uShafts;
uniform float uShaftAmp;
uniform vec3 uShaftCol;
uniform vec2 uRes;
uniform float uPx;
uniform float uSkyM;
uniform float uTime;
uniform float uReal;
uniform float uExposure;
uniform float uAO;
uniform float uBloom;
uniform float uHalation;
uniform float uWarmth;
uniform float uSat;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uChroma;
uniform float uGrain;
uniform float uVignette;
varying vec2 vUv;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
vec4 I(vec2 o) { return texture2D(tInfo, vUv + o / uRes); }
float inv(float z) { return z > 0.0 ? 1.0 / z : 0.0; }
float cls(float a) { return a > 1.5 ? 3.0 : (a < -1.5 ? 2.0 : (a < -0.5 ? 1.0 : 0.0)); }
vec3 nrm(vec4 t) { return vec3(t.xy, sqrt(max(0.0, 1.0 - dot(t.xy, t.xy)))); }

// Ink strength at this pixel from depth, crease and poche boundaries.
float inkEdge(vec4 c, float px) {
  vec2 dx = vec2(px, 0.0), dy = vec2(0.0, px);
  vec4 l = I(-dx), r = I(dx), u = I(dy), d = I(-dy);
  float dc = c.b;
  float cc = cls(c.a);
  // foliage only gets its silhouette
  if (cc > 2.5) {
    if (l.b <= 0.0 || r.b <= 0.0 || u.b <= 0.0 || d.b <= 0.0) return 1.0;
    return (cls(r.a) != cc || cls(u.a) != cc || cls(l.a) != cc || cls(d.a) != cc) ? 1.0 : 0.0;
  }
  // second difference of 1/z is zero on any plane; scale back to metres; near side only
  float ic = inv(dc);
  float lx = max(0.0, 2.0 * ic - inv(l.b) - inv(r.b));
  float ly = max(0.0, 2.0 * ic - inv(u.b) - inv(d.b));
  float e = smoothstep(0.02, 0.06, max(lx, ly) * dc * dc);
  if (l.b <= 0.0 || r.b <= 0.0 || u.b <= 0.0 || d.b <= 0.0) e = 1.0;
  if (cc < 0.5 && cls(r.a) < 0.5 && cls(u.a) < 0.5) {
    vec3 nc = nrm(c);
    float k = min(r.b > 0.0 ? dot(nc, nrm(r)) : 1.0, u.b > 0.0 ? dot(nc, nrm(u)) : 1.0);
    e = max(e, smoothstep(0.1, 0.28, 1.0 - k));
  }
  if (cc != cls(r.a) || cc != cls(u.a)) e = 1.0;
  return e;
}

void main() {
  vec4 c = I(vec2(0.0));
  float geo = step(1e-5, c.b);

  // ---- drawing ----
  vec2 px = vUv * uRes;
  float fibre = vnoise(px * vec2(0.15, 0.55) / uPx) * 0.5 + vnoise(px * 0.012 / uPx) * 0.5;
  vec3 paper = vec3(0.949, 0.937, 0.905) * (1.0 - (fibre - 0.5) * 0.05);
  vec3 ink = vec3(0.11, 0.105, 0.1);
  vec3 draw = paper;
  float edge = 0.0;
  if (geo > 0.0) {
    if (c.a > 1.5) {
      draw = mix(paper, ink, 0.07 + 0.05 * vnoise(px * 0.35 / uPx));
    } else if (c.a < -1.5) {
      float h = step(0.6, fract((gl_FragCoord.x + gl_FragCoord.y) / (5.0 * uPx)));
      draw = mix(paper, ink, 0.08 + 0.62 * h);
    } else if (c.a < -0.5) {
      draw = ink;
    } else {
      draw = paper * (0.955 + 0.045 * dot(nrm(c), normalize(vec3(-0.35, 0.55, 0.75))));
    }
    // two offsets give a slightly heavier, anti-aliased line
    edge = max(inkEdge(c, uPx), 0.55 * inkEdge(c, uPx * 1.8));
  }
  draw += (hash(floor(px / uPx)) - 0.5) * 0.012;

  // ---- materials ----
  float m = geo > 0.0 ? (c.a > 1.5 ? c.a - 2.0 : max(c.a, 0.0)) : uSkyM;
  vec3 col = draw;
  if (m > 0.0) {
    // camera motion blur (reprojected against last frame) and depth of field share one 12-tap gather
    float zc = c.b > 0.0 ? c.b : 400.0;
    vec4 wp = uCamWorld * vec4((vUv * 2.0 - 1.0) * uTanHalf * zc, -zc, 1.0);
    vec4 pc = uPrevVP * wp;
    vec2 vel = (vUv - (pc.xy / pc.w * 0.5 + 0.5)) * uShutter;
    float vl = length(vel);
    if (vl > 0.035) vel *= 0.035 / vl;
    float coc = clamp(abs(zc - uFocus) / max(zc, 0.1) * uDof, 0.0, 1.0) * (7.0 / uRes.y) * uPx;
    vec3 hdr = vec3(0.0);
    for (int k = 0; k < 12; k++) {
      if (float(k) >= uTaps) break;
      float fk = float(k) + 0.5;
      float a = fk * 2.39996;
      vec2 o = vec2(cos(a), sin(a)) * sqrt(fk / uTaps) * coc * vec2(uRes.y / uRes.x, 1.0);
      vec2 uv = vUv + o + vel * (fk / uTaps - 0.5);
      vec2 cd = (uv - 0.5) * uChroma;
      hdr += vec3(texture2D(tBeauty, uv + cd).r, texture2D(tBeauty, uv).g, texture2D(tBeauty, uv - cd).b);
    }
    hdr /= uTaps;
    vec4 sr = texture2D(tSSR, vUv);
    hdr = mix(hdr, sr.rgb, clamp(sr.a * uSSR, 0.0, 1.0));
    float aoFar = 1.0 - smoothstep(60.0, 160.0, c.b);
    hdr *= mix(1.0, texture2D(tAO, vUv).r, uAO * aoFar * geo);
    vec3 bl = texture2D(tBloom1, vUv).rgb * 0.6 + texture2D(tBloom2, vUv).rgb * 0.8;
    hdr += bl * uBloom + bl * vec3(1.0, 0.3, 0.12) * uHalation;
    hdr += uShaftCol * (1.0 - exp(-texture2D(tShaft, vUv).r * uShafts)) * uShaftAmp;
    vec3 g = aces(hdr * uExposure);
    g = pow(g, vec3(1.0 / 2.2));
    g.r *= 1.0 + uWarmth * 0.08;
    g.b *= 1.0 - uWarmth * 0.1;
    g = mix(vec3(lum(g)), g, uSat);
    // split tone: cool shadows, warm highlights
    g *= mix(vec3(0.965, 0.995, 1.05), vec3(1.035, 1.0, 0.955), smoothstep(0.15, 0.85, lum(g)));
    g = (g - 0.5) * uContrast + 0.5;
    g = uLift + g * (uGain - uLift);
    vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
    g *= mix(1.0, smoothstep(1.15, 0.2, length(q)), uVignette * uReal);
    g += (hash(px + fract(uTime * 13.0) * 431.0) - 0.5) * uGrain;
    col = mix(draw, g, m);
  }
  col = mix(col, ink, edge * (1.0 - m) * 0.92);
  // a faint warm line where the drawing turns into material
  col += vec3(1.0, 0.72, 0.42) * m * (1.0 - m) * 4.0 * 0.14 * geo;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function aoKernel() {
  const out = [];
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s % 100000) / 100000; };
  for (let i = 0; i < 16; i++) {
    const v = new THREE.Vector3(2 * rnd() - 1, 2 * rnd() - 1, 0.9 * rnd() + 0.1).normalize();
    let a = i / 16;
    a = 0.12 + 0.88 * a * a;
    out.push(v.multiplyScalar(a * (0.5 + 0.5 * rnd())));
  }
  return out;
}

export class Pipeline {
  constructor(renderer, scene, camera, planes, opts = {}) {
    this.opts = { msaa: 4, ssr: true, shafts: true, taps: 12, ...opts };
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.planes = planes; // { cut: [Plane], roof: [Plane] }
    this.items = [];

    this.zone = {
      uZoneRect: { value: Array.from({ length: NZ }, () => new THREE.Vector4(-1e3, -1e3, -1e3, -1e3)) },
      uZoneSweep: { value: Array.from({ length: NZ }, () => new THREE.Vector4()) },
      uExtSweep: { value: new THREE.Vector4() },
      uWallTop: { value: 3.8 },
      uCutOn: { value: 1 },
    };
    this.infoCache = {};

    const lin = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.beautyRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.opts.msaa });
    this.infoRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });
    this.aoRT = [new THREE.WebGLRenderTarget(1, 1, lin), new THREE.WebGLRenderTarget(1, 1, lin)];
    this.b1RT = [new THREE.WebGLRenderTarget(1, 1, lin), new THREE.WebGLRenderTarget(1, 1, lin)];
    this.b2RT = [new THREE.WebGLRenderTarget(1, 1, lin), new THREE.WebGLRenderTarget(1, 1, lin)];
    this.shRT = [new THREE.WebGLRenderTarget(1, 1, lin), new THREE.WebGLRenderTarget(1, 1, lin)];
    this.ssrRT = [new THREE.WebGLRenderTarget(1, 1, lin), new THREE.WebGLRenderTarget(1, 1, lin)];
    this.prevVP = new THREE.Matrix4();
    this.curVP = new THREE.Matrix4();
    this.hasHistory = false;
    this.sun = null;

    const quadMat = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.mAO = quadMat(AO_FRAG, {
      tInfo: { value: this.infoRT.texture }, uTanHalf: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() },
      uRadius: { value: 0.95 }, uKernel: { value: aoKernel() },
    });
    this.mShaft = quadMat(SHAFT_FRAG, {
      tInfo: { value: this.infoRT.texture }, tShadow: { value: null }, uShadowMat: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() }, uTanHalf: { value: new THREE.Vector2() }, uMaxDist: { value: 14 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    });
    this.mSSR = quadMat(SSR_FRAG, {
      tInfo: { value: this.infoRT.texture }, tBeauty: { value: this.beautyRT.texture },
      uTanHalf: { value: new THREE.Vector2() }, uCamWorld: { value: new THREE.Matrix4() }, uStrength: { value: 1.0 },
    });
    this.mBlur = quadMat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.mBright = quadMat(BRIGHT_FRAG, { tSrc: { value: this.beautyRT.texture }, uThreshold: { value: 1.1 }, uExposure: { value: 1 } });
    this.comp = quadMat(FINISH_FRAG, {
      tBeauty: { value: this.beautyRT.texture },
      tInfo: { value: this.infoRT.texture },
      tAO: { value: this.aoRT[0].texture },
      tBloom1: { value: this.b1RT[0].texture },
      tBloom2: { value: this.b2RT[0].texture },
      tShaft: { value: this.shRT[0].texture },
      tSSR: { value: this.ssrRT[0].texture },
      uSSR: { value: this.opts.ssr ? 0.55 : 0.0 },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uTanHalf: { value: new THREE.Vector2() },
      uShutter: { value: 0.5 },
      uTaps: { value: this.opts.taps },
      uFocus: { value: 5.0 },
      uDof: { value: 0.0 },
      uShafts: { value: 0.03 },
      uShaftAmp: { value: 0.0 },
      uShaftCol: { value: new THREE.Color('#ffd9a8') },
      uRes: { value: new THREE.Vector2(1, 1) },
      uPx: { value: 1 },
      uSkyM: { value: 0 },
      uTime: { value: 0 },
      uReal: { value: 0 },
      uExposure: { value: 1 },
      uAO: { value: 1.0 },
      uBloom: { value: 0.16 },
      uHalation: { value: 0.04 },
      uWarmth: { value: 0.06 },
      uSat: { value: 1.03 },
      uContrast: { value: 1.1 },
      uLift: { value: new THREE.Vector3(0.006, 0.006, 0.01) },
      uGain: { value: new THREE.Vector3(1.0, 1.0, 0.985) },
      uChroma: { value: 0.0012 },
      uGrain: { value: 0.022 },
      uVignette: { value: 0.32 },
    });
    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.comp);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  infoMaterial(kind, clip, alphaMap) {
    const key = `${kind}|${clip}|${alphaMap ? alphaMap.uuid : ''}`;
    if (!this.infoCache[key]) {
      const m = new THREE.ShaderMaterial({
        vertexShader: INFO_VERT,
        fragmentShader: INFO_FRAG,
        uniforms: { ...this.zone, uKind: { value: kind }, uAlphaMap: { value: alphaMap || null } },
        clipping: !!clip,
        side: clip || alphaMap ? THREE.DoubleSide : THREE.FrontSide,
        defines: alphaMap ? { ALPHA_CUT: '' } : {},
        // pull cut solids forward so their poche wins over the floor they stand on
        polygonOffset: !!clip,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -6,
      });
      if (clip) m.clippingPlanes = this.planes[clip];
      this.infoCache[key] = m;
    }
    return this.infoCache[key];
  }

  register(mesh) {
    const ud = mesh.userData;
    const src = mesh.material;
    const alpha = src && src.map && (src.alphaTest > 0 || src.transparent) ? src.map : null;
    ud.beautyMat = src;
    const kind = alpha && !ud.clip ? 3 : ud.kind || 0;
    ud.infoMat = ud.info === false ? null : this.infoMaterial(kind, ud.clip, alpha);
    this.items.push(mesh);
  }

  setSize(w, h, dpr) {
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    this.beautyRT.setSize(W, H);
    this.infoRT.setSize(W, H);
    const half = [Math.max(2, Math.round(W / 2)), Math.max(2, Math.round(H / 2))];
    const q4 = [Math.max(2, Math.round(W / 4)), Math.max(2, Math.round(H / 4))];
    const q10 = [Math.max(2, Math.round(W / 10)), Math.max(2, Math.round(H / 10))];
    this.aoRT.forEach((t) => t.setSize(...half));
    this.b1RT.forEach((t) => t.setSize(...q4));
    this.b2RT.forEach((t) => t.setSize(...q10));
    this.shRT.forEach((t) => t.setSize(...half));
    this.ssrRT.forEach((t) => t.setSize(...half));
    this.mAO.uniforms.uRes.value.set(...half);
    this.comp.uniforms.uRes.value.set(W, H);
    this.comp.uniforms.uPx.value = Math.max(1, dpr);
  }

  resetHistory() { this.hasHistory = false; }

  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  blur([a, b], radius) {
    const u = this.mBlur.uniforms;
    u.tSrc.value = a.texture; u.uDir.value.set(radius / a.width, 0); this.pass(this.mBlur, b);
    u.tSrc.value = b.texture; u.uDir.value.set(0, radius / a.height); this.pass(this.mBlur, a);
  }

  render({ beauty, background, time }) {
    const { renderer, scene, camera } = this;
    camera.updateMatrixWorld();
    this.curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.hasHistory) { this.prevVP.copy(this.curVP); this.hasHistory = true; }
    const cu = this.comp.uniforms;
    const th = Math.tan((camera.fov * Math.PI) / 360);
    cu.uCamWorld.value.copy(camera.matrixWorld);
    cu.uPrevVP.value.copy(this.prevVP);
    cu.uTanHalf.value.set(th * camera.aspect, th);
    // info pass
    for (const m of this.items) {
      if (m.userData.infoMat) m.material = m.userData.infoMat;
      else { m.userData.wasVisible = m.visible; m.visible = false; }
    }
    scene.background = null;
    const fog = scene.fog;
    scene.fog = null;
    renderer.setRenderTarget(this.infoRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    for (const m of this.items) {
      m.material = m.userData.beautyMat;
      if (!m.userData.infoMat) m.visible = m.userData.wasVisible;
    }
    scene.fog = fog;

    // beauty, ao and bloom are skipped while everything is still a drawing
    if (beauty) {
      scene.background = background;
      renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(this.beautyRT);
      renderer.render(scene, camera);
      scene.background = null;

      const t = Math.tan((camera.fov * Math.PI) / 360);
      this.mAO.uniforms.uTanHalf.value.set(t * camera.aspect, t);
      this.pass(this.mAO, this.aoRT[0]);
      this.blur(this.aoRT, 1);

      const sun = this.sun;
      if (this.opts.shafts && sun && sun.shadow.map) {
        const su = this.mShaft.uniforms;
        su.tShadow.value = sun.shadow.map.texture;
        su.uShadowMat.value.copy(sun.shadow.matrix);
        su.uCamWorld.value.copy(camera.matrixWorld);
        su.uTanHalf.value.set(t * camera.aspect, t);
        su.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize();
        this.pass(this.mShaft, this.shRT[0]);
        this.blur(this.shRT, 1.2);
      }

      if (this.opts.ssr) {
        const ssr = this.mSSR.uniforms;
        ssr.uTanHalf.value.set(t * camera.aspect, t);
        ssr.uCamWorld.value.copy(camera.matrixWorld);
        this.pass(this.mSSR, this.ssrRT[0]);
        this.blur(this.ssrRT, 1.0);
      }

      this.mBright.uniforms.uExposure.value = this.comp.uniforms.uExposure.value;
      this.pass(this.mBright, this.b1RT[0]);
      this.blur(this.b1RT, 1);
      this.mBlur.uniforms.tSrc.value = this.b1RT[0].texture;
      this.mBlur.uniforms.uDir.value.set(0, 0);
      this.pass(this.mBlur, this.b2RT[0]);
      this.blur(this.b2RT, 1.5);
    }

    this.comp.uniforms.uTime.value = time;
    this.pass(this.comp, null);
    this.prevVP.copy(this.curVP);
  }
}
