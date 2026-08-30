// C0 spike — renderer (THROWAWAY).
//
// The one question: with the geometry sitting on a unit sphere in GPU memory
// and the rotation reduced to a mat3 uniform, does the hairline stack hold
// 60fps while it turns — at max zoom, at native DPR, on integrated graphics?
//
// So this draws the lines and nothing else. No fills, no ribbons, no labels,
// no picking, no palette, no draw-order fidelity. Those are C1-C5, and none of
// them change the answer here: hairlines are the expensive part, because they
// are 300k instances of screen-space quad expansion with per-fragment
// antialiasing, and the fills are a few thousand flat triangles.
//
// Read it as an experiment, not as a first draft of the renderer.

const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", {
  antialias: false, // lines are analytically antialiased below; MSAA on top
  depth: false, //    would just be measuring a cost the real renderer won't pay
  alpha: false,
  powerPreference: "high-performance",
});
if (!gl) throw new Error("WebGL2 unavailable");

// ------------------------------------------------------------------- shaders

// Screen-space quad expansion. Both endpoints are rotated and projected here,
// so the CPU never touches a vertex — that is the entire thesis of the rewrite.
const LINE_VS = `#version 300 es
precision highp float;

in vec3 aStart;
in vec3 aEnd;
in vec2 aCorner;          // x: 0|1 along the segment, y: -1|+1 across it

uniform mat3 uRot;        // the rotation. The whole camera change, per frame.
uniform float uScale;     // sphere radius in device px (GLOBE_SCALE * k * fit)
uniform vec2 uCenter;     // device px where the sub-viewer point lands
uniform vec2 uViewport;
uniform float uHalfWidth; // device px, half the stroke
uniform float uFeather;   // device px of antialiasing skirt

out float vFront;         // > 0 on the near hemisphere
out float vAcross;        // device px from the centreline

// d3.geoOrthographic looks down +x, so the picture is (y, -z).
vec2 project(vec3 p) { return uCenter + vec2(p.y, -p.z) * uScale; }

void main() {
  vec3 a = uRot * aStart;
  vec3 b = uRot * aEnd;
  vFront = mix(a.x, b.x, aCorner.x);

  // Roughly half the sphere faces away at any moment. Letting the fragment
  // stage discard it still pays to rasterize the quad first, so collapse it
  // here instead: a vertex outside clip space costs nothing downstream. The
  // deck.gl path never saw this geometry at all -- d3 clips the far side on
  // the CPU before upload -- so without this the comparison is unfair.
  if (a.x < 0.0 && b.x < 0.0) {
    vAcross = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 pa = project(a);
  vec2 pb = project(b);

  vec2 d = pb - pa;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  // Across the segment: the stroke, plus the antialiasing ramp.
  // Along it: a square cap of the stroke's own half width, and no more. This
  // used to extend by halfWidth + feather, which on county arcs -- averaging
  // about two device pixels at the home view -- made every quad four times
  // longer than the line inside it. That single term was most of the gap
  // between counties at 46.8 ns/segment and the coast runs at 21.7.
  float across = uHalfWidth + uFeather;
  vec2 along = dir * uHalfWidth * (aCorner.x * 2.0 - 1.0);
  vec2 pos = mix(pa, pb, aCorner.x) + along + nrm * aCorner.y * across;

  vAcross = aCorner.y * across;

  vec2 clip = pos / uViewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

// The horizon: one line. This is what replaces d3-geo's clipping.
const LINE_FS = `#version 300 es
precision highp float;
in float vFront;
in float vAcross;
uniform vec4 uColor;
uniform float uHalfWidth;
uniform float uFeather;
out vec4 fragColor;
void main() {
  if (vFront < 0.0) discard;
  float a = clamp((uHalfWidth + uFeather * 0.5 - abs(vAcross)) / uFeather, 0.0, 1.0);
  fragColor = vec4(uColor.rgb, uColor.a * a);
}`;

// The ocean disc. Analytic, because an orthographic sphere is always a circle
// of radius `scale` about `translate` — it does not move when the globe turns.
const DISC_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
uniform float uScale;
uniform vec2 uCenter;
uniform vec2 uViewport;
out vec2 vLocal;
void main() {
  vLocal = aCorner;
  vec2 pos = uCenter + aCorner * (uScale + 2.0);
  vec2 clip = pos / uViewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const DISC_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
uniform float uScale;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  float r = length(vLocal) * (uScale + 2.0);
  float a = clamp(uScale + 0.5 - r, 0.0, 1.0);
  if (a <= 0.0) discard;
  fragColor = vec4(uColor.rgb, uColor.a * a);
}`;

