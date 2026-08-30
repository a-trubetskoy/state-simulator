// C6 — what can be checked about a carve without a GPU, which is nearly all of
// it. `npm run check:carve`.
//
// The renderer's half of C6 is a buffer upload and has to be looked at. The
// model's half is arithmetic over the real county, tract and compiled-geometry
// files, and every claim C6 makes is one of these:
//
//   the pieces TILE the parent — same area, no gap, no overlap
//   a straddling tract's shares sum to one
//   the piece rows sum back to the published county row, to the unit
//   a serialized piece reloads as the same geometry
//   keeping tracts whole puts every tract in exactly one piece
//   a legacy { fips, tracts } preset entry still means what it meant
//
// Read from disk rather than fetched, and otherwise the same modules the browser
// runs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";
import * as d3 from "d3";

import { createUnitIndex } from "../src/globe/pick.js";
import { unitTriangles } from "../src/globe/geometry.js";
import { createCarver } from "../src/globe/carve.js";
import { PRESETS } from "../src/presets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "public", "data");
const read = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));

let failures = 0;
const ok = (name, pass, note = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${note ? `   ${note}` : ""}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const pieceById = (c, id) => c.pieces.find((p) => p.id === id);

// ------------------------------------------------------------------ the world

console.log("loading...");

const manifest = read("globe-geometry.json");
const raw = fs.readFileSync(path.join(DATA, manifest.binary.replace(/^\.?\//, "")));
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

const B = manifest.buffers;
const cg = manifest.fills.counties;
const posAt = B.fillPosition.byteOffset + cg.firstVertex * 12;
const idxAt = B.fillIndex.byteOffset + cg.firstIndex * 4;
const geometry = {
  countyPositions: new Float32Array(buf.slice(posAt, posAt + cg.vertexCount * 12)),
  countyIndices: new Uint32Array(buf.slice(idxAt, idxAt + cg.indexCount * 4)),
  countyFirstVertex: cg.firstVertex,
  countyFirstIndex: cg.firstIndex,
  unitIndexRange: new Uint32Array(
    buf.slice(
      B.unitIndexRange.byteOffset,
      B.unitIndexRange.byteOffset + B.unitIndexRange.count * 8
    )
  ),
};

const topo = read("na-counties-topo.json");
const units = feature(topo, topo.objects.counties).features.map((f) => ({
  id: f.id,
  name: f.properties?.name ?? f.id,
  polygons: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
}));
if (units.some((u, i) => u.id !== manifest.units[i])) {
  throw new Error("the topojson and the compiled manifest disagree on unit order");
}
const unitIndex = createUnitIndex(units);
const countyRows = read("na-county-data.json").counties;

const tractCache = new Map();
const fetchTracts = async (fips) => {
  if (!tractCache.has(fips)) {
    const p = path.join(DATA, "tracts", `${fips}.json`);
    tractCache.set(fips, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
  }
  return tractCache.get(fips);
};

const newCarver = () =>
  createCarver({
    units,
    unitIndex,
    unitTris: (u) => unitTriangles(geometry, u),
    countyRows,
    fetchTracts,
  });

const unitOf = (fips) => manifest.units.indexOf(fips);
let carverOf = null;

// The one number every other claim leans on. `ringArea` cancels a shared edge to
// the bit, so a partition adds back up to float64 rounding over a few hundred
// triangles and not to some looser "close enough" — which is what makes a real
// gap impossible to hide under the tolerance.
const TILE_TOL = 1e-12;
const tiles = (c) => {
  const sum = c.pieces.reduce((s, p) => s + p.area, 0);
  return { pass: near(sum, c.area, c.area * TILE_TOL), note: `${(sum / c.area - 1).toExponential(2)} relative` };
};

// A stroke that crosses a county, as lon/lat: the two points are the county's
// bounding box corners pushed out a little, so it always cuts clean through.
function strokeAcross(fips, frac = 0.5, diagonal = false) {
  const u = unitOf(fips);
  const f = feature(topo, topo.objects.counties).features[u];
  const [x0, y0, x1, y1] = d3.geoBounds(f).flat().length === 4
    ? [...d3.geoBounds(f)[0], ...d3.geoBounds(f)[1]]
    : [0, 0, 0, 0];
  const padX = (x1 - x0) * 0.3;
  const padY = (y1 - y0) * 0.3;
  if (diagonal) {
    return [
      [x0 - padX, y0 - padY],
      [x1 + padX, y1 + padY],
    ];
  }
  const y = y0 + (y1 - y0) * frac;
  return [
    [x0 - padX, y],
    [x1 + padX, y],
  ];
}

// ------------------------------------------------------------------ the checks

// Cuyahoga: 447 tracts, a lakeshore, and big enough that a horizontal cut
// straddles dozens of them. Fairfax County VA is the county with a HOLE in it
// (Fairfax City), which is the case the triangle-cutting design exists to make
// unremarkable.
const SUBJECT = "39035";
const HOLED = "51059";

console.log("\ncutting one county");
{
  carverOf = newCarver();
  const res = await carverOf.carve(strokeAcross(SUBJECT));
  ok("the cut took", res.carved.length === 1, res.carved.join(", ") || JSON.stringify(res));

  const c = carverOf.carves.get(unitOf(SUBJECT));
  const pieces = c.pieces;
  ok("two pieces", pieces.length === 2, pieces.map((p) => p.id).join(" "));

  ok("the pieces tile the county", tiles(c).pass, tiles(c).note);

  // Both pieces are real: neither is the graze the guard is there to catch.
  const min = Math.min(...pieces.map((p) => p.area / c.area));
  ok("neither piece is a sliver", min > 0.05, `smallest ${(min * 100).toFixed(1)}%`);

  // A straddling tract is the whole point of the change: it belongs to both.
  const straddling = c.shapes.filter(
    (s) => pieces.filter((p) => (p.weights.get(s.id) ?? 0) > 0).length > 1
  );
  ok("tracts straddle the line", straddling.length > 0, `${straddling.length} of ${c.shapes.length}`);

  // Looser than the tiling above, and for a reason worth writing down rather
  // than papering over. A tract's shares are its own area cut up, and the cut
  // points are computed from a knife whose ends run twelve county-widths out, at
  // longitudes around -82. Absolute precision there is about 1e-14 degrees; the
  // smallest tracts here are 0.008 degrees across, so a relative residue near
  // 1e-12 is the floor and the worst offenders are duly the smallest tracts. In
  // ground terms that is a nanometre of edge position, against a tract boundary
  // published to four decimal places.
  let worst = 0;
  let worstAt = null;
  for (const s of c.shapes) {
    const total = pieces.reduce((t, p) => t + (p.weights.get(s.id) ?? 0), 0);
    if (Math.abs(total - 1) > worst) {
      worst = Math.abs(total - 1);
      worstAt = s;
    }
  }
  ok("every tract's shares sum to one", worst < 1e-9,
    `worst ${worst.toExponential(2)} on ${worstAt?.id}, ` +
      `${(worst * worstAt?.area * 6371.0088 ** 2 * 1e6).toExponential(1)} m² of its ` +
      `${(worstAt?.area * 6371.0088 ** 2).toFixed(2)} km²`);

  // The rows. A carve must not move a county, state or national total.
  const row = countyRows[SUBJECT];
  const fields = ["pop", "gdp", "dem", "gop", "tot", "eduT", "eduB", "rT", "rW", "rB", "rN", "rA", "rH"];
  let rowsOk = true;
  const drift = [];
  for (const f of fields) {
    if (row[f] == null) continue;
    const t = pieces.reduce((s, p) => s + (p.row[f] ?? 0), 0);
    if (t !== row[f]) {
      rowsOk = false;
      drift.push(`${f} ${t} vs ${row[f]}`);
    }
  }
  ok("the piece rows sum to the county row", rowsOk, drift.join(", "));

  // Population went where the land went, roughly — not exactly, because people
  // are not spread evenly, but a half-and-half cut should not put 99% on a side.
  const share = pieces.map((p) => p.row.pop / row.pop);
  ok("population split is plausible", Math.min(...share) > 0.05, share.map((s) => (s * 100).toFixed(1) + "%").join(" / "));
}

console.log("\ncutting a county that has a hole in it");
{
  const carver = newCarver();
  carverOf = carver;
  await carver.carve(strokeAcross(HOLED));
  const c = carver.carves.get(unitOf(HOLED));
  ok("the cut took", c != null && c.pieces.length === 2, c ? c.pieces.map((p) => p.id).join(" ") : "not carved");
  ok("the pieces tile the county", tiles(c).pass, tiles(c).note);
  // The hole has to stay a hole: the pieces together must not cover the city.
  const city = units[unitOf("51600")];
  if (city) {
    const [cx, cy] = d3.geoCentroid({ type: "Polygon", coordinates: city.polygons[0] });
    const hit = c.pieces.some((p) =>
      p.tris.some((t) => {
        const s = (a, b, c2) => (a[0] - c2[0]) * (b[1] - c2[1]) - (b[0] - c2[0]) * (a[1] - c2[1]);
        const d1 = s(t[0], t[1], [cx, cy]);
        const d2 = s(t[1], t[2], [cx, cy]);
        const d3v = s(t[2], t[0], [cx, cy]);
        return !((d1 < 0 || d2 < 0 || d3v < 0) && (d1 > 0 || d2 > 0 || d3v > 0));
      })
    );
    ok("the enclave stays out of both pieces", !hit, hit ? "a piece covers Fairfax City" : "");
  }
}

console.log("\nevery county one long stroke crosses");
{
  // Across northern Ohio in one go. Nothing here is about a county anybody
  // chose: it is that both invariants hold for all of them at once, over shapes
  // that were not picked to flatter the arithmetic.
  const carver = newCarver();
  const res = await carver.carve([
    [-84.9, 40.4],
    [-82.6, 40.9],
    [-80.6, 40.3],
  ]);
  ok("it carved a good few", res.carved.length >= 5, `${res.carved.length} counties: ${res.carved.join(", ")}`);

  let worstTile = 0;
  let smallest = 1;
  let rowsOk = true;
  let straddled = 0;
  for (const c of carver.carves.values()) {
    const sum = c.pieces.reduce((s, p) => s + p.area, 0);
    worstTile = Math.max(worstTile, Math.abs(sum / c.area - 1));
    for (const p of c.pieces) smallest = Math.min(smallest, p.area / c.area);
    straddled += c.shapes.filter(
      (s) => c.pieces.filter((p) => (p.weights.get(s.id) ?? 0) > 0).length > 1
    ).length;
    const want = countyRows[c.fips];
    if (want?.pop != null && c.pieces.reduce((s, p) => s + p.row.pop, 0) !== want.pop) rowsOk = false;
  }
  ok("all of them tile", worstTile < TILE_TOL, `worst ${worstTile.toExponential(2)} relative`);
  ok("no piece is under the graze floor", smallest >= 1e-4, `smallest ${smallest.toExponential(2)} of its county`);
  ok("every county's population is conserved", rowsOk);
  ok("tracts were split along the way", straddled > 0, `${straddled} straddling tracts`);
}

console.log("\ncutting twice");
{
  const carver = newCarver();
  carverOf = carver;
  await carver.carve(strokeAcross(SUBJECT, 0.4));
  await carver.carve(strokeAcross(SUBJECT, 0.7));
  const c = carver.carves.get(unitOf(SUBJECT));
  ok("three pieces", c.pieces.length === 3, c.pieces.map((p) => p.id).join(" "));
  ok("still tiles the county", tiles(c).pass, tiles(c).note);
  const row = countyRows[SUBJECT];
  const pop = c.pieces.reduce((s, p) => s + p.row.pop, 0);
  ok("population still sums", pop === row.pop, `${pop} vs ${row.pop}`);

  // A second cut must not disturb the piece it did not touch.
  ok("ids record the path", c.pieces.every((p) => p.id.startsWith(`${SUBJECT}:`)), c.pieces.map((p) => p.id).join(" "));
}

console.log("\na cut that only grazes");
{
  // Out over Lake Erie, crossing no land at all.
  const carver = newCarver();
  const res = await carver.carve([
    [-82.0, 42.2],
    [-80.9, 42.2],
  ]);
  ok("open water carves nothing", res.carved.length === 0 && carver.carves.size === 0, JSON.stringify(res));

  // And lines walked in towards a county's own edge, each shaving a thinner
  // strip than the last. Somewhere along that sweep the strip stops being a
  // piece, and the guard has to be what stops it — so the sweep has to show both
  // outcomes, and every piece it ever does mint has to clear the floor.
  let carvedAt = 0;
  let refusedAt = 0;
  let smallest = 1;
  for (const frac of [0.97, 0.98, 0.99, 0.995, 0.999, 0.9995, 0.9999]) {
    const shave = newCarver();
    await shave.carve(strokeAcross(SUBJECT, frac));
    const c = shave.carves.get(unitOf(SUBJECT));
    if (!c) refusedAt++;
    else {
      carvedAt++;
      smallest = Math.min(smallest, ...c.pieces.map((p) => p.area / c.area));
    }
  }
  ok("the sweep straddles the floor", carvedAt > 0 && refusedAt > 0, `${carvedAt} carved, ${refusedAt} refused`);
  ok("no shave mints a sliver", smallest >= 1e-4, `smallest ${smallest.toExponential(2)} of its county`);
}

console.log("\nguards");
{
  const carver = newCarver();
  ok("a self-crossing stroke is refused",
    (await carver.carve([[-81.8, 41.4], [-81.4, 41.6], [-81.8, 41.6], [-81.4, 41.4]])).rejected != null);
  ok("a one-point stroke is refused", (await carver.carve([[-81.8, 41.4]])).rejected != null);
  ok("a stroke with no numbers in it is refused",
    (await carver.carve([[NaN, 41.4], [-81.4, 41.6]])).rejected != null);
}

console.log("\nkeeping tracts whole");
{
  const carver = newCarver();
  const res = await carver.carve(strokeAcross(SUBJECT), { keepTractsIntact: true });
  ok("the cut took", res.carved.length === 1, res.carved.join(", ") || JSON.stringify(res));
  const c = carver.carves.get(unitOf(SUBJECT));
  ok("still tiles the county", tiles(c).pass, tiles(c).note);

  // The point of the mode: no tract is in two pieces.
  const shared = c.shapes.filter(
    (s) => c.pieces.filter((p) => (p.weights.get(s.id) ?? 0) > 0).length > 1
  );
  ok("no tract is split", shared.length === 0, shared.map((s) => s.id).join(" "));
  const covered = new Set(c.pieces.flatMap((p) => [...p.weights.keys()]));
  ok("every tract is placed", covered.size === c.shapes.length, `${covered.size} of ${c.shapes.length}`);
  const row = countyRows[SUBJECT];
  ok("population still sums", c.pieces.reduce((s, p) => s + p.row.pop, 0) === row.pop);
}

console.log("\nwriting a piece down and reading it back");
{
  const carver = newCarver();
  await carver.carve(strokeAcross(SUBJECT, 0.45));
  await carver.carve(strokeAcross(SUBJECT, 0.75));
  const before = carver.carves.get(unitOf(SUBJECT));
  const want = before.pieces[1];
  const entry = carver.serialize(want.id);
  ok("a piece serializes", entry != null && entry.fips === SUBJECT, JSON.stringify(entry)?.slice(0, 90));
  ok("it carries its cuts", entry.cuts?.length === 2, `${entry.cuts?.length} cuts`);
  ok("it carries its tracts", entry.tracts?.length > 0, `${entry.tracts?.length} tracts`);

  const fresh = newCarver();
  const got = await fresh.apply(entry);
  ok("it reloads as one piece", got.length === 1, got.join(" "));
  const after = fresh.carves.get(unitOf(SUBJECT));
  const reloaded = after.pieces.find((p) => p.id === got[0]);
  ok("the same id", reloaded?.id === want.id, `${reloaded?.id} vs ${want.id}`);
  ok("the same area", reloaded && near(reloaded.area, want.area, want.area * 1e-12),
    `${((reloaded.area / want.area - 1) || 0).toExponential(2)} relative`);
  ok("the same population", reloaded?.row.pop === want.row.pop, `${reloaded?.row.pop} vs ${want.row.pop}`);

  const json = JSON.stringify(entry);
  ok("the entry is small", json.length < 4000, `${json.length} bytes`);
}

console.log("\nthe legacy entry a preset writes");
{
  // Bootheel names three tracts of New Madrid County and nothing else — the
  // shape every hand-authored preset uses, and what "Copy JSON" has always
  // written for a carved piece.
  const boot = PRESETS.find((p) => p.id === "bootheel-mo");
  const partial = boot.counties.find((c) => typeof c !== "string");
  const carver = newCarver();
  const got = await carver.apply(partial);
  ok("a { fips, tracts } entry loads", got.length === 1, got.join(" "));

  const c = carver.carves.get(unitOf(partial.fips));
  const piece = c.pieces.find((p) => p.id === got[0]);
  const held = [...piece.weights.keys()].sort();
  ok("it holds exactly those tracts", held.join(",") === [...partial.tracts].sort().join(","), held.join(" "));
  ok("the county is still whole", tiles(c).pass, tiles(c).note);

  // And it writes itself back out in the same shape it came in.
  const round = carver.serialize(piece.id);
  ok("it round-trips to the same shape",
    round.cuts == null && round.tracts.join(",") === held.join(","), JSON.stringify(round).slice(0, 120));
}

console.log("\ncircling an enclave");
{
  // A closed loop inside a county cuts the middle out. This is the case that
  // makes the cutter's one awkward rule necessary — a closed curve can sit
  // entirely inside one of the parent's triangles, where a chord walk has no
  // hole to give it, so the triangle is split with a straight auxiliary line
  // first and the loop then crosses both halves.
  const carver = newCarver();
  const [[x0, y0], [x1, y1]] = d3.geoBounds(feature(topo, topo.objects.counties).features[unitOf(SUBJECT)]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) * 0.15;
  const ry = (y1 - y0) * 0.15;
  const loop = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    loop.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  loop.push(loop[0]);
  const res = await carver.carve(loop);
  const c = carver.carves.get(unitOf(SUBJECT));
  ok("a loop carves", res.carved.length === 1 && c?.pieces.length === 2, JSON.stringify(res.carved));
  ok("the county still tiles", tiles(c).pass, tiles(c).note);
  const inner = Math.min(...c.pieces.map((p) => p.area));
  const outer = Math.max(...c.pieces.map((p) => p.area));
  ok("the enclave is the smaller piece", inner < outer * 0.5,
    `${(inner / c.area * 100).toFixed(1)}% inside`);
  ok("population still sums", c.pieces.reduce((s, p) => s + p.row.pop, 0) === countyRows[SUBJECT].pop);
}

console.log("\ntwo entries naming the same county");
{
  // Both sides of one cut, loaded separately. They have to converge on one
  // partition rather than each carving the county again — which is the whole
  // job of matching a cut already standing in the tree.
  const source = newCarver();
  await source.carve(strokeAcross(SUBJECT, 0.6));
  const src = source.carves.get(unitOf(SUBJECT));
  const a = source.serialize(src.pieces[0].id);
  const b = source.serialize(src.pieces[1].id);
  ok("the two sides are recorded opposite", a.cuts[0].side !== b.cuts[0].side,
    `${a.cuts[0].side} / ${b.cuts[0].side}`);

  const carver = newCarver();
  const gotA = await carver.apply(a);
  const gotB = await carver.apply(b);
  const c = carver.carves.get(unitOf(SUBJECT));
  ok("one partition, not two", c.pieces.length === 2, c.pieces.map((p) => p.id).join(" "));
  ok("and they are different pieces", gotA[0] !== gotB[0], `${gotA.join(",")} vs ${gotB.join(",")}`);
  ok("each keeps its population",
    pieceById(c, gotA[0]).row.pop === src.pieces.find((p) => p.id === gotA[0]).row.pop &&
      pieceById(c, gotB[0]).row.pop === src.pieces.find((p) => p.id === gotB[0]).row.pop);
}

console.log("\na whole preset that names tracts");
{
  // The Delta preset carves eleven counties along tract lines. Loading it is the
  // closest thing here to what the app will actually do at startup.
  const delta = PRESETS.find((p) => p.id === "delta-ar-ms");
  const partials = delta.counties.filter((c) => typeof c !== "string");
  const carver = newCarver();
  let claimed = 0;
  let missing = [];
  for (const entry of partials) {
    const got = await carver.apply(entry);
    if (got.length) claimed++;
    else missing.push(entry.fips);
  }
  ok("every partial county loads", claimed === partials.length, missing.length ? `missed ${missing.join(" ")}` : `${claimed} of ${partials.length}`);

  let worst = 0;
  let popOk = true;
  for (const c of carver.carves.values()) {
    const sum = c.pieces.reduce((s, p) => s + p.area, 0);
    worst = Math.max(worst, Math.abs(sum / c.area - 1));
    const want = countyRows[c.fips];
    if (want?.pop != null && c.pieces.reduce((s, p) => s + p.row.pop, 0) !== want.pop) popOk = false;
  }
  ok("all of them tile", worst < TILE_TOL, `worst ${worst.toExponential(2)} relative`);
  ok("all of their populations are conserved", popOk);
}

console.log("\nislands, and the antimeridian");
{
  // Aleutians West is 43 separate polygons and the county straddles 180, which
  // is the pair of cases the county frame exists for: a stroke arrives from
  // unproject in [-180, 180] and steps 358 degrees crossing the chain, and the
  // islands the cut misses have to be classified whole rather than dropped.
  const carver = newCarver();
  const res = await carver.carve([
    [178.5, 50.5],
    [178.5, 56.0],
  ]);
  const c = carver.carves.get(unitOf("02016"));
  ok("an antimeridian county carves", res.carved.length > 0 && c != null, JSON.stringify(res.carved));
  if (c) {
    ok("it tiles", tiles(c).pass, tiles(c).note);
    ok("both pieces have islands in them", c.pieces.every((p) => p.tris.length > 0),
      c.pieces.map((p) => `${p.id}:${p.tris.length}`).join(" "));
    ok("population is conserved",
      c.pieces.reduce((s, p) => s + p.row.pop, 0) === countyRows["02016"].pop);
    // The county's own longitudes run past 180 in its frame; a piece must not
    // have been torn in half by the numbers.
    const lons = c.pieces.flatMap((p) => p.tris.flat().map((v) => v[0]));
    ok("no piece straddles the numbering break",
      Math.max(...lons) - Math.min(...lons) < 180,
      `${Math.min(...lons).toFixed(1)} .. ${Math.max(...lons).toFixed(1)}`);
  }
}

console.log("\nthe lines between pieces");
{
  // The dividers are what a reader sees of the cut, and they are the one output
  // that cannot be checked by looking at areas.
  const carver = newCarver();
  await carver.carve(strokeAcross(SUBJECT, 0.45));
  const c = carver.carves.get(unitOf(SUBJECT));
  const d = c.dividers;
  ok("there are dividers", d.length > 0, `${d.length} segments`);
  ok("each separates two different pieces", d.every((s) => s.a !== s.b));
  ok("both sides name real pieces",
    d.every((s) => c.pieces.some((p) => p.id === s.a) && c.pieces.some((p) => p.id === s.b)));
  ok("none is degenerate",
    d.every((s) => Math.hypot(s.seg[0][0] - s.seg[1][0], s.seg[0][1] - s.seg[1][1]) > 0));

  // They should trace the drawn line, so their total length is about the width
  // of the county rather than some multiple of it.
  const len = d.reduce((t, s) => t + Math.hypot(s.seg[0][0] - s.seg[1][0], s.seg[0][1] - s.seg[1][1]), 0);
  const width = c.bounds.x1 - c.bounds.x0;
  ok("they add up to about one crossing", len > width * 0.5 && len < width * 2,
    `${len.toFixed(3)}° of divider across a ${width.toFixed(3)}° county`);
}

console.log("\nrejoining");
{
  const carver = newCarver();
  await carver.carve(strokeAcross(SUBJECT));
  const id = carver.carves.get(unitOf(SUBJECT)).pieces[0].id;
  ok("rejoin returns the county", carver.rejoin(id) === SUBJECT);
  ok("and the carve is gone", carver.carves.size === 0);
}

console.log("\nwhat it costs");
{
  const carver = newCarver();
  await fetchTracts(SUBJECT); //          the file read is not what is being measured
  let t0 = performance.now();
  await carver.carve(strokeAcross(SUBJECT));
  const first = performance.now() - t0;
  t0 = performance.now();
  await carver.carve(strokeAcross(SUBJECT, 0.7));
  const second = performance.now() - t0;
  const c = carver.carves.get(unitOf(SUBJECT));
  console.log(
    `  first cut ${first.toFixed(0)} ms, second ${second.toFixed(0)} ms  ` +
      `(${c.shapes.length} tracts, ${c.tris.length} parent triangles, ` +
      `${c.pieces.reduce((s, p) => s + p.tris.length, 0)} piece triangles, ` +
      `${c.dividers.length} divider segments)`
  );
  ok("a cut is under a quarter second", second < 250, `${second.toFixed(0)} ms`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
