// C2 — development harness.
//
// Not the app. This exists so the renderer core can be looked at on its own,
// before C3 does styling parity and C7 wires up the real shell. Its job is to
// make three things visible: that every layer in the manifest draws, that the
// horizon comes out right, and where the band actually lands — which is what
// the tint checkbox is for, since the band is white on white counties without
// it.

import { loadGeometry, unitTriangles } from "./geometry.js";
import { createCamera } from "./camera.js";
import { createRenderer } from "./renderer.js";
import { loadUnits } from "./source.js";
import { createUnitIndex } from "./pick.js";
import { createGlobeLabels, initialAssignment } from "./labels.js";
import { createCarver, toXyz } from "./carve.js";
import { createUnitPool } from "./dynamic.js";

const canvas = document.getElementById("gl");
const errorBox = document.getElementById("error");

const fail = (e) => {
  errorBox.style.display = "block";
  errorBox.textContent = String(e && e.stack ? e.stack : e);
  throw e;
};

const gl = canvas.getContext("webgl2", {
  antialias: false, // lines and the horizon are analytically antialiased
  depth: false, //     painter's order, so there is nothing to depth test
  stencil: true, //    the aprons are clipped to the nation mesh
  alpha: false,
  powerPreference: "high-performance",
});
if (!gl) fail(new Error("WebGL2 unavailable"));

let geometry, camera, renderer, units, unitIndex, labels, carver, pool;
const timings = {};
try {
  geometry = await loadGeometry(gl);
  camera = createCamera(geometry.camera);
  renderer = createRenderer(gl, geometry, camera);
  // C4. The source rings, and the lon/lat index over them. Both are facts about
  // the data rather than about the facing, so this happens once.
  const countyData = await (await fetch("/data/na-county-data.json")).json();
  units = await loadUnits({ manifest: geometry.manifest });
  let t0 = performance.now();
  unitIndex = createUnitIndex(units);
  timings.index = performance.now() - t0;

  // C5. The label layout, over a Mercator raster of the same source rings.
  labels = createGlobeLabels(gl, { units, camera, globeScale: geometry.camera.globeScale });
  const { assign, stateInfo } = initialAssignment(units, countyData);
  t0 = performance.now();
  labels.update({ assign, stateInfo, assignVersion: 1, labelsVersion: 1, visible: true });
  timings.layout = performance.now() - t0;

  // C6. The knife. Everything it needs is already loaded except the tract files,
  // which are fetched per county on first cut and remembered — including the
  // "no data here" answer.
  const tractFiles = new Map();
  carver = createCarver({
    units,
    unitIndex,
    unitTris: (u) => unitTriangles(geometry, u),
    countyRows: countyData.counties,
    fetchTracts: async (fips) => {
      if (!tractFiles.has(fips)) {
        let payload = null;
        try {
          const res = await fetch(`/data/tracts/${fips}.json`);
          if (res.ok) payload = await res.json();
        } catch {
          // unreachable or malformed — remembered as no data
        }
        tractFiles.set(fips, payload);
      }
      return tractFiles.get(fips);
    },
  });
  pool = createUnitPool(renderer.firstPieceUnit, renderer.pieceUnits);
} catch (e) {
  fail(e);
}

// ------------------------------------------------------------------ palette

// A deterministic tint per unit, only so the palette and band paths are visible
// in the harness. C3 replaces this with the real colouring.
//
// The band gets the same hue deeper, which is what main.js does with it, and is
// also the only way to see where the band actually lands: untinted it is white
// on white counties, and a band that spills into the sea is the one thing that
// shows through anyway.
//
// Carved pieces are ALWAYS tinted, whatever the checkbox says, because the point
// of looking at a carve is to see where the pieces went. Their parent goes to
// zero alpha in the same pass, which is the whole of "hide the carved county":
// its triangles still rasterize and paint nothing, and the pieces drawn from the
// other buffer cover exactly the ground it had.
const WHITE = [255, 255, 255, 255];
const HIDDEN = [0, 0, 0, 0];
let tinted = false;