function compile(vsSrc, fsSrc) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) + "\n" + src);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const { name } = gl.getActiveUniform(p, i);
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, u: uniforms };
}

const lineProg = compile(LINE_VS, LINE_FS);
const discProg = compile(DISC_VS, DISC_FS);

// ---------------------------------------------------------------------- data

const manifest = await (await fetch("/spike-data/geometry.json")).json();
const raw = await (await fetch("/spike-data/geometry.bin")).arrayBuffer();

// One upload, once. Nothing in this buffer is ever touched again.
const geometryBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
gl.bufferData(gl.ARRAY_BUFFER, raw, gl.STATIC_DRAW);

// The unit quad every segment is stamped from.
const cornerBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]),
  gl.STATIC_DRAW
);

const A_START = gl.getAttribLocation(lineProg.program, "aStart");
const A_END = gl.getAttribLocation(lineProg.program, "aEnd");
const A_CORNER = gl.getAttribLocation(lineProg.program, "aCorner");

// One VAO per group. WebGL2 has no baseInstance, so a group's slice of the
// buffer is expressed as an attribute offset instead — which is also how the
// real renderer would do a layer.
const STYLE = {
  counties: { color: [0.62, 0.6, 0.58, 0.85], width: 0.5, on: true },
  boundary: { color: [0.25, 0.35, 0.45, 1.0], width: 0.7, on: true },
  world: { color: [0.55, 0.55, 0.52, 0.9], width: 0.6, on: true },
  graticule: { color: [1.0, 1.0, 1.0, 0.22], width: 0.5, on: true },
};

const groups = manifest.groups.map((g) => {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.enableVertexAttribArray(A_CORNER);
  gl.vertexAttribPointer(A_CORNER, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
  for (const [loc, base] of [
    [A_START, manifest.startsOffset],
    [A_END, manifest.endsOffset],
  ]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 12, base + g.first * 12);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  return { ...g, vao, ...STYLE[g.name] };
});

// The disc's quad spans -1..1 in both axes, so it needs corners of its own.
const discCorners = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, discCorners);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

const discVao = gl.createVertexArray();
gl.bindVertexArray(discVao);
const discCornerLoc = gl.getAttribLocation(discProg.program, "aCorner");
gl.enableVertexAttribArray(discCornerLoc);
gl.vertexAttribPointer(discCornerLoc, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// -------------------------------------------------------------------- camera

const RAD = Math.PI / 180;
const view = {
  rotation: [...manifest.homeRotation, 0],
  k: 1, //           d3.zoom's scale factor. 1 frames the lower 48, 16 is max.
  center: [0, 0], // device px; set by resize
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  width: 1,
  height: 1,
  fit: 1,
};

// Same composition as the compiler's rotationMatrix, and verified against
// d3.geoOrthographic there. Column-major for uniformMatrix3fv.
const rotM = new Float32Array(9);
function updateRotation() {
  const [l, p, g] = view.rotation;
  const [cl, sl] = [Math.cos(l * RAD), Math.sin(l * RAD)];
  const [cp, sp] = [Math.cos(p * RAD), Math.sin(p * RAD)];
  const [cg, sg] = [Math.cos(g * RAD), Math.sin(g * RAD)];
  // Ryz(g) * Rxz(p) * Rz(l), written out rather than multiplied at runtime.
  const m = [
    [cp * cl, -cp * sl, -sp],
    [cg * sl - sg * sp * cl, cg * cl + sg * sp * sl, -sg * cp],
    [sg * sl + cg * sp * cl, sg * cl - cg * sp * sl, cg * cp],
  ];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) rotM[c * 3 + r] = m[r][c];
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  view.width = Math.max(1, Math.round(rect.width * view.dpr));
  view.height = Math.max(1, Math.round(rect.height * view.dpr));
  canvas.width = view.width;
  canvas.height = view.height;
  // The app fits its 975x610 design box into the canvas, letterboxed.
  view.fit = Math.min(rect.width / 975, rect.height / 610);
  view.center = [view.width / 2, view.height / 2];
}

const sphereRadiusPx = () => manifest.globeScale * view.k * view.fit * view.dpr;

