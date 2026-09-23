// The constellation — one particle system that morphs between six forms as the
// page scrolls: the Muse spark, a floor of light, a galaxy, the effort ring, a
// run helix and a sphere. Each <[data-scene]> element names its form and framing:
//   data-scene="shape x y scale opacity effortGain"
// Exposes window.museScene { setEffort(t), refreshPalette(), stats(), setPaused(b) }.
import * as THREE from "three";

const SHAPES = 6;

/* ───────── helpers ───────── */

const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/* The spark: a four-point star with concave flanks, plus the small companion
   spark and a faint halo — the logo in /public/spark.svg, in volume. */
function sparkPoint(out) {
  const roll = Math.random();
  let cx = -0.12;
  let cy = -0.1;
  let r = 1.25;
  if (roll < 0.1) {
    // halo
    const a = rand(0, Math.PI * 2);
    const rr = rand(1.62, 1.72) + gauss() * 0.03;
    out[0] = Math.cos(a) * rr;
    out[1] = Math.sin(a) * rr;
    out[2] = gauss() * 0.03;
    return;
  }
  if (roll < 0.22) {
    cx = 0.88;
    cy = 0.78;
    r = 0.36;
  }
  const t = rand(0, Math.PI * 2);
  const edge = Math.random() < 0.58;
  const s = edge ? rand(0.965, 1.0) : Math.sqrt(Math.random()) * 0.96;
  const p = 2.35;
  const c = Math.cos(t);
  const n = Math.sin(t);
  const x = Math.sign(c) * Math.pow(Math.abs(c), p) * s;
  const y = Math.sign(n) * Math.pow(Math.abs(n), p) * s;
  const d = Math.min(1, Math.hypot(x, y));
  out[0] = cx + x * r;
  out[1] = cy + y * r;
  out[2] = (Math.random() * 2 - 1) * 0.2 * r * (1 - d * 0.85);
}

function planePoint(out) {
  out[0] = rand(-6, 6);
  out[1] = -1.35 + gauss() * 0.015;
  out[2] = rand(-5, 2.2);
}

function galaxyPoint(out, i) {
  const arms = 3;
  const arm = i % arms;
  const r = Math.pow(Math.random(), 0.62) * 2.7;
  const a = (arm / arms) * Math.PI * 2 + r * 1.55 + gauss() * 0.22 * (0.35 + r * 0.25);
  out[0] = Math.cos(a) * r + gauss() * 0.05;
  out[1] = gauss() * 0.07 * (1.25 - r / 2.7);
  out[2] = Math.sin(a) * r + gauss() * 0.05;
}

function ringPoint(out) {
  const a = rand(0, Math.PI * 2);
  const flare = Math.random() < 0.12;
  const R = 2.05 + (flare ? Math.abs(gauss()) * 0.42 : gauss() * 0.055);
  out[0] = Math.cos(a) * R;
  out[1] = Math.sin(a) * R;
  out[2] = gauss() * (flare ? 0.2 : 0.05);
}

function helixPoint(out) {
  const roll = Math.random();
  const y = rand(-2.9, 2.9);
  const a = y * 2.1;
  if (roll < 0.72) {
    const strand = Math.random() < 0.5 ? 0 : Math.PI;
    out[0] = Math.cos(a + strand) * 0.82 + gauss() * 0.04;
    out[1] = y + gauss() * 0.02;
    out[2] = Math.sin(a + strand) * 0.82 + gauss() * 0.04;
  } else if (roll < 0.9) {
    // rungs
    const k = Math.round(y * 3.2) / 3.2;
    const ka = k * 2.1;
    const u = rand(-1, 1);
    out[0] = Math.cos(ka) * 0.82 * u;
    out[1] = k + gauss() * 0.01;
    out[2] = Math.sin(ka) * 0.82 * u;
  } else {
    const rr = rand(1.1, 1.9);
    out[0] = Math.cos(a * 0.7) * rr;
    out[1] = y;
    out[2] = Math.sin(a * 0.7) * rr;
  }
}

