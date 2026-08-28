// Sanity check for src/split.js against the real data files, no browser
// needed: carves Los Angeles County into pieces and verifies the invariants
// the app relies on, including the re-owning of boundary records that
// adjacent carves and re-carves depend on. Run by hand after touching the
// split logic or regenerating data:
//
//   node scripts/split-check.mjs
//
// The projection helpers are copied from main.js (which can't be imported
// under Node — it touches the DOM on load); they must stay in step with it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as d3 from "d3";
import { feature } from "topojson-client";
import {
  allocatePieces,
  partsContain,
  reclassifyRecords,
  rewindGeometry,
  splitCountyGeometry,
  tractsAcrossCut,
} from "../src/split.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(join(root, "public", "data", p), "utf8"));
const topo = load("na-counties-topo.json");
const data = load("na-county-data.json");
const overlays = load("na-map-overlays.json");
const tractFile = load(join("tracts", "06037.json"));

const FIPS = "06037";

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

// --- projection helpers, as in main.js ------------------------------------

const counties = feature(topo, topo.objects.counties).features;
const FOREIGN = new Set(data.foreign ?? []);
const conusFeatures = counties.filter(
  (f) => !FOREIGN.has(f.properties.st) && f.properties.st !== "02" && f.properties.st !== "15"
);
const projection = d3
  .geoOrthographic()
  .rotate([96, -45])
  .fitSize([975, 610], { type: "FeatureCollection", features: conusFeatures });

const makeTracer = (proj) => {
  const recorded = [];
  let line = null;
  const trace = d3.geoPath(proj, {
    moveTo(x, y) {
      recorded.push((line = [[x, y]]));
    },
    lineTo(x, y) {
      line.push([x, y]);
    },
    closePath() {},
    arc() {},
  });
  return (geometry) => {
    recorded.length = 0;
    trace(geometry);
    return recorded.slice();
  };
};
const tracers = { main: makeTracer(projection) };
const projectLines = (geometry, region = "main") => tracers[region](geometry);
function projectParts(geometry, props, region = "main") {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const parts = [];
  for (const rings of polygons) {
    const projected = projectLines({ type: "Polygon", coordinates: rings }, region);
    const outerParts = [];
    const holes = [];
    for (const ring of projected) {
      if (ring.length < 3) continue;
      if (d3.polygonArea(ring) < 0) outerParts.push({ ...props, rings: [ring] });
      else holes.push(ring);
    }
    for (const hole of holes) {
      const home =
        outerParts.length === 1
          ? outerParts[0]
          : outerParts.find((p) => hole.some((pt) => d3.polygonContains(p.rings[0], pt)));
      home?.rings.push(hole);
    }
    parts.push(...outerParts);
  }
  return parts;
}

// --- the parent's boundary records, as main.js builds them -----------------

const parentArcRecords = [];
{
  const sides = [];
  for (const g of topo.objects.counties.geometries) {
    const rings = g.type === "Polygon" ? g.arcs : g.arcs.flat();
    for (const ring of rings) for (const a of ring) (sides[a < 0 ? ~a : a] ??= []).push(g.id);
  }
  sides.forEach((s, i) => {
    if (!s || !s.includes(FIPS)) return;
    const line = feature(topo, { type: "MultiLineString", arcs: [[i]] }).geometry.coordinates[0];
    for (const path of projectLines({ type: "LineString", coordinates: line })) {
      if (path.length >= 2)
        parentArcRecords.push({ a: s[0], b: s[s.length - 1], arc: i, region: "main", path });
    }
  });
}
const parentEdgeRecords = overlays.boundary
  .filter((r) => r.unit === FIPS)
  .flatMap((r) =>
    projectLines({ type: "LineString", coordinates: r.line }).map((path) => ({
      a: FIPS,
      b: FIPS,
      edge: true,
      region: "main",
      path,
    }))
  );

// --- carve 1: the high desert north of the San Gabriels --------------------

const tractTopo = tractFile.topo;
const tractFeats = feature(tractTopo, tractTopo.objects.tracts).features;
const NORTH_LAT = 34.3;
const allTracts = tractFeats.map((f) => f.id);
const northSet = new Set(tractFeats.filter((f) => d3.geoCentroid(f)[1] > NORTH_LAT).map((f) => f.id));
console.log(`carve 1: ${northSet.size} of ${allTracts.length} tracts in the northern piece`);

