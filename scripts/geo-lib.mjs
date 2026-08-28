// Helpers shared by the data pipeline scripts (build-data.mjs and
// build-tracts.mjs): the caching downloader and the simplification repairs
// that both topology builds need.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feature } from "topojson-client";
import { geoArea } from "d3-geo";

export function makeDownloader(cacheDir) {
  return async function download(url, filename) {
    const path = join(cacheDir, filename);
    if (existsSync(path)) {
      console.log(`cached   ${filename}`);
      return readFileSync(path);
    }
    console.log(`fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, buf);
    console.log(`saved    ${filename} (${(buf.length / 1e6).toFixed(1)} MB)`);
    return buf;
  };
}

// Dropping every point below the threshold can flatten a small island into a
// degenerate two-point ring that renders as nothing. Keep the four heaviest
// points of any closed ring that would otherwise collapse, so a small island
// stays a small island instead of disappearing.
export function simplifyArcs(topo, minWeight) {
  let collapsed = 0;
  const arcs = topo.arcs.map((arc) => {
    const last = arc[arc.length - 1];
    const closed = arc[0][0] === last[0] && arc[0][1] === last[1];
    const keep = arc.map((p) => p[2] >= minWeight);
    let n = keep.reduce((sum, k) => sum + (k ? 1 : 0), 0);
    if (closed && n < 4) {
      collapsed++;
      for (const [, i] of arc
        .map((p, i) => [p[2], i])
        .sort((a, b) => b[0] - a[0])) {
        if (n >= 4) break;
        if (!keep[i]) (keep[i] = true), n++;
      }
    }
    return arc.filter((_, i) => keep[i]).map(([x, y]) => [x, y]);
  });
  return { topo: { ...topo, arcs }, collapsed };
}

// A spherical renderer reads a ring by its winding, so a ring wound backwards
// means everything-but-the-ring: one flipped islet fills the whole globe with
// its unit's colour. Heavy thinning can flip a ring — the few vertices that
// survive from a concave ring can wind the opposite way from the ring they
// came from, and quantization can do the same to a sliver — so after both, put
// every ring the right way round: an exterior ring must enclose less than a
// hemisphere, a hole more (a correct hole standalone reads as the sphere minus
// the lake). Reversing is a geometry-side edit — the ring walks the same arcs
// in the opposite direction — so shared arcs and the neighbours that use them
// are untouched.
export function rewindRings(topo, objectName) {
  let rewound = 0;
  for (const g of topo.objects[objectName].geometries) {
    const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
    const decoded = feature(topo, g).geometry;
    const rings = decoded.type === "Polygon" ? [decoded.coordinates] : decoded.coordinates;
    polys.forEach((poly, pi) =>
      poly.forEach((ring, ri) => {
        const area = geoArea({ type: "Polygon", coordinates: [rings[pi][ri]] });
        const backwards = ri === 0 ? area > 2 * Math.PI : area < 2 * Math.PI;
        if (backwards) {
          poly[ri] = ring.map((a) => ~a).reverse();
          rewound++;
        }
      })
    );
  }
  return rewound;
}