function spherePoint(out, i, count) {
  const shell = Math.random() < 0.8;
  const k = i + 0.5;
  const phi = Math.acos(1 - (2 * k) / count);
  const theta = Math.PI * (1 + Math.sqrt(5)) * k;
  const r = shell ? 1.55 + gauss() * 0.012 : Math.cbrt(Math.random()) * 1.45;
  out[0] = Math.cos(theta) * Math.sin(phi) * r;
  out[1] = Math.sin(theta) * Math.sin(phi) * r;
  out[2] = Math.cos(phi) * r;
}

/* ───────── shaders ───────── */

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = /* glsl */ `
uniform float uTime, uFrom, uTo, uMix, uIntro, uEffort, uSize, uPR, uAspect, uPointerForce;
uniform vec2 uPointer;
uniform vec3 uColA, uColB, uColC, uHot;
attribute vec3 p0, p1, p2, p3, p4, p5, aScatter;
attribute vec4 aRnd;
varying vec3 vColor;
varying float vAlpha;
${NOISE}
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
mat3 rotZ(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
vec3 shape(float i){
  if(i<.5) return p0;
  if(i<1.5){
    vec3 p=p1;
    p.y+=sin(p.x*.9+uTime*.7)*.14+cos(p.z*1.3+uTime*.55)*.12+sin((p.x+p.z)*.6-uTime*.4)*.08;
    return p;
  }
  if(i<2.5) return rotX(.95)*(rotY(uTime*.07)*p2);
  if(i<3.5) return rotX(-.55)*(rotZ(uTime*.12)*p3);
  if(i<4.5) return rotZ(.22)*(rotY(uTime*.38)*p4);
  return rotY(uTime*.09)*p5;
}
void main(){
  float st=aRnd.x;
  float m=smoothstep(0.,1.,clamp(uMix*1.55-st*.55,0.,1.));
  vec3 pos=mix(shape(uFrom),shape(uTo),m);
  float between=sin(m*3.14159);
  float e=uEffort;
  float amp=.012+e*e*e*.34+between*.42;
  float ts=uTime*(.12+e*.5);
  vec3 q=pos*(.85+e*.6)+aRnd.y*2.;
  pos+=vec3(snoise(q+ts),snoise(q+vec3(17.1)+ts),snoise(q+vec3(33.7)+ts))*amp;
  float ie=smoothstep(0.,1.,clamp(uIntro*1.45-st*.45,0.,1.));
  pos=mix(aScatter,pos,ie);
  vec4 mv=modelViewMatrix*vec4(pos,1.);
  vec4 clip=projectionMatrix*mv;
  vec2 ndc=clip.xy/clip.w;
  vec2 d=ndc-uPointer;d.x*=uAspect;
  float dist=length(d);
  float push=smoothstep(.42,0.,dist)*uPointerForce;
  vec2 dir=normalize(d+vec2(1e-4));dir.x/=uAspect;
  mv.xy+=dir*push*.55*(-mv.z)*.14;
  gl_Position=projectionMatrix*mv;
  float sz=.45+aRnd.z*aRnd.z*1.6;
  gl_PointSize=min(uSize*sz*uPR*(7./max(-mv.z,1.))*(1.+e*.35+push*.8),20.*uPR);
  float tw=.45+.55*abs(sin(uTime*(.35+aRnd.w*1.2)+aRnd.y*6.2831));
  vAlpha=tw*(.55+ie*.45);
  vec3 col=mix(uColA,uColB,smoothstep(.15,.95,aRnd.y));
  col=mix(col,uHot,e*e*smoothstep(.3,1.,aRnd.w));
  if(aRnd.w>.955) col=uColC;
  col+=push*.35;
  vColor=col;
}`;