const parentParts = projectParts(counties.find((f) => f.id === FIPS).geometry, {
  fips: FIPS,
  region: "main",
});
const parentPartsByRegion = new Map([["main", parentParts]]);

const twoPieces = [
  { id: FIPS + "a", tracts: new Set(allTracts.filter((t) => !northSet.has(t))) },
  { id: FIPS + "b", tracts: northSet },
];
const geo2 = splitCountyGeometry({
  tractTopo,
  pieces: twoPieces,
  backingId: FIPS + "a",
  parentPartsByRegion,
  projectParts,
  projectLines,
});
const county = { ...data.counties[FIPS], landArea: 4058 };
const rows2 = allocatePieces(county, tractFile.rows, twoPieces, geo2.landShares);

// The world-rebuild wiring, as main.js's rebuildWorld builds it.
const makeOpts = (splits) => {
  const pieceParent = new Map();
  for (const [pid, s] of splits) for (const p of s.pieces) pieceParent.set(p.id, pid);
  return {
    ownerAt: (pt, r) => {
      let inFringe = false;
      for (const id of r.a === r.b ? [r.a] : [r.a, r.b]) {
        const s = splits.get(id);
        if (!s) continue;
        const c = s.contains.get(r.region);
        if (!c || !c.parent(pt)) continue;
        for (const [pid, inPiece] of c.pieces) if (inPiece(pt)) return pid;
        inFringe = true; // between the true unions and the drawn line: probe deeper
        break;
      }
      if (inFringe) return null;
      const aSplit = splits.has(r.a);
      const bSplit = splits.has(r.b);
      if (aSplit && bSplit) return null;
      return aSplit ? r.b : r.a;
    },
    defaultsFor: (r) => [splits.get(r.a)?.backingId ?? r.a, splits.get(r.b)?.backingId ?? r.b],
    familyOf: (id) => pieceParent.get(id) ?? id,
  };
};

const splits2 = new Map([
  [FIPS, { pieces: twoPieces, backingId: FIPS + "a", contains: geo2.contains }],
]);
const opts2 = makeOpts(splits2);
const arcs2 = reclassifyRecords(parentArcRecords, opts2);
const edges2 = reclassifyRecords(parentEdgeRecords, opts2);

// --- invariants, two pieces ------------------------------------------------

for (const f of ["pop", "gdp", "eduT", "eduB", "dem", "gop", "tot", "rT", "rW", "rB", "rN", "rA", "rH"]) {
  const total = twoPieces.reduce((t, p) => t + rows2.get(p.id)[f], 0);
  check(total === county[f], `${f}: pieces sum back to the county (${total} = ${county[f]})`);
}
const landTotal = twoPieces.reduce((t, p) => t + rows2.get(p.id).landArea, 0);
check(Math.abs(landTotal - county.landArea) < 1e-6, "landArea: pieces sum back to the county");
const [rowA, rowB] = twoPieces.map((p) => rows2.get(p.id));
check(rowA.pop > 0 && rowB.pop > 0, `both pieces populated (${rowA.pop.toLocaleString()} / ${rowB.pop.toLocaleString()})`);
const wmhi = (rowA.mhi * rowA.pop + rowB.mhi * rowB.pop) / county.pop;
check(Math.abs(wmhi - county.mhi) / county.mhi < 0.01, `mhi: weighted mean of pieces ≈ county median (${Math.round(wmhi)} vs ${county.mhi})`);
check(rowA.mhi !== rowB.mhi, `mhi differs between pieces (${rowA.mhi} vs ${rowB.mhi})`);

check(
  geo2.backingParts.length === parentParts.length && geo2.pieceParts.length > 0,
  `fill parts: parent-shaped backing (${geo2.backingParts.length}) plus the piece's union (${geo2.pieceParts.length})`
);
check(
  geo2.hoverParts.get(FIPS + "a").length > 0 && geo2.hoverParts.get(FIPS + "b").length > 0,
  `hover parts for both pieces (${geo2.hoverParts.get(FIPS + "a").length} / ${geo2.hoverParts.get(FIPS + "b").length})`
);
check(geo2.dividerRecords.length > 0, `divider present (${geo2.dividerRecords.length} path(s))`);
const shareSum = [...geo2.landShares.values()].reduce((a, b) => a + b, 0);
check(Math.abs(shareSum - 1) < 1e-9, "land shares sum to one");

