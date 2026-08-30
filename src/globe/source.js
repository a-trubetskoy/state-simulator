// C4/C5 — the source rings, in lon/lat.
//
// The compiled buffers are positions on the unit sphere, which is everything
// the renderer needs and nothing the picker or the labeler does. Both of those
// want the rings themselves: the picker to test containment, the labeler to
// rasterize territory. So they read the same topojson the app already loads —
// no second copy of the geometry, and no new build step.
//
// The unit order here is the id order in the compiled manifest, which is the
// id every fill vertex, every line side and every palette texel carries. Both
// come from `counties.map(f => f.id)` over this same file, so they agree by
// construction; the check below is there because if they ever stop agreeing,
// every colour on the map lands on the wrong county and nothing else says so.

import { feature } from "topojson-client";

const polygonsOf = (geometry) =>
  geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

export async function loadUnits({
  url = "/data/na-counties-topo.json",
  manifest,
  signal,
  // The app has already fetched and decoded this file; handing the features
  // straight over saves a second 2 MB parse. The harness and the checks leave
  // it out and get the fetch.
  features: given,
} = {}) {
  let features = given;
  if (!features) {
    const topo = await (await fetch(url, { signal })).json();
    features = feature(topo, topo.objects.counties).features;
  }
  const units = features.map((f) => ({
    id: f.id,
    // Census county names, so a readout can say "Cook" rather than "17031".
    name: f.properties?.name ?? f.id,
    // The state the unit starts in — the app's opening assignment, and what
    // C5's labeler groups by until the user paints something else.
    st: f.properties?.st,
    polygons: polygonsOf(f.geometry),
  }));

  const want = manifest?.units;
  if (want) {
    if (want.length !== units.length)
      throw new Error(`${url} has ${units.length} units, the manifest ${want.length}`);
    const bad = units.findIndex((u, i) => u.id !== want[i]);
    if (bad >= 0)
      throw new Error(
        `unit ${bad} is ${units[bad].id} here and ${want[bad]} in the manifest — ` +
          `the compiled geometry is stale, rerun npm run data:geometry`
      );
  }
  return units;
}
