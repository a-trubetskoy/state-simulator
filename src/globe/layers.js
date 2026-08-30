// C2/C3/C7 — the scene, in painter's order.
//
// There is no depth buffer. Order in this list is the only thing that decides
// what covers what, which is how the deck.gl stack works today too.
//
// C7 made this table the parity document: every entry below answers to a layer
// in src/main.js's buildLayers, in the same order and the same colours, so the
// two renderers can be put side by side and the differences read off one file
// rather than hunted through a renderer. Two kinds of switch appear here
// because main.js has exactly two:
//
//   hideInData   layers the data view drops outright.
//   dataColor    layers the data view keeps but re-colours.
//
// Anything that depends on WHO OWNS the ground — the band, the state borders,
// the selection outline — is not a switch here at all. Those read the per-unit
// attribute table in the shader (see UNIT_ATTR in shaders.js), so painting a
// county restyles them without touching this list.

const rgba = (hex, a = 255) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
  a / 255,
];

// Named for the thing each one paints, not for the constant it came from.
// main.js has both a WORLD_LAND (the tan the scenery wears, shared with a
// non-union unit) and a LAND (the dark line along a land border beyond the
// map's units); reading the second for the first turned every continent
// outside North America into a slate-grey void, which is what the names below
// exist to prevent.
export const COLORS = {
  sphere: rgba("#e8f1f7"), //     main.js OCEAN
  worldLand: rgba("#faf7f1"), //  main.js WORLD_LAND = FOREIGN_FILL
  borderLine: rgba("#5b6472"), // main.js LAND
  lake: rgba("#d5e8f4"),
  halo: rgba("#cde4f2"),
  coast: rgba("#8ab8d6"),
  countyLine: rgba("#ffffff", 128),
  stateLine: rgba("#999999"),
  graticule: rgba("#b9cfdf", 150),
  nation: rgba("#ffffff"),
  white: rgba("#ffffff"),
  // Data view: the ground carries no colour of its own, non-union units keep a
  // pale wash of the atlas tan, and a state with no reading goes grey.
  greyLand: rgba("#e4e4e4"),
  noData: rgba("#cccccc"),
  foreignLand: rgba("#f4f0e9"),
  // 7% black over the county under the pointer, composited over the finished
  // map — main.js's HOVER, which is the same 0.93 multiply the overlay used.
  hover: [0, 0, 0, 18 / 255],
  // The carve stroke in flight, over the presented scene.
  knife: rgba("#e53e3e", 235),
  // Fallback for the selection outline before a state is picked; the real
  // colour is the selected state's own fill pushed darker, set per frame.
  outline: rgba("#333333"),
};

export const BAND_WIDTH = 10; // css px across the border, so five to a side

// The border groups the band's stencil stroke runs along, and the same list the
// selection outline is subset from. Everything else is a line neither has any
// business following — a graticule, a lake edge, scenery beyond the map's units
// — so listing them keeps those draw calls off the queue rather than culling
// them per instance.
export const BAND_GROUPS = ["coast", "lakeshore", "border", "countyArcs", "seams"];

// What the two sides of a line instance decide. Mirrors the constants in
// LINE_VS; see the note there.
export const MODE = { plain: 0, arcs: 1, band: 2, outline: 3 };

