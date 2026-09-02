// C5 — checks for the label layout.
//
// The layout is the whole of what C5 decides; the drawing is a rotated quad per
// glyph. So the layout is the part worth checking, and label-layout.js is
// deliberately free of WebGL so that it can run here.
//
// The one that matters is the third. Mercator magnifies by sec(latitude), and
// the label pipeline fits text against distances measured on the raster, so
// without a correction a name at 64N would be fitted against a canvas 2.3 times
// too generous and would come out 2.3 times the ground size of the same name at
// 25N. That is the plan's "Montana would render visibly larger than Arizona".
// The check measures the ground sizes that come out AND the ground sizes that
// would have come out uncorrected, so it can tell a working correction from a
// check that cannot fail.
//
// Run: node scripts/label-check.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { feature } from "topojson-client";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const readJson = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

// labels.js and label-layout.js both measure text through a canvas 2D context.
// Verdana advance widths at a 100px em, near enough that the fit behaves the
// way it does in a browser — the numbers below decide which names fit, not
// whether the metric this file is checking is right.
const W = {
  A: 68, B: 69, C: 68, D: 77, E: 63, F: 58, G: 78, H: 75, I: 42, J: 46, K: 69,
  L: 56, M: 84, N: 74, O: 79, P: 60, Q: 79, R: 70, S: 64, T: 62, U: 73, V: 68,
  W: 100, X: 66, Y: 62, Z: 62, " ": 35, "-": 41, ".": 35, "'": 25,
};
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      set font(_) {},
      measureText: (s) => ({ width: [...s].reduce((t, c) => t + (W[c] ?? 64), 0) }),
    }),
  }),
};

const { createLabelLayout, initialAssignment, RASTER_K } = await import(
  "../src/globe/label-layout.js"
);

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failures++;
};

const manifest = readJson("globe-geometry.json");
const globeScale = manifest.camera.globeScale;
const countyData = readJson("na-county-data.json");
const topo = readJson("na-counties-topo.json");
const units = feature(topo, topo.objects.counties).features.map((f) => ({
  id: f.id,
  st: f.properties?.st,
  polygons: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
}));

console.time("layout build");
const layout = createLabelLayout({ units, globeScale });
console.timeEnd("layout build");
console.log(
  `  raster ${layout.raster.width}x${layout.raster.height} = ` +
    `${(layout.raster.cells / 1e6).toFixed(2)}M cells at K=${(globeScale * RASTER_K).toFixed(0)}`
);

const { assign, stateInfo } = initialAssignment(units, countyData);
console.time("first layout");
layout.update({ assign, stateInfo, assignVersion: 1, labelsVersion: 1, visible: true });
console.timeEnd("first layout");

const labels = layout.labels;
const domestic = [...stateInfo].filter(([, i]) => !i.foreign).length;
console.log(`  ${labels.length} labels for ${domestic} home states, ${[...stateInfo].length} states in all`);
if (!labels.length) fail("no labels at all");

// ------------------------------------------------------------ 1. the frame

{
  const { toMerc, lonOfX, latOfY } = layout.frame;
  let worst = 0;
  for (let lon = -175; lon <= -50; lon += 3.7) {
    for (let lat = -5; lat <= 84; lat += 3.3) {
      const [x, y] = toMerc(lon, lat);
      worst = Math.max(worst, Math.abs(lonOfX(x) - lon), Math.abs(latOfY(y) - lat));
    }
  }
  console.log(`mercator round trip: worst ${worst.toExponential(1)} degrees`);
  if (!(worst < 1e-9)) fail(`the frame does not invert: ${worst} degrees`);
}

// ------------------------------------------------- 2. baselines on the sphere

{
  let worst = 0;
  let points = 0;
  for (const label of labels) {
    for (const run of label.runs) {
      for (let i = 0; i < run.xyz.length; i += 3) {
        const r = Math.hypot(run.xyz[i], run.xyz[i + 1], run.xyz[i + 2]);
        worst = Math.max(worst, Math.abs(r - 1));
        points++;
      }
      if (!(run.arc > 0)) fail(`${label.text}: a baseline with no length`);
    }
  }
  console.log(`baselines: ${points.toLocaleString()} points, worst radius error ${worst.toExponential(1)}`);
  if (!(worst < 1e-12)) fail(`a baseline point sits ${worst} off the unit sphere`);
}

// ------------------------------------ 3. ground size, and the Mercator stretch