// ------------------------------------------------------------------ the draw

gl.enable(gl.BLEND);
gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
gl.disable(gl.DEPTH_TEST);

let drawnInstances = 0;
// Diagnostic: draw the geometry with zero-area quads, so the frame contains
// vertex work and nothing else. The gap against a normal frame is the
// fragment cost, and the two respond to different fixes -- LOD cuts vertices,
// thinner quads cut fragments.
let vertexOnly = false;

function draw(passes = 1) {
  const scale = sphereRadiusPx();
  gl.viewport(0, 0, view.width, view.height);
  gl.clearColor(0.05, 0.06, 0.08, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  drawnInstances = 0;

  for (let pass = 0; pass < passes; pass++) {
    gl.useProgram(discProg.program);
    gl.bindVertexArray(discVao);
    gl.uniform1f(discProg.u.uScale, scale);
    gl.uniform2fv(discProg.u.uCenter, view.center);
    gl.uniform2f(discProg.u.uViewport, view.width, view.height);
    gl.uniform4f(discProg.u.uColor, 0.09, 0.13, 0.19, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(lineProg.program);
    gl.uniformMatrix3fv(lineProg.u.uRot, false, rotM);
    gl.uniform1f(lineProg.u.uScale, scale);
    gl.uniform2fv(lineProg.u.uCenter, view.center);
    gl.uniform2f(lineProg.u.uViewport, view.width, view.height);
    // The antialiasing ramp is one DEVICE pixel, not one CSS pixel. Scaling it
    // by dpr made every quad 6 device px wide to draw a 2 px stroke.
    gl.uniform1f(lineProg.u.uFeather, vertexOnly ? 1e-4 : 1.0);

    for (const g of groups) {
      if (!g.on) continue;
      // Zero width collapses every quad, so nothing reaches the fragment
      // stage: what is left is the vertex and setup cost, which is the floor
      // LOD would have to beat.
      const half = vertexOnly ? 0.0 : Math.max(0.35, g.width * view.dpr);
      gl.uniform1f(lineProg.u.uHalfWidth, half);
      gl.uniform4fv(lineProg.u.uColor, g.color);
      gl.bindVertexArray(g.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.count);
      drawnInstances += g.count;
    }
  }
  gl.bindVertexArray(null);
}

// ------------------------------------------------------------------ measuring
//
// rAF is refresh-capped, so "60fps" alone proves nothing about headroom. Three
// numbers instead:
//   frame  — wall-clock rAF interval. The user-visible answer.
//   cpu    — JS time spent issuing the frame. Should be ~0; if it isn't, the
//            premise (rotation costs what panning costs) is wrong.
//   gpu    — EXT_disjoint_timer_query_webgl2 where available, else inferred by
//            the stress multiplier below.

const timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
const pending = [];
const stats = { frame: [], cpu: [], gpu: [] };
const push = (arr, v) => {
  arr.push(v);
  if (arr.length > 180) arr.shift();
};
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

function collectQueries() {
  while (pending.length) {
    const q = pending[0];
    if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
      pending.forEach((x) => gl.deleteQuery(x));
      pending.length = 0;
      return;
    }
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
    push(stats.gpu, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(pending.shift());
  }
}

// ----------------------------------------------------------------- the loop

const ui = {
  spin: document.getElementById("spin"),
  passes: document.getElementById("passes"),
  passesOut: document.getElementById("passes-out"),
  dpr: document.getElementById("dpr"),
  readout: document.getElementById("readout"),
  zoom: document.getElementById("zoom-out"),
  groups: document.getElementById("groups"),
  bench: document.getElementById("bench"),
  benchOut: document.getElementById("bench-out"),
  vertexOnly: document.getElementById("vertexonly"),
};
ui.vertexOnly.addEventListener("change", () => {
  vertexOnly = ui.vertexOnly.checked;
});

// While a sweep is running it drives the pass count and eats the frame deltas.
let bench = null;

let last = performance.now();
function frame(now) {
  push(stats.frame, now - last);
  if (bench) bench.onFrame(now - last);
  last = now;

  // Always turning. The cost of a still frame is not the number we need.
  if (ui.spin.checked || bench) view.rotation[0] -= 0.35;
  updateRotation();

  const passes = bench ? bench.passes : +ui.passes.value;
  const t0 = performance.now();

  let query = null;
  if (timerExt && pending.length < 4) {
    query = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
  }
  draw(passes);
  if (query) {
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    pending.push(query);
  }

  push(stats.cpu, performance.now() - t0);
  if (timerExt) collectQueries();
  requestAnimationFrame(frame);
}

const fmt = (v) => (v == null ? "--" : v.toFixed(2));
setInterval(() => {
  const f = pct(stats.frame, 0.5);
  const rows = [
    ["frame p50 / p95", `${fmt(f)} / ${fmt(pct(stats.frame, 0.95))} ms`],
    ["fps", f ? (1000 / f).toFixed(0) : "--"],
    ["cpu p50 / p95", `${fmt(pct(stats.cpu, 0.5))} / ${fmt(pct(stats.cpu, 0.95))} ms`],
    [
      "gpu p50 / p95",
      timerExt ? `${fmt(pct(stats.gpu, 0.5))} / ${fmt(pct(stats.gpu, 0.95))} ms` : "unavailable",
    ],
    ["instances / frame", drawnInstances.toLocaleString()],
    ["zoom k", `${view.k.toFixed(2)}  (sphere ${sphereRadiusPx().toFixed(0)} px)`],
    ["dpr", view.dpr.toFixed(2)],
  ];
  ui.readout.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join("");
}, 250);

// ------------------------------------------------------------- the benchmark
//
// Two numbers were ambiguous by hand: rAF clamps the 1x reading to the refresh
// period, and the machine's clocks ramp, so a cold sample and a warm one differ
// by 2x. Both are removed here.
//
// Method: for a given layer set, climb the pass count until the frame time is
// well clear of vsync, then sample again at double. The slope between those two
// points is the cost of one pass, and the fixed per-frame overhead cancels out
// exactly rather than being estimated. Every sample runs warm, after a ramp.

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

// Median frame time over `frames` samples at a given pass count, discarding the
// first few while the pipeline fills.
const sample = (passes, frames = 34) =>
  new Promise((resolve) => {
    const seen = [];
    bench = {
      passes,
      onFrame: (dt) => {
        seen.push(dt);
        if (seen.length >= frames) {
          bench = null;
          resolve(median(seen.slice(10)));
        }
      },
    };
  });

// Cost of one pass over whatever is currently enabled, in ms. Starts the climb
// at 4 because 1 and 2 are clamped by vsync on anything this cheap.
async function costPerPass() {
  const CLEAR_OF_VSYNC = 40;
  let n = 4;
  let t = await sample(n);
  while (t < CLEAR_OF_VSYNC && n < 256) {
    n *= 2;
    t = await sample(n);
  }
  const t2 = await sample(n * 2);
  return { ms: (t2 - t) / n, n, t, t2 };
}

async function runBenchmark() {
  ui.bench.disabled = true;
  const wasOn = groups.map((g) => g.on);
  const lines = [];
  const say = (html) => {
    lines.push(html);
    ui.benchOut.innerHTML = lines.join("");
  };

  say(`<p class="note">warming up…</p>`);
  await sample(12, 150); // force the clocks up before anything is recorded

  // The refresh period, measured rather than assumed: nothing drawn, so the
  // frame time is pure vsync.
  groups.forEach((g) => (g.on = false));
  const refresh = await sample(1);
  const budget = Math.min(refresh, 16.67);

  lines.length = 0;
  say(`<div class="row"><span>refresh</span><b>${refresh.toFixed(1)} ms` +
      ` (${(1000 / refresh).toFixed(0)} Hz)</b></div>`);

  // The full stack first, because that alone decides go/no-go. The per-layer
  // breakdown after it says where the budget went, which is what a "too slow"
  // verdict would need next.
  let full = null;
  for (const g of [null, ...groups]) {
    groups.forEach((x, i) => (x.on = g ? x === g : wasOn[i]));
    const label = g ? g.label : "full stack";
    const count = g ? g.count : groups.reduce((s, x, i) => s + (wasOn[i] ? x.count : 0), 0);

    say(`<p class="note">measuring ${label}…</p>`);
    lines.pop(); // progress line: shown now, replaced by the result below
    const { ms, n, t, t2 } = await costPerPass();
    if (full === null) full = ms;

    say(
      `<div class="row"><span>${g ? g.label : "<b>full stack</b>"}</span>` +
        `<b>${ms.toFixed(2)} ms</b></div>` +
        `<div class="sub">${count.toLocaleString()} segments · ` +
        `${((ms / count) * 1e6).toFixed(1)} ns/segment · ` +
        `fit ${n}x=${t.toFixed(0)} ${n * 2}x=${t2.toFixed(0)}</div>`
    );
  }

  // The floor: same geometry, no fragments. Whatever is left is vertex and
  // setup cost, and only fewer segments (LOD) can move it.
  groups.forEach((g, i) => (g.on = wasOn[i]));
  vertexOnly = true;
  const floor = (await costPerPass()).ms;
  vertexOnly = false;
  ui.vertexOnly.checked = false;
  say(
    `<div class="row"><span>vertex floor</span><b>${floor.toFixed(2)} ms</b></div>` +
      `<div class="sub">${((floor / full) * 100).toFixed(0)}% of the full stack is ` +
      `vertex work · the other ${(full - floor).toFixed(2)} ms is fragments</div>`
  );

  const headroom = budget / full;
  const verdict =
    headroom >= 3
      ? ["go", "comfortable — C3 can double this and still hold"]
      : headroom >= 1.8
        ? ["tight", "holds, but C3's fills and ribbons need watching"]
        : headroom >= 1
          ? ["marginal", "holds alone; adding C3 on top will not"]
          : ["no", "does not hold at 1x"];

  say(
    `<div class="verdict ${verdict[0] === "go" ? "ok" : verdict[0] === "no" ? "bad" : "warn"}">` +
      `<b>${verdict[0].toUpperCase()}</b> — ${full.toFixed(2)} ms of a ` +
      `${budget.toFixed(1)} ms budget, ${headroom.toFixed(1)}x headroom<br>` +
      `<span>${verdict[1]}</span></div>` +
      `<p class="note">Zoom ${view.k.toFixed(1)}x · dpr ${view.dpr} · ` +
      `${view.width}x${view.height} px</p>`
  );

  ui.bench.disabled = false;
}

ui.bench.addEventListener("click", () => {
  runBenchmark().catch((e) => {
    ui.benchOut.textContent = String(e);
    ui.bench.disabled = false;
  });
});

// --------------------------------------------------------------- interaction

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
});
canvas.addEventListener("pointerup", () => (drag = null));
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.pan) {
    view.center[0] += dx * view.dpr;
    view.center[1] += dy * view.dpr;
  } else {
    // One sphere radius of travel is one radian of arc, at any zoom.
    const perPx = 180 / Math.PI / (sphereRadiusPx() / view.dpr);
    view.rotation[0] += dx * perPx;
    view.rotation[1] = Math.max(-90, Math.min(90, view.rotation[1] - dy * perPx));
  }
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.002);
    const next = Math.max(0.2, Math.min(manifest.maxZoom, view.k * f));
    const applied = next / view.k;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * view.dpr;
    const my = (e.clientY - rect.top) * view.dpr;
    view.center[0] = mx + (view.center[0] - mx) * applied;
    view.center[1] = my + (view.center[1] - my) * applied;
    view.k = next;
  },
  { passive: false }
);