const segs = (records) => records.reduce((n, r) => n + r.path.length - 1, 0);
check(segs(arcs2) === segs(parentArcRecords), `perimeter segments preserved (${segs(arcs2)} of ${segs(parentArcRecords)})`);
check(segs(edges2) === segs(parentEdgeRecords), `edge-run segments preserved (${segs(edges2)} of ${segs(parentEdgeRecords)})`);

const owners = (records, nbr) =>
  new Set(records.filter((r) => r.b === nbr || r.a === nbr).map((r) => (r.b === nbr ? r.a : r.b)));
check(
  owners(arcs2, "06029").has(FIPS + "b") && !owners(arcs2, "06029").has(FIPS + "a"),
  "Kern County line owned by the northern piece alone"
);
check(
  owners(arcs2, "06059").has(FIPS + "a") && !owners(arcs2, "06059").has(FIPS + "b"),
  "Orange County line owned by the southern remainder alone"
);
check(new Set(edges2.map((r) => r.a)).has(FIPS + "a"), "the remainder keeps coastline");

// adjacency derived from the records, as rebuildWorld derives it
const adj = new Map();
for (const r of [...arcs2, ...geo2.dividerRecords]) {
  if (r.a === r.b) continue;
  if (!adj.has(r.a)) adj.set(r.a, new Set());
  if (!adj.has(r.b)) adj.set(r.b, new Set());
  adj.get(r.a).add(r.b);
  adj.get(r.b).add(r.a);
}
check(
  adj.get(FIPS + "b")?.has("06029") && adj.get(FIPS + "a")?.has("06059") && adj.get(FIPS + "a")?.has(FIPS + "b"),
  "adjacency from records: north↔Kern, south↔Orange, pieces↔each other"
);

// --- carve 2: refine both pieces east/west (four pieces) -------------------

const EAST_LON = -118.2;
const eastSet = new Set(tractFeats.filter((f) => d3.geoCentroid(f)[0] > EAST_LON).map((f) => f.id));
let seq = 2;
const fourPieces = [];
for (const piece of twoPieces) {
  for (const keep of [true, false]) {
    const tracts = new Set([...piece.tracts].filter((t) => eastSet.has(t) === keep));
    if (tracts.size) fourPieces.push({ id: FIPS + String.fromCharCode(97 + seq++), tracts });
  }
}
console.log(`carve 2: refined into ${fourPieces.length} pieces (${fourPieces.map((p) => p.tracts.size).join(" / ")})`);
check(fourPieces.length === 4, "second cut divides both pieces");