const hashOf = (seed) => {
  if (typeof seed === "number") return Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

function paint(unit, seed) {
  const hue = (hashOf(seed) % 360) / 360;
  renderer.setUnitColor(unit, [...hsl(hue, 0.45, 0.72), 255]);
  renderer.setBandColor(unit, [...hsl(hue, 0.7, 0.5), 255]);
}

// Every unit is its own state here, which is what makes the harness show a band
// and a border line along every county edge — the app's own painting collapses
// those into state borders (see main.js, paintGlobe). A hidden parent is given
// the outside sentinel so no line treats it as a neighbour.
function repaint() {
  const carved = new Set(carveState.pieces.map((p) => p.parent));
  for (let u = 0; u < geometry.unitCount; u++) {
    if (carved.has(u)) {
      renderer.setUnitColor(u, HIDDEN);
      renderer.setBandColor(u, HIDDEN);
      renderer.setUnitOwner(u, 0xffff);
    } else {
      if (tinted) paint(u, u);
      else {
        renderer.setUnitColor(u, WHITE);
        renderer.setBandColor(u, WHITE);
      }
      renderer.setUnitOwner(u, u);
    }
  }
  for (const p of carveState.pieces) {
    paint(p.unit, p.id);
    renderer.setUnitOwner(p.unit, p.unit);
  }
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

// ------------------------------------------------------------------- resize

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  camera.resize(rect.width, rect.height, dpr);
  canvas.width = camera.view.width;
  canvas.height = camera.view.height;
}
window.addEventListener("resize", resize);
resize();

// --------------------------------------------------------------- C4: picking

// Two steps and no GPU: invert the camera to get a lon/lat, then ask the index
// which unit owns it. That is the whole of it — main.js defers picking to the
// next frame because ITS pick reads a pixel back off the GPU and is only worth
// doing once a frame; this one is half a microsecond and can run per event.
const hover = { at: null, unit: -1, base: -1, piece: null };

function pickAt(cssX, cssY) {
  hover.at = cssX === null ? null : camera.unproject(cssX, cssY);
  const base = hover.at ? unitIndex.at(hover.at[0], hover.at[1]) : -1;
  // A carved county answers to its pieces. The index still finds the parent —
  // it is built from the source rings and no carve touches those — so the piece
  // is a second, tiny lookup down the county's own cut tree.
  const leaf = base >= 0 && hover.at ? carver.pieceAt(base, hover.at[0], hover.at[1]) : null;
  hover.base = base;
  hover.piece = leaf ? carveState.byId.get(leaf.id) ?? null : null;
  hover.unit = hover.piece ? hover.piece.unit : base;
  renderer.setHover(hover.unit);
}

// ------------------------------------------------------------------ C6: carve

const carveState = { pieces: [], byId: new Map(), note: "", busy: false };
repaint();

// Everything the renderer knows about carving, rebuilt from the model. Units are
// handed out here rather than inside the model, because "which texel is this
// piece" is a fact about the palette and not about the ground.
function syncCarves() {
  const pieces = carver.pieces();
  pool.sync(pieces.map((p) => p.id));
  carveState.pieces = pieces.map((p) => ({ ...p, unit: pool.unitOf(p.id) }));
  carveState.byId = new Map(carveState.pieces.map((p) => [p.id, p]));

  renderer.setCarved(
    carveState.pieces,
    carver.dividers().map((d) => ({
      xyz: d.xyz,
      left: carveState.byId.get(d.a)?.unit ?? 0xffff,
      right: carveState.byId.get(d.b)?.unit ?? 0xffff,
    }))
  );
  repaint();
}

// -------------------------------------------------------------- interaction

let drag = null;
let stroke = null;

const strokeSegments = (pts) =>
  pts.slice(1).map((p, i) => ({ xyz: [toXyz(pts[i]), toXyz(p)], left: 0xffff, right: 0xfffe }));

// A point every few CSS pixels, measured on SCREEN rather than on the ground.
// The ground distance a pixel covers runs from 4.7 km at the home view to 295 m
// at the deepest zoom, so a threshold in degrees would either record a point per
// pixel when zoomed out or lose the shape of the line when zoomed in.
const STROKE_STEP = 2.5;

function addPoint(px, py, force) {
  if (!stroke) return;
  if (!force && Math.hypot(px - stroke.lastPx[0], py - stroke.lastPx[1]) < STROKE_STEP) return;
  const at = camera.unproject(px, py);
  if (!at) return;
  stroke.pts.push(at);
  stroke.lastPx = [px, py];
}

function beginStroke(px, py) {
  const at = camera.unproject(px, py);
  if (!at) return false;
  stroke = { pts: [at], lastPx: [px, py] };
  renderer.setKnife([]);
  return true;
}

async function endStroke(px, py) {
  // The release position, whether or not it cleared the step: the whole premise
  // of the default carve is that the boundary IS the line the user drew, so it
  // should end where they let go.
  if (px != null) addPoint(px, py, true);
  const pts = stroke?.pts;
  stroke = null;
  renderer.setKnife([]);
  if (!pts || pts.length < 2 || carveState.busy) return;
  carveState.busy = true;
  try {
    const res = await carver.carve(pts, { keepTractsIntact: ui.intact.checked });
    if (res.carved.length) syncCarves();
    carveState.note = res.rejected
      ? `Refused: ${res.rejected}.`
      : res.carved.length
        ? `Carved ${res.carved.join(", ")}.`
        : "Nothing was sliced — draw in one side of a county and out the other.";
    if (res.noData?.length) carveState.note += ` No tract data for ${res.noData.join(", ")}.`;
    if (res.full?.length) carveState.note += ` ${res.full.join(", ")} is carved as fine as it goes.`;
  } catch (err) {
    carveState.note = `Failed: ${err.message}`;
  } finally {
    carveState.busy = false;
  }
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  if (ui.carve.checked && e.button === 0 && !e.shiftKey) {
    if (beginStroke(e.clientX - rect.left, e.clientY - rect.top)) return;
  }
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
});
canvas.addEventListener("pointerup", (e) => {
  if (stroke) {
    const rect = canvas.getBoundingClientRect();
    endStroke(e.clientX - rect.left, e.clientY - rect.top);
  }
  drag = null;
});
canvas.addEventListener("pointercancel", () => {
  stroke = null;
  renderer.setKnife([]);
  drag = null;
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  if (stroke) {
    addPoint(e.clientX - rect.left, e.clientY - rect.top, false);
    renderer.setKnife(strokeSegments(stroke.pts));
  } else if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) camera.panByPixels(dx, dy);
    else camera.rotateByPixels(dx, dy);
  }
  // After the gesture is applied, and deliberately not suppressed while one is
  // in flight: the deck.gl path has to pause picking during a pan or a wheel
  // because every pick reads a pixel back off the GPU, and this one does not.
  pickAt(e.clientX - rect.left, e.clientY - rect.top);
});
canvas.addEventListener("pointerleave", () => pickAt(null));
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    camera.zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left, e.clientY - rect.top);
  },
  { passive: false }
);