const FRAG = /* glsl */ `
uniform float uOpacity, uLight;
varying vec3 vColor;
varying float vAlpha;
void main(){
  vec2 c=gl_PointCoord-.5;
  float d=length(c)*2.;
  if(d>1.) discard;
  float glow=pow(1.-d,1.9);
  float core=smoothstep(.35,0.,d);
  float a=(glow*.75+core*.5)*vAlpha*uOpacity;
  if(uLight>.5){ gl_FragColor=vec4(vColor,a*.9); }
  else { gl_FragColor=vec4(vColor*(1.+core*.6),a); }
}`;

/* ───────── scene ───────── */

export function initScene() {
  const host = document.getElementById("scene");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = window.matchMedia("(max-width: 760px)");
  const api = {
    effort: 0.66,
    setEffort: () => {},
    refreshPalette: () => {},
    stats: () => ({ fps: 0, count: 0, frames: 0 }),
    setPaused: () => {},
  };
  window.museScene = api;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  } catch {
    document.documentElement.classList.add("no-webgl");
    return api;
  }
  let pr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pr);
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
  camera.position.set(0, 0, 7);

  /* geometry */
  const COUNT = narrow.matches ? 14000 : 26000;
  const geo = new THREE.BufferGeometry();
  const gens = [sparkPoint, planePoint, galaxyPoint, ringPoint, helixPoint, spherePoint];
  // shape slot order in the shader: 0 spark, 1 plane, 2 galaxy, 3 ring, 4 helix, 5 sphere
  const tmp = [0, 0, 0];
  for (let s = 0; s < SHAPES; s++) {
    const arr = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      gens[s](tmp, i, COUNT);
      arr[i * 3] = tmp[0];
      arr[i * 3 + 1] = tmp[1];
      arr[i * 3 + 2] = tmp[2];
    }
    geo.setAttribute(`p${s}`, new THREE.BufferAttribute(arr, 3));
  }
  const scatter = new Float32Array(COUNT * 3);
  const rnd = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    // a wide, deep cloud that always stays in front of the camera (z < 2.5)
    const a = rand(0, Math.PI * 2);
    const r = 2.5 + Math.pow(Math.random(), 0.7) * 7;
    scatter[i * 3] = Math.cos(a) * r;
    scatter[i * 3 + 1] = Math.sin(a) * r * 0.7;
    scatter[i * 3 + 2] = rand(-14, 2.5);
    rnd[i * 4] = Math.random();
    rnd[i * 4 + 1] = Math.random();
    rnd[i * 4 + 2] = Math.random();
    rnd[i * 4 + 3] = Math.random();
  }
  geo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
  geo.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  // `position` is required by three for draw-range; alias the spark
  geo.setAttribute("position", geo.getAttribute("p0"));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);

  const uniforms = {
    uTime: { value: 0 },
    uFrom: { value: 0 },
    uTo: { value: 0 },
    uMix: { value: 0 },
    uIntro: { value: reduced.matches ? 1 : 0 },
    uEffort: { value: 0.1 },
    uSize: { value: narrow.matches ? 3.4 : 3.0 },
    uPR: { value: pr },
    uAspect: { value: 1 },
    uPointer: { value: new THREE.Vector2(9, 9) },
    uPointerForce: { value: 0 },
    uOpacity: { value: 1 },
    uLight: { value: 0 },
    uColA: { value: new THREE.Color("#9DBCF4") },
    uColB: { value: new THREE.Color("#3D9BFF") },
    uColC: { value: new THREE.Color("#ffffff") },
    uHot: { value: new THREE.Color("#2F6BFF") },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  const group = new THREE.Group();
  group.add(points);
  scene.add(group);

  /* palette follows html[data-theme][data-accent] */
  function refreshPalette() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const light = document.documentElement.dataset.theme === "light";
    uniforms.uLight.value = light ? 1 : 0;
    material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    if (light) {
      uniforms.uColA.value.set(v("--peak-a", "#2F6BFF"));
      uniforms.uColB.value.set(v("--accent-text", "#355C9C"));
      uniforms.uColC.value.set(v("--peak-b", "#3D9BFF"));
      uniforms.uHot.value.set(v("--peak-a", "#2F6BFF"));
    } else {
      uniforms.uColA.value.set(v("--accent", "#9DBCF4"));
      uniforms.uColB.value.set(v("--peak-b", "#3D9BFF"));
      uniforms.uColC.value.set(v("--peak-c", "#ffffff"));
      uniforms.uHot.value.set(v("--peak-a", "#2F6BFF"));
    }
    dirty = true;
  }

  /* sections → morph targets */
  const sections = [...document.querySelectorAll("[data-scene]")].map((el) => {
    const [shape, x, y, scale, opacity, gain] = el.dataset.scene.trim().split(/\s+/).map(Number);
    return { el, shape, x, y, scale, opacity, gain: gain ?? 0.3 };
  });

  const frame = { from: 0, to: 0, mix: 0, x: 0, y: 0, scale: 1, opacity: 1, gain: 0.3 };
  function readScroll() {
    // A section owns the scene once its top passes 30% of the viewport; the
    // morph toward the next one runs while this section's bottom travels from
    // the viewport's bottom edge up to that same 30% line, so the hand-off is
    // seamless (sections are contiguous).
    const vh = window.innerHeight;
    const line = vh * 0.3;
    let idx = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].el.getBoundingClientRect().top <= line) idx = i;
    }
    const cur = sections[idx];
    const next = sections[Math.min(idx + 1, sections.length - 1)];
    const r = cur.el.getBoundingClientRect();
    let t = next === cur ? 0 : (vh - r.bottom) / (vh - line);
    t = Math.min(1, Math.max(0, t));
    const mobile = narrow.matches;
    const lerp = (a, b) => a + (b - a) * t;
    frame.from = cur.shape;
    frame.to = next.shape;
    frame.mix = t;
    frame.x = lerp(cur.x, next.x) * (mobile ? 0.2 : 1);
    frame.y = lerp(cur.y, next.y);
    frame.scale = lerp(cur.scale, next.scale) * (mobile ? 0.66 : 1);
    frame.opacity = lerp(cur.opacity, next.opacity);
    frame.gain = lerp(cur.gain, next.gain);
    // same shape on both sides: no scatter bump
    if (cur.shape === next.shape) frame.mix = 0;
  }

  /* sizing */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / h;
    // keep the object's apparent size in portrait
    camera.position.z = w / h < 0.8 ? 7 / Math.max(0.62, (w / h) * 1.15) : 7;
    camera.updateProjectionMatrix();
    uniforms.uAspect.value = w / h;
    dirty = true;
  }

  /* pointer */
  const pointer = { x: 9, y: 9, tx: 9, ty: 9, force: 0, tforce: 0 };
  window.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch") return;
      pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = -(e.clientY / window.innerHeight) * 2 + 1;
      if (pointer.x > 5) {
        pointer.x = pointer.tx;
        pointer.y = pointer.ty;
      }
      pointer.tforce = 1;
      dirty = true;
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => (pointer.tforce = 0));

  /* loop */
  let dirty = true;
  let paused = false;
  let visible = !document.hidden;
  let time = 0;
  let last = performance.now();
  let frames = 0;
  let fps = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  let lastFrame = performance.now();
  let degraded = false;
  let lowWindows = 0;
  const born = performance.now();
  let effortTarget = api.effort;
  const smooth = { x: 0, y: 0, scale: 1, opacity: 1, gain: 0.3, from: 0, to: 0, mix: 0, ry: 0, rx: 0 };
  let raf = 0;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const still = reduced.matches || paused;
    if (still && !dirty) return;
    if (!still) time += dt;
    readScroll();

    const k = still ? 1 : 1 - Math.pow(0.0015, dt);
    smooth.x += (frame.x - smooth.x) * k;
    smooth.y += (frame.y - smooth.y) * k;
    smooth.scale += (frame.scale - smooth.scale) * k;
    smooth.opacity += (frame.opacity - smooth.opacity) * k;
    smooth.gain += (frame.gain - smooth.gain) * k;
    if (frame.from !== smooth.from || frame.to !== smooth.to) {
      smooth.from = frame.from;
      smooth.to = frame.to;
      smooth.mix = frame.mix;
    }
    smooth.mix += (frame.mix - smooth.mix) * Math.min(1, k * 1.4);

    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 7);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 7);
    pointer.force += (pointer.tforce - pointer.force) * Math.min(1, dt * 3);

    uniforms.uTime.value = time;
    uniforms.uFrom.value = smooth.from;
    uniforms.uTo.value = smooth.to;
    uniforms.uMix.value = smooth.mix;
    uniforms.uOpacity.value = smooth.opacity;
    uniforms.uPointer.value.set(pointer.x, pointer.y);
    uniforms.uPointerForce.value = still ? 0 : pointer.force;
    const eTarget = effortTarget * smooth.gain;
    uniforms.uEffort.value += (eTarget - uniforms.uEffort.value) * (still ? 1 : Math.min(1, dt * 3));
    // wall-clock, so a slow first second can't stall the assembly
    if (uniforms.uIntro.value < 1) uniforms.uIntro.value = still ? 1 : Math.min(1, (now - born) / 2200);

    const px = pointer.x > 5 ? 0 : pointer.x;
    const py = pointer.y > 5 ? 0 : pointer.y;
    smooth.ry += (Math.sin(time * 0.22) * 0.32 + px * 0.28 - smooth.ry) * Math.min(1, dt * 2.5);
    smooth.rx += (-py * 0.16 - smooth.rx) * Math.min(1, dt * 2.5);
    group.rotation.set(smooth.rx, smooth.ry, 0);
    group.position.set(smooth.x, smooth.y, 0);
    group.scale.setScalar(smooth.scale);

    renderer.render(scene, camera);
    frames++;
    dirty = false;
    // ignore gaps from paused / hidden stretches when measuring
    const gap = now - lastFrame;
    lastFrame = now;
    if (!still && gap < 1500) {
      fpsAcc += gap;
      fpsN++;
    }
    if (fpsAcc > 500) {
      fps = Math.round((fpsN * 1000) / fpsAcc);
      fpsAcc = 0;
      fpsN = 0;
      // adaptive quality: a struggling GPU keeps the motion, loses density
      // adaptive quality, two steps: first resolution, then density
      if (!still && now - born > 2500) {
        lowWindows = fps < 50 ? lowWindows + 1 : 0;
        if (lowWindows >= 3 && pr > 1) {
          pr = 1;
          renderer.setPixelRatio(pr);
          uniforms.uPR.value = pr;
          resize();
          lowWindows = 0;
        } else if (lowWindows >= 4 && !degraded && fps < 32) {
          degraded = true;
          geo.setDrawRange(0, Math.floor(COUNT / 2));
          uniforms.uSize.value *= 1.25;
          lowWindows = 0;
        }
      }
    }
  }

  function start() {
    if (!raf && visible) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    visible ? start() : stop();
  });
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", () => (dirty = true), { passive: true });
  window.addEventListener("muse:theme", () => requestAnimationFrame(refreshPalette));
  reduced.addEventListener("change", () => {
    if (reduced.matches) uniforms.uIntro.value = 1;
    dirty = true;
  });

  api.setEffort = (t) => {
    api.effort = t;
    effortTarget = t;
    dirty = true;
  };
  api.refreshPalette = refreshPalette;
  api.setPaused = (p) => {
    paused = p;
    dirty = true;
  };
  api.stats = () => ({ fps: paused || reduced.matches ? 0 : fps, count: degraded ? Math.floor(COUNT / 2) : COUNT, frames });

  resize();
  refreshPalette();
  start();
  return api;
}
