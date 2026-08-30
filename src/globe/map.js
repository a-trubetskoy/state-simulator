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

import { loadGeometry } from "./geometry.js";
import { createCamera } from "./camera.js";
import { createRenderer } from "./renderer.js";
import { loadUnits } from "./source.js";
import { createUnitIndex } from "./pick.js";
import { createGlobeLabels } from "./labels.js";
import { COLORS } from "./layers.js";

const RAD = Math.PI / 180;

/**
 * @param canvas    the map canvas, which this module owns outright
 * @param features  the county features main.js has already decoded
 */
export async function createGlobeMap({ canvas, features }) {
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
    // The backing store only. The element's CSS size is the map box's, set by
    // the stylesheet's inset: 0, exactly as it was when deck.gl owned it.
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

  // ------------------------------------------------------------- the palette
  //
  // One pass over the units per model change. Three texels each and no
  // geometry: this is the whole of "repaint the map" now.

  function paint({ assign, stateOrder, fillOf, bandOf, isForeign, selected }) {
    for (let u = 0; u < geometry.unitCount; u++) {
      const sid = assign.get(units[u].id);
      if (sid === undefined) {
        // A county the app has retired — carved into pieces, which draw from
        // the dynamic buffer instead. Zero alpha is the whole of hiding it: the
        // triangles still rasterize and paint nothing.
        renderer.setUnitColor(u, [0, 0, 0, 0]);
        renderer.setBandColor(u, [0, 0, 0, 0]);
        renderer.setUnitOwner(u, 0xffff, {});
        continue;
      }
      renderer.setUnitColor(u, fillOf(sid));
      renderer.setBandColor(u, bandOf(sid));
      renderer.setUnitOwner(u, stateOrder.get(sid) ?? 0xfffe, {
        alien: isForeign(sid),
        chosen: sid === selected,
      });
    }
  }

  // --------------------------------------------------------------- pointer

  function pickAt(cssX, cssY) {
    const at = camera.unproject(cssX, cssY);
    if (!at) return null;
    const u = unitIndex.at(at[0], at[1]);
    return u >= 0 ? units[u].id : null;
  }

  const setHover = (fipsList) =>
    renderer.setHover(
      fipsList == null
        ? null
        : (Array.isArray(fipsList) ? fipsList : [fipsList])
            .map((f) => unitOf.get(f))
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