for (const btn of document.querySelectorAll("[data-zoom]")) {
  btn.addEventListener("click", () => {
    camera.reset();
    const k = +btn.dataset.zoom;
    if (k !== 1) camera.zoomAt(k, camera.view.cssWidth / 2, camera.view.cssHeight / 2);
  });
}

// ---------------------------------------------------------------- the panel

const ui = {
  spin: document.getElementById("spin"),
  tint: document.getElementById("tint"),
  labels: document.getElementById("labels-on"),
  readout: document.getElementById("readout"),
  pick: document.getElementById("pick"),
  layers: document.getElementById("layers"),
  carve: document.getElementById("carve-on"),
  intact: document.getElementById("carve-intact"),
  carveOut: document.getElementById("carve-out"),
  carveNote: document.getElementById("carve-note"),
};

ui.tint.addEventListener("change", () => {
  tinted = ui.tint.checked;
  repaint();
});

// Arming the knife takes the drag gesture away from the camera, so it says so
// with the cursor rather than leaving it to be discovered.
ui.carve.addEventListener("change", () => {
  canvas.style.cursor = ui.carve.checked ? "crosshair" : "";
});

// The hovered piece, as the entry a file would carry. This is the format C6
// settled on: the cuts that reach the piece and which side of each, with the
// tracts it touches alongside for a person to read.
document.getElementById("carve-copy").addEventListener("click", () => {
  const id = hover.piece?.id;
  const entry = id && carver.serialize(id);
  if (!entry) {
    carveState.note = "Hover a carved piece first.";
    return;
  }
  const text = JSON.stringify(entry, null, 2);
  navigator.clipboard?.writeText(text);
  console.log(text);
  carveState.note = `Copied ${id} — ${JSON.stringify(entry).length} bytes.`;
});