const popOf = (tracts) => [...tracts].reduce((t, id) => t + (tractFile.rows[id]?.pop || 0), 0);
const backing4 = fourPieces.reduce((best, p) => (popOf(p.tracts) > popOf(best.tracts) ? p : best)).id;
const geo4 = splitCountyGeometry({
  tractTopo,
  pieces: fourPieces,
  backingId: backing4,
  parentPartsByRegion,
  projectParts,
  projectLines,
});
const rows4 = allocatePieces(county, tractFile.rows, fourPieces, geo4.landShares);
for (const f of ["pop", "gdp", "tot", "rH"]) {
  const total = fourPieces.reduce((t, p) => t + rows4.get(p.id)[f], 0);
  check(total === county[f], `${f}: four pieces sum back to the county (${total} = ${county[f]})`);
}
const pairs4 = new Set(geo4.dividerRecords.map((r) => (r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`)));
check(pairs4.size >= 3, `dividers between ${pairs4.size} piece pairs`);

const splits4 = new Map([[FIPS, { pieces: fourPieces, backingId: backing4, contains: geo4.contains }]]);
const arcs4 = reclassifyRecords(parentArcRecords, makeOpts(splits4));
check(segs(arcs4) === segs(parentArcRecords), `four-piece perimeter segments preserved (${segs(arcs4)})`);
const ids4 = new Set(fourPieces.map((p) => p.id));
check(
  arcs4.every((r) => (ids4.has(r.a) || r.a === r.b ? true : !r.a.startsWith(FIPS)) && (ids4.has(r.b) || !r.b.startsWith(FIPS))),
  "four-piece perimeter records name only live pieces and neighbours"
);
const kern4 = owners(arcs4, "06029");
check([...kern4].every((id) => ids4.has(id)) && kern4.size >= 1, `Kern County line owned by northern piece(s): ${[...kern4].join(", ")}`);

// --- adjacent carves: two carved counties sharing a border -----------------
// Synthetic squares, so the case (which one tract file can't produce) is
// still covered: X = [0,1]², carved at y=0.5; Y = [1,2]×[0,1], carved at
// y=0.3. Their shared border x=1 must re-own into three runs whose flanking
// pairs change exactly at the two cut heights.

{
  const rect = (x0, y0, x1, y1) =>
    partsContain([{ rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] }]);
  const synth = new Map([
    [
      "X",
      {
        pieces: [{ id: "Xlo" }, { id: "Xhi" }],
        backingId: "Xlo",
        contains: new Map([
          [
            "main",
            {
              parent: rect(0, 0, 1, 1),
              pieces: new Map([
                ["Xlo", rect(0, 0, 1, 0.5)],
                ["Xhi", rect(0, 0.5, 1, 1)],
              ]),
            },
          ],
        ]),
      },
    ],
    [
      "Y",
      {
        pieces: [{ id: "Ylo" }, { id: "Yhi" }],
        backingId: "Ylo",
        contains: new Map([
          [
            "main",
            {
              parent: rect(1, 0, 2, 1),
              pieces: new Map([
                ["Ylo", rect(1, 0, 2, 0.3)],
                ["Yhi", rect(1, 0.3, 2, 1)],
              ]),
            },
          ],
        ]),
      },
    ],
  ]);
  const border = {
    a: "X",
    b: "Y",
    arc: 0,
    region: "main",
    path: d3.range(0, 1.0001, 0.05).map((y) => [1, y]),
  };
  const runs = reclassifyRecords([border], makeOpts(synth));
  const pairKey = (r) => (r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`);
  const sequence = runs.map(pairKey);
  check(
    sequence.join(" → ") === "Xlo|Ylo → Xlo|Yhi → Xhi|Yhi",
    `adjacent carves: shared border re-owns into ${sequence.join(" → ")}`
  );
  check(segs(runs) === border.path.length - 1, "adjacent carves: border segments preserved");
}

// --- the fringe: true unions stopping short of the drawn line --------------
// The piece unions sit 0.1 inside the drawn county, so shallow probes land
// in the fringe. The deep steps must own each stretch by the piece BEYOND
// the fringe — under the old backing fallback the whole border would have
// read as the backing piece, drawing a phantom state border along its
// upper half.

{
  const rect = (x0, y0, x1, y1) =>
    partsContain([{ rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] }]);
  const synth = new Map([
    [
      "X",
      {
        pieces: [{ id: "Xlo" }, { id: "Xhi" }],
        backingId: "Xlo",
        contains: new Map([
          [
            "main",
            {
              parent: rect(0, 0, 1, 1),
              pieces: new Map([
                ["Xlo", rect(0.1, 0, 0.9, 0.5)],
                ["Xhi", rect(0.1, 0.5, 0.9, 1)],
              ]),
            },
          ],
        ]),
      },
    ],
  ]);
  const border = {
    a: "X",
    b: "06059",
    arc: 0,
    region: "main",
    path: d3.range(0, 1.0001, 0.05).map((y) => [1, y]),
  };
  const runs = reclassifyRecords([border], makeOpts(synth));
  const sequence = runs.map((r) => `${r.a}|${r.b}`);
  check(
    sequence.join(" → ") === "Xlo|06059 → Xhi|06059",
    `fringe: deep probes own the border by the pieces beyond it (${sequence.join(" → ")})`
  );
  check(segs(runs) === border.path.length - 1, "fringe: border segments preserved");
}