{
  // Every size constant in labels.js: names 7..15 map units, abbreviations
  // 5.5..12, a leader label 8. A correctly converted size is inside that band
  // wherever on the raster it was fitted.
  const LO = 5.5;
  const HI = 15;
  const rows = labels.map((label) => {
    const z = label.runs[0].xyz[2];
    const lat = (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI;
    return { text: label.text, lat, size: label.mapSize, raw: label.mapSize / Math.cos((lat * Math.PI) / 180) };
  });
  const span = (f) => [Math.min(...rows.map(f)), Math.max(...rows.map(f))];
  const [sLo, sHi] = span((r) => r.size);
  const [rLo, rHi] = span((r) => r.raw);
  console.log(
    `ground size: ${sLo.toFixed(1)}..${sHi.toFixed(1)} map units ` +
      `(uncorrected it would be ${rLo.toFixed(1)}..${rHi.toFixed(1)})`
  );
  const bad = rows.filter((r) => r.size < LO - 0.01 || r.size > HI + 0.01);
  for (const r of bad.slice(0, 5))
    console.error(`  ${r.text} at ${r.lat.toFixed(0)}N: ${r.size.toFixed(2)} map units`);
  if (bad.length) fail(`${bad.length} labels are sized outside ${LO}..${HI} map units`);
  // And the control: if the correction were absent the same labels would break
  // that band, so the check above is one that can actually fail.
  if (rHi <= HI + 0.01)
    fail("the uncorrected sizes stay inside the caps, so check 3 proves nothing");

  const north = rows.filter((r) => r.lat > 55);
  const south = rows.filter((r) => r.lat < 35);
  const mean = (a) => (a.length ? a.reduce((s, r) => s + r.size, 0) / a.length : NaN);
  console.log(
    `  mean size north of 55N ${mean(north).toFixed(2)} (${north.length} labels), ` +
      `south of 35N ${mean(south).toFixed(2)} (${south.length})`
  );
  if (north.length && south.length) {
    const ratio = mean(north) / mean(south);
    if (ratio > 1.35 || ratio < 0.74)
      fail(`northern labels average ${ratio.toFixed(2)}x southern ones — the stretch is leaking through`);
  }
}

// ----------------------------------------------------- 4. every state labelled

{
  const labelled = new Set(labels.map((l) => l.text.replace(/\s+/g, " ")));
  const missing = [...stateInfo]
    .filter(([, i]) => !i.foreign)
    .map(([, i]) => i.name.toUpperCase())
    .filter((n) => !labelled.has(n));
  // A state too small for its name falls back to an abbreviation, so a miss
  // here is only a miss if the state got nothing at all.
  console.log(
    `${labels.length} labels placed; ${missing.length} home states carry an abbreviation instead` +
      (missing.length ? ` (${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""})` : "")
  );
  const leaders = labels.filter((l) => l.leader).length;
  console.log(`  ${leaders} of them are leader-line labels`);
  if (labels.length < domestic) fail(`${domestic - labels.length} home states got no label at all`);
}

// ------------------------------------------------ 5. the glyph distance field
//
// A wrong distance field does not throw; it draws soft, fat or hollow letters
// that look like a font problem. 8SSEDT is a propagation, so it can be exactly
// right almost everywhere and wrong in a corner — which is what brute force is
// for. (atlas.js touches no canvas until createGlyphAtlas runs, so this import
// is safe here.)

{
  const { edt } = await import("../src/globe/atlas.js");
  const rand = (() => {
    let s = 12345;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  })();

  let worst = 0;
  for (let trial = 0; trial < 6; trial++) {
    const w = 24 + Math.floor(rand() * 20);
    const h = 24 + Math.floor(rand() * 20);
    const inside = new Uint8Array(w * h);
    // A few overlapping discs — concave joins and thin waists are where a
    // propagation goes wrong, and letters are full of both.
    const discs = [];
    for (let i = 0; i < 3; i++)
      discs.push([rand() * w, rand() * h, 3 + rand() * Math.min(w, h) * 0.28]);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (const [cx, cy, r] of discs)
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r) inside[y * w + x] = 1;

    const got = edt(inside, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let best = Infinity;
        for (let b = 0; b < h; b++)
          for (let a = 0; a < w; a++)
            if (inside[b * w + a] !== inside[i]) best = Math.min(best, Math.hypot(a - x, b - y));
        const want = inside[i] ? best : -best;
        worst = Math.max(worst, Math.abs(got[i] - want));
      }
    }
  }
  console.log(`glyph distance field vs brute force: worst ${worst.toExponential(1)} texels`);
  if (!(worst < 1e-9)) fail(`the distance field is off by ${worst} texels`);
}

