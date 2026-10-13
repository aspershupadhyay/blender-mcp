// The 3D backdrop: a glowing wireframe "scene cube" (your Blender), an orbit ring (the relay) with
// light packets travelling round it, and a field of drifting particles. Follows the pointer gently,
// pauses when the tab is hidden, and stays still for reduced motion.
import * as THREE from './vendor/three.module.min.js';

const canvas = document.getElementById('stage');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); }
catch { canvas.remove(); throw new Error('WebGL unavailable'); }
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x07080c, 0.055);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 0.4, 9);

const HOT = new THREE.Color('#ff5e3a'), WARM = new THREE.Color('#ffb347'), PINK = new THREE.Color('#d6248f'), COOL = new THREE.Color('#36d6ff'), VIOLET = new THREE.Color('#6c5cff');
const rig = new THREE.Group();
scene.add(rig);

// Gradient-coloured edges for a geometry.
function glowEdges(geo, a, b, opacity = 1) {
  const e = new THREE.EdgesGeometry(geo);
  const p = e.attributes.position, col = new Float32Array(p.count * 3);
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min.y) / (max.y - min.y || 1);
    const c = a.clone().lerp(b, t);
    col.set([c.r, c.g, c.b], i * 3);
  }
  e.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.LineSegments(e, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
}

// The scene cube: outer shell, subdivided inner lattice, and a bright core.
const cube = new THREE.Group();
cube.add(glowEdges(new THREE.BoxGeometry(2.4, 2.4, 2.4), PINK, WARM, 1));
cube.add(glowEdges(new THREE.BoxGeometry(2.4, 2.4, 2.4, 3, 3, 3), HOT, WARM, 0.18));
const inner = glowEdges(new THREE.IcosahedronGeometry(0.85, 1), VIOLET, COOL, 0.75);
cube.add(inner);
const glass = new THREE.Mesh(new THREE.BoxGeometry(2.36, 2.36, 2.36), new THREE.MeshBasicMaterial({ color: 0xff5e3a, transparent: true, opacity: 0.04, depthWrite: false }));
cube.add(glass);
// Soft glow sprites (drawn on a canvas: no image files).
function glowSprite(color, size) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(${color.r * 255 | 0},${color.g * 255 | 0},${color.b * 255 | 0},1)`);
  gr.addColorStop(0.25, `rgba(${color.r * 255 | 0},${color.g * 255 | 0},${color.b * 255 | 0},.35)`);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.setScalar(size);
  return s;
}
cube.add(glowSprite(HOT, 6.5));
const core = glowSprite(new THREE.Color('#ffffff'), 0.9);
cube.add(core);
cube.rotation.set(0.62, 0.78, 0);
rig.add(cube);

// The relay orbit: a tilted ring with packets riding it.
const orbit = new THREE.Group();
orbit.rotation.set(1.18, 0.0, -0.38);
const R = 3.6;
const ringGeo = new THREE.BufferGeometry().setFromPoints(new THREE.EllipseCurve(0, 0, R, R).getPoints(256).map((p) => new THREE.Vector3(p.x, p.y, 0)));
orbit.add(new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: COOL, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending })));
const ring2 = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending }));
ring2.scale.setScalar(1.08); orbit.add(ring2);
const packets = [];
for (let i = 0; i < 7; i++) {
  const s = glowSprite(i % 3 ? COOL : WARM, i % 3 ? 0.55 : 0.8);
  s.userData = { phase: (i / 7) * Math.PI * 2, speed: 0.35 + (i % 3) * 0.12 };
  orbit.add(s); packets.push(s);
}
const node = glowSprite(COOL, 1.6); orbit.add(node);
rig.add(orbit);

// Particle field.
const N = 1400, pts = new Float32Array(N * 3), pc = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  const r = 6 + Math.random() * 22, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
  pts.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th) - 6], i * 3);
  const c = [COOL, VIOLET, WARM, new THREE.Color('#ffffff')][i % 4];
  pc.set([c.r, c.g, c.b], i * 3);
}
const pg = new THREE.BufferGeometry();
pg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
const field = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
scene.add(field);

// Floor grid, like Blender's viewport.
const grid = new THREE.GridHelper(60, 60, 0x2a2440, 0x15141f);
grid.position.y = -3.2; grid.material.transparent = true; grid.material.opacity = 0.5;
scene.add(grid);

function layout() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const wide = w > 900;
  rig.position.set(wide ? 3.1 : 0.9, wide ? 0.2 : 3.4, wide ? 0 : -4);
  rig.scale.setScalar(wide ? 1 : 0.62);
}
addEventListener('resize', layout); layout();

const target = { x: 0, y: 0 };
addEventListener('pointermove', (e) => { target.x = (e.clientX / innerWidth - 0.5) * 2; target.y = (e.clientY / innerHeight - 0.5) * 2; });
let busy = 0; // pulses faster while the dashboard shows activity
addEventListener('relay:pulse', () => { busy = 1; });

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  busy = Math.max(0, busy - dt * 0.6);
  cube.rotation.y += 0.0025 + busy * 0.02;
  cube.rotation.x = 0.62 + Math.sin(t * 0.4) * 0.06;
  inner.rotation.x -= 0.006 + busy * 0.03; inner.rotation.z += 0.004;
  core.scale.setScalar(0.9 + Math.sin(t * 2.2) * 0.12 + busy * 0.8);
  for (const p of packets) { const a = p.userData.phase + t * p.userData.speed * (1 + busy * 3); p.position.set(Math.cos(a) * R, Math.sin(a) * R, 0); }
  const na = t * 0.15; node.position.set(Math.cos(na) * R, Math.sin(na) * R, 0);
  field.rotation.y = t * 0.012;
  rig.rotation.y += ((target.x * 0.25) - rig.rotation.y) * 0.04;
  rig.rotation.x += ((target.y * 0.12) - rig.rotation.x) * 0.04;
  camera.position.y = 0.4 - scrollY * 0.002;
  renderer.render(scene, camera);
}
if (still) { frame(); addEventListener('resize', frame); }
else {
  renderer.setAnimationLoop(frame);
  document.addEventListener('visibilitychange', () => renderer.setAnimationLoop(document.hidden ? null : frame));
}
