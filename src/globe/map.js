// C7 — the globe renderer as the app's map.
//
// Everything under src/globe up to here answers to a harness. This file is the
// one seam between it and src/main.js: the app keeps the model, the stats, the
// sidebar, the presets and the two inset boxes, and hands this module three
// kinds of thing.
//
//   where the camera is    setTransform, from the same d3.zoom transform the
//                          deck path has always used, plus a facing.
//   who owns what          paint(), which writes three texels per unit and
//                          nothing else. No geometry moves when a county is
//                          painted, turned, selected or dimmed.
//   what the pointer is on pickAt(), a ray-sphere inverse and a lon/lat index.
//
// The conversion in setTransform is the whole reason this drops in. main.js
// works in a 975x610 design box and lets an SVG viewBox fit it to the canvas;
// the camera here was built against the same box, from the same
// d3.geoOrthographic fit, so a d3.zoom (k, x, y) maps onto (zoom, pan) exactly
// rather than approximately — one line each, derived below.
//
// Two things the app used to read off the projected geometry come back out of
// here instead, because on the sphere there is no projected geometry to read:
// per-unit centroids for the data view's symbols and labels, and the extent of
// the land for the zoom's lower bound. Both are cheap per facing and neither
// needs a bake.

import { loadGeometry, unitTriangles } from "./geometry.js";
import { createCamera } from "./camera.js";
import { createRenderer } from "./renderer.js";
import { loadUnits } from "./source.js";
import { createUnitIndex } from "./pick.js";
import { createGlobeLabels } from "./labels.js";
import { createCarver, toXyz } from "./carve.js";
import { createUnitPool } from "./dynamic.js";
import { COLORS } from "./layers.js";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * @param canvas    the map canvas, which this module owns outright
 * @param features  the county features main.js has already decoded
 * @param carve     { countyRows, fetchTracts } — what C6's carver needs from
 *                  the app: the published county rows its allocations divide,
 *                  and the per-county tract loader (which is also where the
 *                  app says no — a county in an inset box, a foreign unit)
 */