// ------------------------------------------------- 6. sub-texel edge accuracy
//
// The check above says the field is the exact distance to the nearest texel of
// the other class. That is not the same as the exact distance to the OUTLINE,
// and the gap is what a reader sees: a 1-bit mask can only put the outline on
// the texel grid, so the same stem comes out three texels wide in one place and
// four in another, and every curve carries the staircase of the raster.
//
// So this measures the thing that matters — where the drawn 0.5 isoline lands
// against an outline whose position is known exactly — and it measures the old
// threshold beside it, so a broken correction cannot pass by doing nothing.

{
  const { edt, fieldFromCoverage } = await import("../src/globe/atlas.js");

  // Coverage of each texel, supersampled. This is what canvas antialiasing
  // hands back, to within the browser's own contrast curve.
  const coverage = (w, h, isInk) => {
    const cov = new Float64Array(w * h);
    const SS = 16;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let b = 0; b < SS; b++)
          for (let a = 0; a < SS; a++)
            if (isInk(x - 0.5 + (a + 0.5) / SS, y - 0.5 + (b + 0.5) / SS)) n++;
        cov[y * w + x] = n / (SS * SS);
      }
    return cov;
  };
  const threshold = (cov) => {
    const bin = new Uint8Array(cov.length);
    for (let i = 0; i < cov.length; i++) bin[i] = cov[i] > 0.5 ? 1 : 0;
    return bin;
  };
  const sample = (f, w, h, x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const at = (i, j) => f[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
    return (
      at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty) +
      at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty
    );
  };
  // Where the field crosses zero along a ray, to well under a texel.
  const cross = (probe, lo, hi) => {
    if (probe(lo) < 0 || probe(hi) > 0) return null;
    for (let k = 0; k < 50; k++) {
      const m = (lo + hi) / 2;
      if (probe(m) > 0) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };

  const W = 60;
  const rms = { bin: 0, cov: 0 };
  const worstOf = { bin: 0, cov: 0 };
  let n = 0;
  // Radii and centres chosen so the outline meets the grid at every phase.
  for (const R of [8, 14, 22]) {
    for (const cx of [29.0, 29.37, 29.5]) {
      const cy = 29.13;
      const cov = coverage(W, W, (px, py) => Math.hypot(px - cx, py - cy) < R);
      const fields = {
        bin: edt(threshold(cov), W, W),
        cov: fieldFromCoverage(cov, W, W),
      };
      for (const [kind, f] of Object.entries(fields)) {
        for (let i = 0; i < 360; i++) {
          const ang = (i / 360) * Math.PI * 2;
          const r = cross((s) => sample(f, W, W, cx + Math.cos(ang) * s, cy + Math.sin(ang) * s), R - 3, R + 3);
          if (r === null) continue;
          rms[kind] += (r - R) ** 2;
          worstOf[kind] = Math.max(worstOf[kind], Math.abs(r - R));
          if (kind === "cov") n++;
        }
      }
    }
  }
  rms.bin = Math.sqrt(rms.bin / n);
  rms.cov = Math.sqrt(rms.cov / n);
  console.log(
    `outline placement on a known circle: ${rms.cov.toFixed(3)} texels RMS, ` +
      `worst ${worstOf.cov.toFixed(3)} (thresholded it would be ` +
      `${rms.bin.toFixed(3)} / ${worstOf.bin.toFixed(3)})`
  );
  if (!(rms.cov < 0.08)) fail(`the outline is ${rms.cov.toFixed(3)} texels off, want under 0.08`);
  if (!(rms.cov < rms.bin / 3))
    fail(`coverage seeding barely beats thresholding (${rms.cov.toFixed(3)} vs ${rms.bin.toFixed(3)})`);

  // A stem, because that is where the reader meets the error. A capital's main
  // stem is around 0.1 em, so four texels at EM 64, and it has to measure four
  // wherever it happens to fall between texel centres.
  let worstStem = 0;
  for (const shift of [0, 0.2, 0.4, 0.6, 0.8]) {
    const cov = coverage(W, W, (px) => px > 28 + shift && px < 32 + shift);
    const f = fieldFromCoverage(cov, W, W);
    // Both walks start inside the stem, so `cross` sees the sign fall either way.
    const probe = (x) => sample(f, W, W, x, 30);
    const width = cross(probe, 30, 34) - cross(probe, 30, 26);
    worstStem = Math.max(worstStem, Math.abs(width - 4));
  }
  console.log(`a 4-texel stem measures within ${worstStem.toFixed(3)} texels at every phase`);
  if (!(worstStem < 0.25)) fail(`stem width wanders by ${worstStem.toFixed(3)} texels`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall label checks passed");
process.exit(failures ? 1 : 0);
