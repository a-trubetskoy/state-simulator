// C5 — where the state names go, worked out once and kept in lon/lat.
//
// The layout is the one labels.js already does, run over a MERCATOR raster
// instead of the projected plane.
//
// Why Mercator. Steps 1-4 of that pipeline are shape work: connected
// components, a convex hull, PCA for the long axis, a least-squares quadratic
// for the baseline, and a march either side of it for clearance. All of that
// reads angles and proportions, and Mercator is conformal — it preserves them
// locally. Raw lon/lat does not: it stretches longitude by sec(latitude), which
// would tilt every long axis and squash every hull toward the horizontal.
//
// What Mercator costs, and what pays it back. Mercator is conformal but not
// equal-scale — it magnifies by sec(latitude) — so a name fitted in raster
// units at 71N would come out three times the ground size of the same name at
// the equator, and Montana would shout over Arizona for no reason. That is what
// labels.js's `sizeScale` is for: the size caps go in multiplied by the local
// stretch and the fitted size comes back divided by it, so what this module
// stores is a size in RADIANS OF ARC. Per frame that becomes pixels by one
// multiply against the sphere's radius, which is exactly what the old labels
// did by riding d3.zoom's transform.
//
// What this buys is the point of the rewrite: the layout now depends only on
// territory, not on the facing. Turning the globe used to invalidate every
// label, which is why they hide during a drag today and come back on the
// settle. Here a turn re-projects a few thousand baseline points.
//
// Nothing in this file touches the GPU or the DOM beyond one canvas for text
// measurement, so the whole of it runs under node — see scripts/label-check.mjs.

import { createStateLabeler } from "../labels.js";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// The raster's scale, as a fraction of the sphere's own. Half puts the grid at
// about 2.6 million cells — a shade under what the projected raster costs today
// (3.2M), because Mercator's tail toward the Canadian Arctic is expensive and
// the design box's own scale would take it to 10M. Every size constant in
// labels.js is in map units and is converted through `sizeScale`, so this
// number is a memory decision and nothing else.
export const RASTER_K = 0.5;

// North America, so the antimeridian sits behind the map rather than through
// it: the window is (-280, 80], which keeps the Aleutians continuous with the
// Alaskan mainland instead of flinging them to the far edge of the raster.
const LON0 = -100;

const MARGIN = 24; // raster cells of headroom for leader lines, as main.js uses

// The same measurement labels.js fits against — same font, same 100px em — so
// the width the layout reserved and the width the glyphs actually take are the
// same number.
const mctx = document.createElement("canvas").getContext("2d");
mctx.font = "100px Verdana, Geneva, Tahoma, sans-serif";

const runCache = new Map();
// Cumulative advance before each glyph, at 100px and no tracking. Measured on
// PREFIXES rather than per glyph, so whatever kerning the font applies is
// inside the numbers and the total matches measureText of the whole string.
export function advances(text) {
  let a = runCache.get(text);
  if (!a) {
    a = new Float64Array(text.length + 1);
    for (let i = 1; i <= text.length; i++) a[i] = mctx.measureText(text.slice(0, i)).width;
    runCache.set(text, a);
  }
  return a;
}

const toXyz = (lon, lat) => {
  const c = Math.cos(lat * RAD);
  return [c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD)];
};