document.getElementById("carve-reset").addEventListener("click", () => {
  carver.reset();
  syncCarves();
  carveState.note = "Every county whole again.";
});
// The scene texture cannot tell that the label pass was switched on or off, so
// say so — every other control here invalidates through the renderer already.
ui.labels.addEventListener("change", () => renderer.invalidate());

const count = (l) => {
  if (l.kind === "line") {
    const names = Array.isArray(l.group) ? l.group : [l.group];
    return names.reduce((s, n) => s + geometry.lines[n].count, 0);
  }
  if (l.kind === "fill" || l.kind === "band") return geometry.fills[l.group].indexCount / 3;
  return "";
};

// The list is painter's order, top of the list drawn first. Dragging a row
// rearranges renderer.layers directly, which is the only thing that decides
// what covers what — so this panel is the whole experiment, and a arrangement
// worth keeping gets copied back into layers.js by hand.
function renderLayers() {
  ui.layers.innerHTML = renderer.layers
    .map(
      (l, i) =>
        `<div class="layer" draggable="true" data-layer="${i}">` +
        `<span class="grip">⠿</span>` +
        `<label><input type="checkbox" data-layer="${i}"${l.enabled ? " checked" : ""}>` +
        `${l.name ?? (Array.isArray(l.group) ? l.group.join(" + ") : l.group)}</label>` +
        `<span class="n">${(count(l) || "").toLocaleString()}</span>` +
        `</div>`
    )
    .join("");
}
renderLayers();

ui.layers.addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  renderer.setLayerEnabled(+e.target.dataset.layer, e.target.checked);
});

// HTML5 drag and drop. The row under the pointer gets a line on the edge the
// dragged row would land on, so the drop position is never a guess.
let dragFrom = null;
const rowAt = (t) => t.closest?.(".layer");

ui.layers.addEventListener("dragstart", (e) => {
  const row = rowAt(e.target);
  if (!row) return;
  dragFrom = +row.dataset.layer;
  row.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(dragFrom)); // Firefox needs a payload
});