// --- imported boundaries: ring winding normalized before projection --------
// A GeoJSON region wound the wrong way for a spherical renderer reads as
// everything-but-the-region; rewindGeometry must make both windings land on
// the same (small) area, and containment must agree after projection.

{
  const square = [
    [-118.5, 34.0],
    [-118.0, 34.0],
    [-118.0, 34.5],
    [-118.5, 34.5],
    [-118.5, 34.0],
  ];
  const asRegion = (ring) => {
    const g = rewindGeometry({ type: "Polygon", coordinates: [ring.map((p) => p.slice())] });
    return { area: d3.geoArea(g), contains: partsContain(projectParts(g, {})) };
  };
  const ccw = asRegion(square);
  const cw = asRegion(square.slice().reverse());
  check(
    ccw.area < 2 * Math.PI && Math.abs(ccw.area - cw.area) < 1e-12,
    "GeoJSON winding: both windings normalize to the same small region"
  );
  const inPt = projection([-118.25, 34.25]);
  const outPt = projection([-90, 40]);
  check(
    ccw.contains(inPt) && cw.contains(inPt) && !ccw.contains(outPt) && !cw.contains(outPt),
    "GeoJSON winding: containment agrees for both windings after projection"
  );
}

// --- the knife: drawn lines translate into tracts on either side ----------

const centroids = new Map();
for (const f of tractFeats) {
  let area = 0;
  let x = 0;
  let y = 0;
  for (const p of projectParts(f.geometry, {})) {
    const a = Math.abs(d3.polygonArea(p.rings[0]));
    if (!a) continue;
    const [cx, cy] = d3.polygonCentroid(p.rings[0]);
    area += a;
    x += cx * a;
    y += cy * a;
  }
  if (area) centroids.set(f.id, [x / area, y / area]);
}
const cb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
for (const p of parentParts)
  for (const ring of p.rings)
    for (const [x, y] of ring) {
      if (x < cb.x0) cb.x0 = x;
      if (x > cb.x1) cb.x1 = x;
      if (y < cb.y0) cb.y0 = y;
      if (y > cb.y1) cb.y1 = y;
    }
const W = cb.x1 - cb.x0;
const H = cb.y1 - cb.y0;

const cutY = cb.y0 + 0.25 * H;
const horiz = tractsAcrossCut(
  [
    [cb.x0 + 0.1 * W, cutY],
    [cb.x1 - 0.1 * W, cutY],
  ],
  centroids,
  cb
);
check(!!horiz && horiz.size > 0 && horiz.size < centroids.size, `horizontal cut: both sides populated (${horiz?.size} vs ${centroids.size - (horiz?.size ?? 0)})`);
if (horiz) {
  const insideNorth = [...horiz].every((id) => centroids.get(id)[1] < cutY);
  const exact = [...centroids].every(
    ([id, c]) => horiz.has(id) === (insideNorth ? c[1] < cutY : c[1] > cutY)
  );
  check(exact, "horizontal cut: every tract on the side its centroid says");
}

const cutX = cb.x0 + 0.3 * W;
const cutY2 = cb.y0 + 0.3 * H;
const ell = tractsAcrossCut(
  [
    [cutX, cb.y0 - 2],
    [cutX, cutY2],
    [cb.x0 - 2, cutY2],
  ],
  centroids,
  cb
);
check(!!ell && ell.size > 0 && ell.size < centroids.size, `L-shaped cut: both sides populated (${ell?.size} vs ${centroids.size - (ell?.size ?? 0)})`);
if (ell) {
  const corner = new Set(
    [...centroids].filter(([, c]) => c[0] < cutX && c[1] < cutY2).map(([id]) => id)
  );
  const sameAsCorner = ell.size === corner.size && [...ell].every((id) => corner.has(id));
  const sameAsRest =
    ell.size === centroids.size - corner.size && [...ell].every((id) => !corner.has(id));
  check(sameAsCorner || sameAsRest, `L-shaped cut: matches the northwest corner exactly (corner holds ${corner.size} tracts)`);
}

check(
  tractsAcrossCut(
    [
      [cb.x0 - 10, cb.y0 - 10],
      [cb.x0 - 8, cb.y0 - 10],
    ],
    centroids,
    cb
  ) === null,
  "a cut beside the county is rejected"
);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