export function createLabelLayout({ units, globeScale }) {
  const K = globeScale * RASTER_K;

  // ------------------------------------------------------------- the frame

  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
  // y runs DOWN, like every other screen coordinate labels.js works in — its
  // "near-vertical labels read upward" rule depends on that sign.
  const toMerc = (lon, lat) => [
    K * (lon - LON0) * RAD,
    -K * mercY(Math.max(-85, Math.min(85, lat))),
  ];
  const latOfY = (y) => (2 * Math.atan(Math.exp(-y / K)) - Math.PI / 2) * DEG;
  const lonOfX = (x) => LON0 + (x / K) * DEG;

  // A ring, wrapped into the window and then made continuous inside it, before
  // projecting. Without the second step a ring that steps across the window's
  // own edge would smear across the whole raster.
  function ringToMerc(ring) {
    const out = [];
    let lon = ring[0][0];
    while (lon > LON0 + 180) lon -= 360;
    while (lon <= LON0 - 180) lon += 360;
    out.push(toMerc(lon, ring[0][1]));
    for (let i = 1; i < ring.length; i++) {
      let d = ring[i][0] - ring[i - 1][0];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      lon += d;
      out.push(toMerc(lon, ring[i][1]));
    }
    return out;
  }

  const parts = [];
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const unit of units) {
    for (const poly of unit.polygons) {
      const rings = poly.map(ringToMerc);
      parts.push({ fips: unit.id, rings });
      for (const [x, y] of rings[0]) {
        if (x < bounds.x0) bounds.x0 = x;
        if (x > bounds.x1) bounds.x1 = x;
        if (y < bounds.y0) bounds.y0 = y;
        if (y > bounds.y1) bounds.y1 = y;
      }
    }
  }
  bounds.x0 -= MARGIN;
  bounds.y0 -= MARGIN;
  bounds.x1 += MARGIN;
  bounds.y1 += MARGIN;

  // The labeler works in grid coordinates, which are these shifted to the
  // raster's corner. Same two lines it uses itself; checked against what it
  // reports, since everything baked below is read through them.
  const gx = Math.floor(bounds.x0);
  const gy = Math.floor(bounds.y0);

  // ----------------------------------------------------------- the labeler

  let baked = [];
  const labeler = createStateLabeler({
    countyParts: parts,
    bounds,
    name: "globe",
    // Raster cells per map unit where this component sits. RASTER_K for the
    // grid's own scale, sec(latitude) for Mercator's stretch.
    sizeScale: (comp) => RASTER_K / Math.cos(latOfY(comp.my + gy) * RAD),
    onLayout: (labels) => {
      baked = labels.map(bake).filter(Boolean);
    },
  });
  if (labeler.origin[0] !== gx || labeler.origin[1] !== gy)
    throw new Error("the label raster's origin is not where the bake reads it");

  // --------------------------------------------------------------- the bake
  //
  // Out of the raster and onto the sphere. Baselines become unit-sphere xyz,
  // because that is what the camera multiplies; sizes become radians of arc,
  // because that is what survives a change of facing.

  const gridToXyz = ([x, y]) => toXyz(lonOfX(x + gx), latOfY(y + gy));

  function bakeRun(pts, text, spacing, scale) {
    const n = pts.length;
    const xyz = new Float64Array(n * 3);
    let arc = 0;
    for (let i = 0; i < n; i++) {
      const p = gridToXyz(pts[i]);
      xyz[i * 3] = p[0];
      xyz[i * 3 + 1] = p[1];
      xyz[i * 3 + 2] = p[2];
      if (i) {
        // Great-circle length, so the face-on length a foreshortened baseline
        // is compared against does not itself depend on the facing.
        const j = (i - 1) * 3;
        const dot = xyz[j] * p[0] + xyz[j + 1] * p[1] + xyz[j + 2] * p[2];
        arc += Math.acos(Math.max(-1, Math.min(1, dot)));
      }
    }
    return { text, xyz, arc, spacing: spacing / scale / globeScale };
  }

  function bake(label) {
    const scale = label.scale ?? 1;
    // Grid units -> map units -> radians of arc.
    const size = label.size / scale / globeScale;
    const common = { size, mapSize: label.size / scale, text: label.text };
    if (label.kind === "path")
      return { ...common, runs: [bakeRun(label.pts, label.text, label.spacing, scale)] };
    if (label.kind === "lines")
      return {
        ...common,
        text: label.lines.map((l) => l.text).join(" "),
        runs: label.lines.map((ln) => bakeRun(ln.pts, ln.text, ln.spacing, scale)),
      };
    if (label.kind === "leader") {
      // A leader's text is level in the raster, which on the sphere means along
      // the local parallel. Giving it a two-point baseline of its own width
      // puts it through the same placer as every curved label rather than
      // making it a second kind of thing — so it turns, foreshortens and clips
      // at the horizon like the rest of the map.
      const w =
        (advances(label.text)[label.text.length] / 100) * label.size +
        label.spacing * label.text.length;
      const run = bakeRun(
        [
          [label.cx - w / 2, label.cy],
          [label.cx + w / 2, label.cy],
        ],
        label.text,
        label.spacing,
        scale
      );
      const line =
        label.x1 === undefined
          ? null
          : { a: gridToXyz([label.x1, label.y1]), b: gridToXyz([label.x2, label.y2]) };
      return { ...common, runs: [run], line, leader: true };
    }
    return null;
  }

  return {
    /** Re-run the layout. Cheap when territory has not moved; see labels.js. */
    update: (args) => labeler.update(args),
    get labels() {
      return baked;
    },
    raster: {
      width: Math.ceil(bounds.x1) - gx,
      height: Math.ceil(bounds.y1) - gy,
      cells: (Math.ceil(bounds.x1) - gx) * (Math.ceil(bounds.y1) - gy),
    },
    frame: { toMerc, latOfY, lonOfX, gx, gy, K },
  };
}

/**
 * The two maps labels.js takes, built from the shipped county data: which state
 * each unit currently belongs to, and what that state is called. This is the
 * app's starting assignment — every county in its own real state.
 */
export function initialAssignment(units, data) {
  const assign = new Map();
  const stateInfo = new Map();
  const foreign = new Set(data.foreign ?? []);
  for (const unit of units) {
    const sid = unit.st ?? data.counties?.[unit.id]?.st;
    if (!sid) continue;
    assign.set(unit.id, sid);
    if (!stateInfo.has(sid)) {
      const name = data.states?.[sid] ?? sid;
      stateInfo.set(sid, { name, origName: name, foreign: foreign.has(sid) });
    }
  }
  return { assign, stateInfo };
}