ui.layers.addEventListener("dragover", (e) => {
  const row = rowAt(e.target);
  if (dragFrom === null || !row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const r = row.getBoundingClientRect();
  const below = e.clientY > r.top + r.height / 2;
  for (const el of ui.layers.children) el.classList.remove("over-top", "over-bottom");
  row.classList.add(below ? "over-bottom" : "over-top");
});

ui.layers.addEventListener("drop", (e) => {
  const row = rowAt(e.target);
  if (dragFrom === null || !row) return;
  e.preventDefault();
  const r = row.getBoundingClientRect();
  const target = +row.dataset.layer + (e.clientY > r.top + r.height / 2 ? 1 : 0);
  // Removing the dragged row first shifts every later index down by one.
  renderer.moveLayer(dragFrom, target > dragFrom ? target - 1 : target);
  dragFrom = null;
  renderLayers();
});

const endDrag = () => {
  dragFrom = null;
  for (const el of ui.layers.children) el.classList.remove("dragging", "over-top", "over-bottom");
};
ui.layers.addEventListener("dragend", endDrag);
ui.layers.addEventListener("dragleave", (e) => {
  if (!ui.layers.contains(e.relatedTarget)) endDrag();
});

// Prints the current arrangement as the buildLayers() body, ready to paste.
document.getElementById("dump").addEventListener("click", () => {
  const src = renderer.layers
    .map((l) => {
      const g = Array.isArray(l.group) ? `[${l.group.map((s) => `"${s}"`).join(", ")}]` : `"${l.group}"`;
      const off = l.enabled ? "" : "   // OFF";
      if (l.kind === "disc") return `  { kind: "disc", ... },${off}`;
      if (l.kind === "band") return `  { kind: "band", name: "band", group: ${g}, width: BAND_WIDTH },${off}`;
      if (l.kind === "fill") return `  fill(${g}, ...),${off}`;
      return `  line(${g}, ..., ${l.width}),${off}`;
    })
    .join("\n");
  console.log(src);
  navigator.clipboard?.writeText(src);
});

// ----------------------------------------------------------------- the loop

const stats = { frame: [], labels: [], scene: [], hoverOnly: [] };
const push = (a, v) => {
  a.push(v);
  if (a.length > 180) a.shift();
};
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

let last = performance.now();
function frame(now) {
  push(stats.frame, now - last);
  last = now;

  if (ui.spin.checked) {
    camera.view.rotation[0] -= 0.35;
    camera.updateMatrix();
  }

  const t0 = performance.now();
  renderer.draw(ui.labels.checked ? drawLabels : undefined);
  push(renderer.stats.redrew ? stats.scene : stats.hoverOnly, performance.now() - t0);

  requestAnimationFrame(frame);
}

// Inside the scene pass, so it runs only on a frame that redraws the map — the
// labels move when the map moves and at no other time. That is also why they
// need no caching of their own: the renderer's own dirty check gates them.
function drawLabels() {
  const t0 = performance.now();
  labels.prepare();
  push(stats.labels, performance.now() - t0);
  labels.draw();
}

const fmt = (v) => (v == null ? "--" : v.toFixed(2));

// How many of a piece's tracts it holds only part of — the count that is zero in
// every carve the deck.gl app could make, and the point of this one.
const splitCount = (piece) => [...piece.weights.values()].filter((w) => w < 0.999999).length;

setInterval(() => {
  const f = pct(stats.frame, 0.5);
  const s = renderer.stats;
  const u = hover.base >= 0 ? units[hover.base] : null;
  ui.pick.innerHTML = [
    ["lon, lat", hover.at ? hover.at.map((v) => v.toFixed(3)).join(", ") : "off the disc"],
    ["unit", hover.piece ? hover.piece.name : u ? `${u.name} (${u.id})` : "—"],
    ["id", hover.piece ? hover.piece.id : hover.unit >= 0 ? hover.unit : "—"],
  ]
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join("");

  const p = hover.piece;
  const counties = carver.carves.size;
  ui.carveOut.innerHTML = [
    ["carved counties", counties],
    ["pieces", carveState.pieces.length],
    ["piece triangles", carveState.pieces.reduce((s, q) => s + q.xyz.length, 0).toLocaleString()],
    // What the hovered piece actually came out with — the numbers the whole
    // apportionment exists to produce.
    ["hovered population", p?.row?.pop != null ? p.row.pop.toLocaleString() : "—"],
    ["hovered area", p ? `${p.km2.toFixed(1)} km²` : "—"],
    ["hovered tracts", p ? `${p.weights.size} (${splitCount(p)} split)` : "—"],
  ]
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join("");
  ui.carveNote.textContent = carveState.note;
  ui.readout.innerHTML = [
    ["frame p50 / p95", `${fmt(f)} / ${fmt(pct(stats.frame, 0.95))} ms`],
    ["fps", f ? (1000 / f).toFixed(0) : "--"],
    ["zoom k", `${camera.view.k.toFixed(2)} (${camera.radiusPx().toFixed(0)} px)`],
    ["rotation", camera.view.rotation.slice(0, 2).map((r) => r.toFixed(0)).join(", ")],
    ["draw calls", s.drawCalls],
    ["instances", s.instances.toLocaleString()],
    ["triangles", s.triangles.toLocaleString()],
    ["labels p50", `${fmt(pct(stats.labels, 0.5))} ms`],
    ["glyphs drawn", labels.stats.glyphs.toLocaleString()],
    // The two kinds of frame, side by side. A hover-only frame is a blit and
    // one county; a scene frame redraws the map. The gap between them is the
    // whole reason the tint used to trail the cursor when zoomed out.
    ["scene frame", `${fmt(pct(stats.scene, 0.5))} ms`],
    ["hover-only frame", `${fmt(pct(stats.hoverOnly, 0.5))} ms`],
  ]
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join("");
}, 250);

const dbg = gl.getExtension("WEBGL_debug_renderer_info");
document.getElementById("env").textContent =
  (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "renderer hidden") +
  ` — ${geometry.stats.segments.toLocaleString()} segments, ` +
  `${geometry.stats.triangles.toLocaleString()} triangles, ` +
  `${(geometry.byteLength / 1048576).toFixed(1)} MB`;

// The one-off costs, which are the ones that would otherwise go unnoticed: both
// happen before the first frame and neither recurs on a turn.
document.getElementById("startup").textContent =
  `pick index ${timings.index.toFixed(0)} ms · ` +
  `label layout ${timings.layout.toFixed(0)} ms over a ` +
  `${labels.raster.width}x${labels.raster.height} raster · ` +
  `${labels.stats.labels} labels, ${labels.stats.atlas.glyphs} glyphs in the atlas` +
  (labels.stats.atlas.overflowed ? " (ATLAS FULL)" : "");

requestAnimationFrame(frame);
