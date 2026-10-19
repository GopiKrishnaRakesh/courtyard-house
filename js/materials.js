import * as THREE from 'three';

// Shared uniforms injected into every lit material.
export const sharedUniforms = {
  uIndoor: { value: 0.32 }, // how much sky light survives under the roof
  uBounce: { value: 0.5 },  // warm light bounced off sunlit floors onto walls and ceilings
};

// Indirect light is dimmed under the roof (the HDRI has no idea there is a building).
// Footprint, courtyard and skylight rectangles are in plan metres.
const INDOOR_GLSL = /* glsl */ `
uniform float uSat;
uniform float uBright;
uniform float uCon;
uniform float uMean;
uniform float uIndoor;
uniform float uBounce;
varying vec3 vWPos;
float box2(vec2 p, vec4 r, float s) {
  return smoothstep(r.x - s, r.x + s, p.x) * (1.0 - smoothstep(r.z - s, r.z + s, p.x)) *
         smoothstep(r.y - s, r.y + s, p.y) * (1.0 - smoothstep(r.w - s, r.w + s, p.y));
}
float indoorAmt(vec3 p) {
  float inside = box2(p.xz, vec4(0.08, 0.08, 31.92, 25.92), 0.12);
  float court = box2(p.xz, vec4(10.0, 8.0, 22.0, 18.0), 0.35);
  float sky = max(box2(p.xz, vec4(15.4, 19.5, 16.6, 25.0), 0.9), box2(p.xz, vec4(26.0, 22.6, 29.2, 24.9), 1.2));
  float under = 1.0 - smoothstep(3.75, 3.9, p.y);
  return clamp(inside * under - court - sky * 0.55, 0.0, 1.0);
}
`;