export function buildLayers() {
  const line = (group, color, width, extra = {}) => ({
    kind: "line",
    group,
    color,
    width,
    mode: MODE.plain,
    ...extra,
  });
  const fill = (group, color, extra = {}) => ({ kind: "fill", group, color, ...extra });

  return [
    // Globe furniture, under everything. Without them the scene clears to the
    // page white.
    { kind: "disc", color: COLORS.sphere, name: "sphere" },
    line("graticule", COLORS.graticule, 0.7),

    // --- the world behind the map
    // Scenery in both views. The map's own units cover none of it — the build
    // leaves out every country the map draws — so nothing overlaps and no
    // seam shows.
    line("worldCoast", COLORS.halo, 16, { name: "world coast halo", hideInData: true }),
    fill("worldLand", COLORS.worldLand, { dataColor: COLORS.foreignLand }),
    line("worldBorders", COLORS.countyLine, 1, { hideInData: true }),
    line("worldCoast", COLORS.coast, 1.1, { name: "world coast line" }),

    // --- the map
    // Water first: the lakes the Census file carves out of the land, under the
    // white backing, so they show through the holes the county fills leave. The
    // slight same-colour stroke closes generalization slivers against the
    // shoreline, and its overshoot hides under the backing.
    fill("lakesUnder", COLORS.lake, { hideInData: true }),
    line("lakeEdgesUnder", COLORS.lake, 2, { hideInData: true }),
    line("coast", COLORS.halo, 16, { name: "coast halo", hideInData: true }),
    fill("nation", COLORS.nation, { stencil: "write" }),
    // The aprons ship unclipped — 6 km of real triangles either side of a seam.
    // Clipping them to the nation mesh with a stencil is both cheaper and more
    // exact than a build-time boolean, and the nation mesh is already there as
    // the white backing.
    fill("aprons", COLORS.nation, { useUnit: true, stencil: "test" }),
    // `carved` means the dynamic buffer draws here too. A carved county's own
    // fill is switched off through the palette and its pieces take its place, so
    // the two together still paint exactly the ground the county had.
    fill("counties", COLORS.nation, { useUnit: true, carved: true }),
    // The counties over again in their deeper colour, showing only inside a
    // stroke along the state borders. Drawing the strip directly instead — a
    // quad extruded off each border segment — put white into the sea at a third
    // of the coast's segments, because a quad perpendicular to one segment knows
    // nothing about where the unit goes next.
    { kind: "band", name: "band", group: "counties", width: BAND_WIDTH, hideInData: true },
    // One layer, two groups, two colours: a state border wears grey and every
    // other arc the white hairline, decided per instance from the unit pair. A
    // seam is a state border that happens to come from a second source, so it
    // belongs here beside the shared county arcs. In the data view the hairline
    // goes to zero alpha — county lines do not exist there — and the shader
    // drops those instances outright.
    line(["countyArcs", "seams"], COLORS.countyLine, 1, {
      skipEqual: true,
      carved: true,
      name: "map lines",
      mode: MODE.arcs,
      colorB: COLORS.stateLine,
      dataColor: [0, 0, 0, 0],
    }),
    // The map's outer edge: blue where the far side is water, and that means
    // the Great Lakes as well as the ocean, so the lakeshore runs belong here
    // beside the coast ones. They differ only in the halo above, which the
    // coast gets and a lakeshore does not.
    line(["coast", "lakeshore"], COLORS.coast, 1.1, { name: "coast line" }),
    // Last, and over the map rather than behind it. These are Natural Earth's
    // lake polygons at full detail, and up here they cover the nation mesh's
    // own lake shoreline — the Census outline generalized at 1.6 km, which
    // facets visibly past about 4x zoom. Drawn under the map they would be
    // hidden by the very edge they are meant to replace. They therefore do the
    // job main.js splits between its world-lakes and lakes-over layers, and go
    // page white in the data view exactly as those do: water carries no data.
    fill("worldLakes", COLORS.lake, { dataColor: COLORS.white }),
    line("worldLakeEdges", COLORS.coast, 1.1),
    line("border", COLORS.borderLine, 1.1, { name: "border line" }),
    // The selected state's edge: a dark line over a wider white casing, which
    // cuts a bright gap between the line and the border bands on either side.
    // Both are the same subset of the same strokes the band runs along, picked
    // out in the shader by the selected bit rather than by a CPU-side filter.
    line(BAND_GROUPS, COLORS.white, 5.6, { name: "selection casing", mode: MODE.outline }),
    line(BAND_GROUPS, COLORS.outline, 2.6, {
      name: "selection outline",
      mode: MODE.outline,
      role: "selection",
    }),
  ];
}