for (const btn of document.querySelectorAll("[data-zoom]")) {
  btn.addEventListener("click", () => {
    view.k = +btn.dataset.zoom;
    view.center = [view.width / 2, view.height / 2];
    view.rotation = [...manifest.homeRotation, 0];
  });
}

ui.groups.innerHTML = groups
  .map(
    (g, i) =>
      `<label><input type="checkbox" data-group="${i}" checked> ${g.label} ` +
      `<span class="n">${g.count.toLocaleString()}</span></label>`
  )
  .join("");
ui.groups.addEventListener("change", (e) => {
  groups[+e.target.dataset.group].on = e.target.checked;
});
ui.passes.addEventListener("input", () => {
  ui.passesOut.textContent = `${ui.passes.value}x`;
});
ui.dpr.addEventListener("change", () => {
  view.dpr = ui.dpr.checked ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  resize();
});

// ------------------------------------------------------------------- startup

const dbg = gl.getExtension("WEBGL_debug_renderer_info");
document.getElementById("env").textContent =
  (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "renderer hidden") +
  ` — ${manifest.segments.toLocaleString()} segments, ${(raw.byteLength / 1048576).toFixed(1)} MB` +
  (timerExt ? "" : " — no GPU timer");

window.addEventListener("resize", resize);
resize();
updateRotation();
requestAnimationFrame(frame);