export async function createGlobeMap({ canvas, features, carve: carveOpts }) {
  const gl = canvas.getContext("webgl2", {
    antialias: false, // lines and the horizon are analytically antialiased
    depth: false, //     painter's order, so there is nothing to depth test
    stencil: true, //    the band and the seam aprons both need it
    alpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 unavailable");

  const geometry = await loadGeometry(gl);
  const camera = createCamera(geometry.camera);
  const renderer = createRenderer(gl, geometry, camera);
  const units = await loadUnits({ manifest: geometry.manifest, features });
  const unitIndex = createUnitIndex(units);
  const labels = createGlobeLabels(gl, {
    units,
    camera,
    globeScale: geometry.camera.globeScale,
  });

  const unitOf = new Map(units.map((u, i) => [u.id, i]));
  const { globeScale, globeTranslate, homeRotation } = geometry.camera;

  // ------------------------------------------------------- the design box
  //
  // main.js's 975x610 space. The renderer never uses it — it works in device
  // pixels — but everything the app still draws in SVG over the map does, so
  // anything handed back to main.js is converted here and nowhere else.

  // matrix64 is column-major, so row r of the forward rotation is m[r],
  // m[r + 3], m[r + 6].
  const toDesign = (p, m) => [
    globeTranslate[0] + (m[1] * p[0] + m[4] * p[1] + m[7] * p[2]) * globeScale,
    globeTranslate[1] - (m[2] * p[0] + m[5] * p[1] + m[8] * p[2]) * globeScale,
  ];
  const facing = (p, m) => m[0] * p[0] + m[3] * p[1] + m[6] * p[2];

  // ------------------------------------------------------ per-unit geometry
  //
  // Two facts about each unit that the deck path read off the projected parts
  // (computeCountyGeo) and that nothing on the sphere produces for free: where
  // the unit sits, and how much ground it covers. Both are computed once, from
  // the compiled fill triangles rather than the source rings, so a unit's
  // anchor is inside the shape the renderer actually draws.
  //
  // The weight is the flat triangle's area rather than the spherical one. At
  // the compiler's 120 km refinement the two differ by about one part in 10^4,
  // and this only ever decides where a label sits among its neighbours.
  const centroidXyz = new Float64Array(geometry.unitCount * 3);
  const unitArea = new Float64Array(geometry.unitCount);
  {
    const P = geometry.countyPositions;
    const I = geometry.countyIndices;
    const base = geometry.countyFirstVertex;
    for (let u = 0; u < geometry.unitCount; u++) {
      const first = geometry.unitIndexRange[u * 2] - geometry.countyFirstIndex;
      const count = geometry.unitIndexRange[u * 2 + 1];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let total = 0;
      for (let k = first; k < first + count; k += 3) {
        const a = (I[k] - base) * 3;
        const b = (I[k + 1] - base) * 3;
        const c = (I[k + 2] - base) * 3;
        const ux = P[b] - P[a];
        const uy = P[b + 1] - P[a + 1];
        const uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a];
        const vy = P[c + 1] - P[a + 1];
        const vz = P[c + 2] - P[a + 2];
        const area =
          0.5 *
          Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (!area) continue;
        cx += ((P[a] + P[b] + P[c]) / 3) * area;
        cy += ((P[a + 1] + P[b + 1] + P[c + 1]) / 3) * area;
        cz += ((P[a + 2] + P[b + 2] + P[c + 2]) / 3) * area;
        total += area;
      }
      const len = Math.hypot(cx, cy, cz) || 1;
      centroidXyz[u * 3] = cx / len;
      centroidXyz[u * 3 + 1] = cy / len;
      centroidXyz[u * 3 + 2] = cz / len;
      // In design units squared, so the numbers stay the size the data view's
      // collision rules were tuned against.
      unitArea[u] = total * globeScale * globeScale;
    }
  }

  // A coarse point cloud over every unit's outline, for the zoom's lower bound.
  // The bound is "fit the land now in view", and the deck path recomputed it
  // from the whole projected map after every bake; eight points per ring is
  // three orders of magnitude less work and lands within a pixel of the same
  // answer, because a bound only cares about the extremes.
  const hull = (() => {
    const out = [];
    for (const u of units) {
      for (const poly of u.polygons) {
        const ring = poly[0];
        const step = Math.max(1, Math.floor(ring.length / 8));
        for (let i = 0; i < ring.length; i += step) {
          const [lon, lat] = ring[i];
          const c = Math.cos(lat * RAD);
          out.push(c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD));
        }
      }
    }
    return new Float64Array(out);
  })();

  // ------------------------------------------------------------- the camera

  function resize(cssWidth, cssHeight) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    camera.resize(cssWidth, cssHeight, dpr);
    // The backing store only, in device pixels. The element's CSS size is the
    // map box's, via the stylesheet's width/height: 100% — inset: 0 alone
    // would not do it, because a replaced element with auto width lays out at
    // its intrinsic (backing-store) size instead of stretching.
    canvas.width = camera.view.width;
    canvas.height = camera.view.height;
  }

  // d3.zoom's transform, in design-box coordinates, onto the camera's own zoom
  // and pan. The app's screen position of a design point is
  //
  //   css = (design * k + t) * fit + offset
  //
  // and the camera puts the globe's centre at homeCenter + pan, where
  // homeCenter is (offset + globeTranslate * fit) * dpr. Substituting the
  // globe's centre for `design` and solving for pan gives the two lines below;
  // the radius agrees already, since both are globeScale * k * fit.
  function setTransform(t) {
    const v = camera.view;
    const f = v.fit * v.dpr;
    v.k = t.k;
    v.pan[0] = f * (globeTranslate[0] * (t.k - 1) + t.x);
    v.pan[1] = f * (globeTranslate[1] * (t.k - 1) + t.y);
    v.version++;
  }

  function setRotation([lambda, phi]) {
    camera.view.rotation[0] = lambda;
    camera.view.rotation[1] = Math.max(-90, Math.min(90, phi));
    camera.updateMatrix();
  }

  // A design-box point back to lon/lat — the same closed-form inverse as
  // camera.unproject, one space earlier: the knife is drawn on the overlay SVG
  // in design coordinates, and a cut is a fact about the ground.
  function unprojectDesign([px, py]) {
    const y = (px - globeTranslate[0]) / globeScale;
    const z = -(py - globeTranslate[1]) / globeScale;
    const r2 = y * y + z * z;
    if (r2 > 1) return null;
    const x = Math.sqrt(1 - r2);
    const m = camera.matrix64;
    const lon = Math.atan2(m[3] * x + m[4] * y + m[5] * z, m[0] * x + m[1] * y + m[2] * z) / RAD;
    const lat = Math.asin(Math.max(-1, Math.min(1, m[6] * x + m[7] * y + m[8] * z))) / RAD;
    return [lon, lat];
  }

  // ------------------------------------------------------------------ carving
  //
  // C8 — C6's carver joined to the renderer. The carver owns the model (the
  // cuts, the piece tree, the allocated rows); this bridge owns everything the
  // renderer has to agree with it about: which palette texel each piece is
  // (the unit pool), the dynamic fill and divider buffers, and the sides of
  // the COMPILED line segments, which still name the retired parent and are
  // patched to the pieces below. main.js drives the app model (assign, rows,
  // adjacency) from what sync() returns.

  const registry = { pieces: [], byId: new Map(), byFips: new Map() };
  let carver = null;
  let carveApi = null;

  if (carveOpts) {
    carver = createCarver({
      units,
      unitIndex,
      unitTris: (u) => unitTriangles(geometry, u),
      countyRows: carveOpts.countyRows,
      fetchTracts: carveOpts.fetchTracts,
    });
    const pool = createUnitPool(renderer.firstPieceUnit, renderer.pieceUnits);

    // ------------------------------------------- re-owning the compiled sides
    //
    // Every line instance carries the unit on its left and right, and the
    // band, the grey state border and the selection outline all read the two
    // sides' STATES off those ids. A carved county's outer boundary still
    // names the parent, which after a carve is in no state at all — so its
    // border would drop out of all three. Each segment naming a carved parent
    // is therefore re-owned to the piece under its midpoint, and restored when
    // the county is rejoined.
    //
    // The midpoint sits ON the county's boundary, and that is fine: the cut
    // tree partitions the whole plane, so any point near the boundary answers
    // "which side of each cut" correctly except within a segment of where a
    // cut actually crosses the boundary — and that one segment has to pick a
    // side whatever we do, since a compiled segment cannot be split.
    //
    // A segment that names the parent on BOTH sides is the nation's own edge
    // (C1's marker, which skipEqual keys on); both sides move to the same
    // piece, so the marker survives re-owning.
    const pristine = { left: geometry.lineLeft, right: geometry.lineRight };
    const current = { left: pristine.left.slice(), right: pristine.right.slice() };
    let sideIndex = null; //   unit -> sorted segment indices naming it
    const segMids = new Map(); // unit -> unit-sphere midpoint per such segment
    let patchedSegs = new Set();

    function buildSideIndex() {
      const lists = new Map();
      const note = (arr) => {
        for (let i = 0; i < arr.length; i++) {
          const u = arr[i];
          if (u >= geometry.unitCount) continue; // the two sentinels
          let l = lists.get(u);
          if (!l) lists.set(u, (l = new Set()));
          l.add(i);
        }
      };
      note(pristine.left);
      note(pristine.right);
      sideIndex = new Map([...lists].map(([u, l]) => [u, Uint32Array.from(l).sort()]));
    }

    // The segments' endpoints live only on the GPU (the 10 MB CPU copy they
    // would otherwise cost buys nothing else), so the midpoints of one
    // county's few hundred segments are read back once, on its first carve.
    // The stall is real and it is paid beside an 18 ms cut, not per frame.
    function midsFor(unit) {
      let mids = segMids.get(unit);
      if (mids) return mids;
      const idx = sideIndex.get(unit) ?? new Uint32Array(0);
      mids = new Float64Array(idx.length * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.attribBuffer);
      let i = 0;
      while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1] - idx[j] <= 32) j++;
        const first = idx[i];
        const count = idx[j] - first + 1;
        const start = new Float32Array(count * 3);
        const end = new Float32Array(count * 3);
        gl.getBufferSubData(gl.ARRAY_BUFFER, geometry.offsets.lineStart + first * 12, start);
        gl.getBufferSubData(gl.ARRAY_BUFFER, geometry.offsets.lineEnd + first * 12, end);
        for (let k = i; k <= j; k++) {
          const o = (idx[k] - first) * 3;
          const mx = start[o] + end[o];
          const my = start[o + 1] + end[o + 1];
          const mz = start[o + 2] + end[o + 2];
          const len = Math.hypot(mx, my, mz) || 1;
          mids[k * 3] = mx / len;
          mids[k * 3 + 1] = my / len;
          mids[k * 3 + 2] = mz / len;
        }
        i = j + 1;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      segMids.set(unit, mids);
      return mids;
    }

    function reownStaticSides() {
      if (!sideIndex) {
        if (!carver.carves.size) return;
        buildSideIndex();
      }
      // What every touched segment should carry now, derived from scratch each
      // sync — the same wholesale-not-patched rule the dynamic buffers follow.
      const desired = new Map();
      for (const [unit, c] of carver.carves) {
        if (!c.root || !c.pieces.length) continue;
        const idx = sideIndex.get(unit) ?? new Uint32Array(0);
        const mids = midsFor(unit);
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k];
          const x = mids[k * 3];
          const y = mids[k * 3 + 1];
          const z = mids[k * 3 + 2];
          const leaf = carver.pieceAt(unit, Math.atan2(y, x) * DEG, Math.atan2(z, Math.hypot(x, y)) * DEG);
          const pu = leaf && registry.byId.get(leaf.id)?.unit;
          if (pu == null) continue;
          const pair = desired.get(i) ?? [pristine.left[i], pristine.right[i]];
          if (pristine.left[i] === unit) pair[0] = pu;
          if (pristine.right[i] === unit) pair[1] = pu;
          desired.set(i, pair);
        }
      }
      // A segment patched last time and not wanted now goes back to what the
      // compiler wrote — that is the whole of undoing a rejoined county.
      for (const i of patchedSegs) {
        if (!desired.has(i)) desired.set(i, [pristine.left[i], pristine.right[i]]);
      }
      const uploads = [];
      const nextPatched = new Set();
      for (const [i, [l, r]] of desired) {
        if (l !== pristine.left[i] || r !== pristine.right[i]) nextPatched.add(i);
        if (current.left[i] !== l || current.right[i] !== r) {
          current.left[i] = l;
          current.right[i] = r;
          uploads.push(i);
        }
      }
      patchedSegs = nextPatched;
      if (!uploads.length) return;
      uploads.sort((a, b) => a - b);
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.attribBuffer);
      let i = 0;
      while (i < uploads.length) {
        let j = i;
        while (j + 1 < uploads.length && uploads[j + 1] - uploads[j] <= 32) j++;
        const first = uploads[i];
        const count = uploads[j] - first + 1;
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          geometry.offsets.lineLeft + first * 2,
          current.left.subarray(first, first + count)
        );
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          geometry.offsets.lineRight + first * 2,
          current.right.subarray(first, first + count)
        );
        i = j + 1;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      renderer.invalidate();
    }

    // ------------------------------------------------------- the sync itself

    // Everything the renderer knows about carving, rebuilt from the model.
    // Palette units are handed out here rather than inside the carver, because
    // "which texel is this piece" is a fact about the renderer, not the ground.
    function syncCarved() {
      const pieces = carver.pieces();
      pool.sync(pieces.map((p) => p.id));
      registry.pieces = pieces.map((p) => ({ ...p, unit: pool.unitOf(p.id) }));
      registry.byId = new Map(registry.pieces.map((p) => [p.id, p]));
      registry.byFips.clear();
      for (const p of registry.pieces) {
        const list = registry.byFips.get(p.fips) ?? [];
        list.push(p);
        registry.byFips.set(p.fips, list);
      }
      const dividers = carver.dividers().map((d) => ({
        a: d.a,
        b: d.b,
        xyz: d.xyz,
        left: registry.byId.get(d.a)?.unit ?? 0xffff,
        right: registry.byId.get(d.b)?.unit ?? 0xffff,
      }));
      renderer.setCarved(registry.pieces, dividers);
      reownStaticSides();
      return { pieces: registry.pieces, dividers };
    }

    carveApi = {
      /** Apply a drawn stroke, in lon/lat. The carver's own result, verbatim. */
      line: (points, opts) => carver.carve(points, opts),
      /** Replay one exported `{ fips, tracts, cuts }` entry; piece ids on its side. */
      applyEntry: (entry) => carver.apply(entry),
      serialize: (id) => carver.serialize(id),
      /** Undo every cut on the piece's county; returns the county's fips. */
      rejoin: (id) => carver.rejoin(id),
      reset: () => carver.reset(),
      /** Rebuild the renderer's carve state from the model; the pieces and dividers. */
      sync: syncCarved,
      pieces: () => registry.pieces,
      piecesOf: (fips) => registry.byFips.get(fips) ?? [],
      pieceById: (id) => registry.byId.get(id),
    };
  }

  // ------------------------------------------------------------- the palette
  //
  // One pass over the units per model change. Three texels each and no
  // geometry: this is the whole of "repaint the map" now.

  function paint({ assign, stateOrder, fillOf, bandOf, isForeign, selected }) {
    const one = (unit, sid) => {
      if (sid === undefined) {
        // A county the app has retired — carved into pieces, which draw from
        // the dynamic buffer instead. Zero alpha is the whole of hiding it: the
        // triangles still rasterize and paint nothing.
        renderer.setUnitColor(unit, [0, 0, 0, 0]);
        renderer.setBandColor(unit, [0, 0, 0, 0]);
        renderer.setUnitOwner(unit, 0xffff, {});
        return;
      }
      renderer.setUnitColor(unit, fillOf(sid));
      renderer.setBandColor(unit, bandOf(sid));
      renderer.setUnitOwner(unit, stateOrder.get(sid) ?? 0xfffe, {
        alien: isForeign(sid),
        chosen: sid === selected,
      });
    };
    for (let u = 0; u < geometry.unitCount; u++) one(u, assign.get(units[u].id));
    // A piece is a unit: three texels through the same rules, at the id the
    // pool gave it.
    for (const p of registry.pieces) one(p.unit, assign.get(p.id));
  }

  // --------------------------------------------------------------- pointer

  function pickAt(cssX, cssY) {
    const at = camera.unproject(cssX, cssY);
    if (!at) return null;
    const u = unitIndex.at(at[0], at[1]);
    if (u < 0) return null;
    // The index still finds the carved parent — it reads the source rings and
    // no carve touches those — so the piece is a second, tiny lookup down the
    // county's own cut tree.
    if (carver) {
      const leaf = carver.pieceAt(u, at[0], at[1]);
      if (leaf && registry.byId.has(leaf.id)) return leaf.id;
    }
    return units[u].id;
  }

  const setHover = (fipsList) =>
    renderer.setHover(
      fipsList == null
        ? null
        : (Array.isArray(fipsList) ? fipsList : [fipsList])
            .map((f) => unitOf.get(f) ?? registry.byId.get(f)?.unit)
            .filter((u) => u !== undefined)
    );

  // ------------------------------------------------- what the app reads back

  // fips -> { x, y, area } in design coordinates, for the data view's symbols
  // and value labels. Units on the far side of the globe are left out, exactly
  // as the deck path's clipped parts left them out.
  function centroids() {
    const m = camera.matrix64;
    const out = new Map();
    for (let u = 0; u < geometry.unitCount; u++) {
      const p = [centroidXyz[u * 3], centroidXyz[u * 3 + 1], centroidXyz[u * 3 + 2]];
      if (facing(p, m) <= 0) continue;
      const [x, y] = toDesign(p, m);
      out.set(units[u].id, { x, y, area: unitArea[u] });
    }
    // Pieces too: their retired parent stays in the map but nothing reads it —
    // the consumers key through the assignment, which the parent has left.
    for (const p of registry.pieces) {
      const q = toXyz(p.center);
      if (facing(q, m) <= 0) continue;
      const [x, y] = toDesign(q, m);
      out.set(p.id, { x, y, area: p.area * globeScale * globeScale });
    }
    return out;
  }

  // The land's extent at this facing, in design coordinates.
  function landBounds() {
    const m = camera.matrix64;
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < hull.length; i += 3) {
      const p = [hull[i], hull[i + 1], hull[i + 2]];
      if (facing(p, m) <= 0) continue;
      const [x, y] = toDesign(p, m);
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
    }
    return b;
  }

  // ------------------------------------------------------------- the frame
  //
  // On demand, not on a loop: the renderer keeps the scene in a texture, so a
  // frame that moved only the pointer is a copy and one county. Everything that
  // changes the map invalidates that texture through the renderer itself, and
  // everything that changes the pointer just asks for a frame.

  let pending = 0;
  let labelsOn = true;
  const drawLabels = () => {
    if (!labelsOn) return;
    labels.prepare();
    labels.draw();
  };
  function frame() {
    pending = 0;
    renderer.draw(drawLabels);
  }
  function requestDraw() {
    if (!pending) pending = requestAnimationFrame(frame);
  }

  return {
    canvas,
    gl,
    camera,
    renderer,
    units,
    unitIndex,
    unitOf,
    geometry,
    resize,
    setTransform,
    setRotation,
    unprojectDesign,
    /** C6's carver behind the renderer's back-buffers, or null (see carveApi). */
    carve: carveApi,
    get rotation() {
      return camera.view.rotation.slice(0, 2);
    },
    homeRotation,
    paint,
    pickAt,
    setHover,
    centroids,
    landBounds,
    requestDraw,
    /** The state names, laid out over territory and kept in lon/lat (C5). */
    updateLabels(args) {
      const on = args.visible !== false;
      if (on !== labelsOn) {
        labelsOn = on;
        renderer.invalidate();
      }
      // The layout itself is cached against assignVersion inside labels.js;
      // this only re-runs when territory or a name has actually moved.
      labels.update(args);
      renderer.invalidate();
    },
    setView(next) {
      renderer.setView(next);
    },
    COLORS,
  };
}