function hook(mat, { sat = 1, bright = 1, con = 1, mean = 1 } = {}) {
  const uSat = { value: sat };
  const uBright = { value: bright };
  const uCon = { value: con };
  const uMean = { value: mean };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSat = uSat;
    sh.uniforms.uBright = uBright;
    sh.uniforms.uCon = uCon;
    sh.uniforms.uMean = uMean;
    sh.uniforms.uIndoor = sharedUniforms.uIndoor;
    sh.uniforms.uBounce = sharedUniforms.uBounce;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + INDOOR_GLSL)
      .replace('#include <map_fragment>', /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  float lum = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  sampledDiffuseColor.rgb = mix( vec3( lum ), sampledDiffuseColor.rgb, uSat ) * uBright;
  sampledDiffuseColor.rgb = mix( vec3( uMean ), sampledDiffuseColor.rgb, uCon );
  diffuseColor *= sampledDiffuseColor;
#endif`)
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
  {
    float ia = indoorAmt( vWPos );
    float f = mix( 1.0, uIndoor, ia );
    reflectedLight.indirectDiffuse *= f;
    reflectedLight.indirectSpecular *= mix( 1.0, f, 0.8 );
    vec3 wN = inverseTransformDirection( normal, viewMatrix );
    float down = 0.35 + 0.65 * max( -wN.y, 0.0 );
    reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3( 1.0, 0.8, 0.6 ) * uBounce * ia * down;
  }`);
  };
  mat.customProgramCacheKey = () => 'house-hook';
  return mat;
}

export { hook as hookMaterial };

// Material specs. `size` is the real-world width one texture tile covers, in metres
// (UVs are written in metres by house.js).
const SPECS = {
  oak:        { tex: 'oak_wood_planks', size: 2.2, sat: 0.45, bright: 1.8, rough: 0.78, normal: 0.7, coat: [0.18, 0.4] },
  limestone:  { tex: 'marble_01', size: 3.2, sat: 0.55, bright: 1.12, rough: 0.85, normal: 0.5 },
  paving:     { tex: 'marble_01', size: 2.4, sat: 0.5, bright: 1.0, rough: 1.0, normal: 0.9 },
  travertine: { tex: 'travertine', size: 1.8, sat: 0.85, bright: 1.08, rough: 0.55, normal: 0.35, coat: [0.3, 0.25] },
  boucle:     { tex: 'boucle', noMap: true, size: 0.22, rough: 1.0, normal: 1.3, color: '#efe8dc', sheen: '#fff8ee' },
  shade:      { color: '#f4ecdd', emissive: '#ffd096', emissiveIntensity: 0.75, roughness: 1.0 },
  book1:      { color: '#8c7b66', roughness: 0.75 },
  book2:      { color: '#5c5853', roughness: 0.75 },
  book3:      { color: '#c2b293', roughness: 0.75 },
  book4:      { color: '#3f4a50', roughness: 0.7 },
  book5:      { color: '#9b6a4c', roughness: 0.75 },
  book6:      { color: '#e2d9c8', roughness: 0.8 },
  plaster:    { tex: 'white_plaster_02', size: 5.0, sat: 0.1, bright: 1.0, con: 0.2, mean: 1.0, rough: 1.0, normal: 0.35, color: '#efe8de' },
  roof:       { tex: 'white_plaster_02', size: 5.0, sat: 0.1, bright: 1.0, con: 0.25, mean: 1.0, rough: 1.0, normal: 0.35, color: '#e9e0d3' },
  oakVeneer:  { tex: 'white_oak_veneer', size: 1.6, sat: 0.85, bright: 1.12, rough: 0.8, normal: 0.6, coat: [0.3, 0.35] },
  linen:      { tex: 'rough_linen', size: 0.7, sat: 0.0, bright: 1.25, rough: 1.0, normal: 0.8, color: '#efe6d8', sheen: '#fff6ea' },
  linenWarm:  { tex: 'rough_linen', size: 0.7, sat: 0.0, bright: 1.15, rough: 1.0, normal: 0.8, color: '#c9ad88', sheen: '#f3dcc0' },
  rug:        { tex: 'rough_linen', size: 0.45, sat: 0.0, bright: 1.1, rough: 1.0, normal: 1.0, color: '#ddd2c0', sheen: '#f6ecdc' },
  steel:      { color: '#1d1c1b', metalness: 0.55, roughness: 0.42 },
  brass:      { color: '#c39a5b', metalness: 1.0, roughness: 0.28 },
  blackStone: { color: '#24211f', metalness: 0.0, roughness: 0.32 },
  lacquer:    { color: '#141312', metalness: 0.0, roughness: 0.2, coat: [1.0, 0.06] },
  porcelain:  { color: '#f4f1ec', metalness: 0.0, roughness: 0.25, coat: [0.8, 0.08] },
  mirror:     { color: '#dfe3e2', metalness: 1.0, roughness: 0.04 },
  lawn:       { tex: 'leafy_grass', size: 3.0, sat: 1.0, bright: 0.95, rough: 1.0, normal: 1.0, color: '#b4c59a' },
  gravel:     { tex: 'gravel_floor_02', size: 1.6, sat: 0.6, bright: 1.15, rough: 1.0, normal: 1.0 },
  bark:       { color: '#5e5145', metalness: 0.0, roughness: 0.95 },
  foliage:    { color: '#7f8c6b', metalness: 0.0, roughness: 0.85 },
  foliageDk:  { color: '#5e6e4b', metalness: 0.0, roughness: 0.9 },
  hedge:      { color: '#55633f', metalness: 0.0, roughness: 0.95 },
  lampGlow:   { color: '#fff4e0', emissive: '#ffcf8f', emissiveIntensity: 0.6, roughness: 0.6 },
  ledGlow:    { color: '#fff6e8', emissive: '#ffe2b8', emissiveIntensity: 1.3, roughness: 0.6 },
};

// A small sprig of olive leaves drawn on a canvas, used on scattered cards to build canopies.
let leafTex = null;
function leafTexture() {
  if (leafTex) return leafTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const greens = ['#7d8a62', '#8f9a72', '#6c7a55', '#a3ab86', '#5f6d4a'];
  g.strokeStyle = '#5b5040';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(64, 124); g.quadraticCurveTo(60, 64, 70, 6); g.stroke();
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const y = 118 - t * 108, x = 64 + Math.sin(t * 2) * 4;
    const side = i % 2 ? 1 : -1;
    g.save();
    g.translate(x, y);
    g.rotate(side * (0.55 + 0.25 * Math.sin(i * 1.7)) - 0.05);
    g.fillStyle = greens[i % greens.length];
    g.beginPath();
    g.ellipse(0, -22, 6.5, 22, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  leafTex = new THREE.CanvasTexture(c);
  leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.anisotropy = 4;
  return leafTex;
}

export class Materials {
  constructor(manager, maxAniso = 8, texDir = 'assets/tex') {
    this.loader = new THREE.TextureLoader(manager);
    this.maxAniso = maxAniso;
    this.texDir = texDir;
    this.images = {};
    this.cache = {};
    this.planes = {}; // name -> [THREE.Plane]
  }

  _tex(name, kind, srgb, size) {
    const key = name + kind;
    if (!this.images[key]) {
      const t = this.loader.load(`${this.texDir}/${name}_${kind}.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.maxAniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      this.images[key] = t;
    }
    const t = this.images[key].clone();
    t.repeat.set(1 / size, 1 / size);
    return t;
  }

  _make(name) {
    if (name === 'glass') {
      return new THREE.MeshPhysicalMaterial({
        color: '#ffffff', transparent: true, opacity: 0.035, roughness: 0.0, metalness: 0,
        envMapIntensity: 0.55, depthWrite: false, side: THREE.DoubleSide,
      });
    }
    if (name === 'sheer') {
      return hook(new THREE.MeshStandardMaterial({
        color: '#f6f1e8', emissive: '#6b6358', transparent: true, opacity: 0.78, roughness: 1, side: THREE.DoubleSide, depthWrite: false,
      }));
    }
    if (name === 'water') {
      return hook(new THREE.MeshPhysicalMaterial({
        color: '#123534', roughness: 0.05, metalness: 0.0,
        envMapIntensity: 0.75,
      }));
    }
    if (name === 'leaves' || name === 'leavesDark') {
      return hook(new THREE.MeshStandardMaterial({
        map: leafTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8,
        color: name === 'leaves' ? '#ffffff' : '#4f6340',
      }));
    }
    const s = SPECS[name];
    if (!s) throw new Error('Unknown material ' + name);
    const params = {
      color: s.color || '#ffffff',
      metalness: s.metalness ?? 0,
      roughness: s.roughness ?? s.rough ?? 0.9,
    };
    if (s.emissive) { params.emissive = s.emissive; params.emissiveIntensity = s.emissiveIntensity; }
    if (s.tex) {
      if (!s.noMap) params.map = this._tex(s.tex, 'diff', true, s.size);
      params.normalMap = this._tex(s.tex, 'nor_gl', false, s.size);
      params.normalScale = new THREE.Vector2(s.normal, s.normal);
      params.roughnessMap = this._tex(s.tex, 'rough', false, s.size);
      params.roughness = s.rough;
    }
    let mat;
    if (s.sheen || s.coat) {
      if (s.sheen) Object.assign(params, { sheen: 1, sheenRoughness: 0.65, sheenColor: new THREE.Color(s.sheen) });
      if (s.coat) Object.assign(params, { clearcoat: s.coat[0], clearcoatRoughness: s.coat[1] });
      mat = new THREE.MeshPhysicalMaterial(params);
    } else mat = new THREE.MeshStandardMaterial(params);
    return hook(mat, { sat: s.sat ?? 1, bright: s.bright ?? 1, con: s.con ?? 1, mean: s.mean ?? 1 });
  }

  // `clip` names a set of clipping planes registered with setPlanes ('cut', 'roof').
  get(name, clip = null) {
    const key = name + '|' + (clip || '');
    if (!this.cache[key]) {
      const m = this._make(name);
      if (clip) {
        m.clippingPlanes = this.planes[clip];
        m.side = THREE.DoubleSide;
        m.shadowSide = THREE.FrontSide;
      }
      this.cache[key] = m;
    }
    return this.cache[key];
  }

  setPlanes(name, planes) { this.planes[name] = planes; }
}
