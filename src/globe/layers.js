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
// One switch is not the app's but the camera's: `fadeIn` gives a layer a zoom
// range to appear over, so a layer can be absent at a wide view and ordinary at
// a close one. The river tiers are what it exists for.
//
//   showWhenSelected  suspends that fade for the part of a layer that belongs
//                     to the SELECTED state, and only that part: those features
//                     draw at full strength whatever the zoom while the rest of
//                     the map keeps the fade. Only the cities use it, and the
//                     reason is in their entry at the foot of this file.
//
// Anything that depends on WHO OWNS the ground — the band, the state borders,
// the selection outline — is not a switch here at all. Those read the per-unit
// attribute table in the shader (see UNIT_ATTR in shaders.js), so painting a
// county restyles them without touching this list.

import {
  BAND_WIDTH,
  COAST,
  COUNTRY_LINE,
  COUNTY_LINE,
  FOREIGN_LAND,
  GRATICULE_LINE,
  GREY_LAND,
  HALO,
  HOVER,
  KNIFE,
  LAKE,
  LAND,
  NO_DATA,
  OCEAN,
  OUTLINE_FALLBACK,
  STATE_LINE,
  WHITE,
  WORLD_LAND,
} from "../palette.js";

export { BAND_WIDTH };

// palette.js is the one place a colour is defined — both renderers read it, so
// the parity this file documents cannot drift shade by shade. It speaks
// deck.gl's 0-255 bytes; the GL pipeline here wants 0-1 floats.
const f = ([r, g, b, a]) => [r / 255, g / 255, b / 255, a / 255];

// Named for the thing each one paints, not for the constant it came from.
// palette.js has both a WORLD_LAND (the tan the scenery wears, shared with a
// non-union unit) and a LAND (the dark line along a land border beyond the
// map's units); reading the second for the first turned every continent
// outside North America into a slate-grey void, which is what the names below
// exist to prevent.
export const COLORS = {
  sphere: f(OCEAN),
  worldLand: f(WORLD_LAND),
  borderLine: f(LAND),
  lake: f(LAKE),
  halo: f(HALO),
  coast: f(COAST),
  countyLine: f(COUNTY_LINE),
  stateLine: f(STATE_LINE),
  countryLine: f(COUNTRY_LINE), // borders between OTHER countries, in the world scenery
  graticule: f(GRATICULE_LINE),
  nation: f(WHITE),
  white: f(WHITE),
  // Data view: the ground carries no colour of its own, non-union units keep a
  // pale wash of the atlas tan, and a state with no reading goes grey.
  greyLand: f(GREY_LAND),
  noData: f(NO_DATA),
  foreignLand: f(FOREIGN_LAND),
  // 7% black over the county under the pointer, composited over the finished
  // map — the same 0.93 multiply the overlay used.
  hover: f(HOVER),
  // The carve stroke in flight, over the presented scene.
  knife: f(KNIFE),
  // Fallback for the selection outline before a state is picked; the real
  // colour is the selected state's own fill pushed darker, set per frame.
  outline: f(OUTLINE_FALLBACK),
};

// How far in a zoom range has come: 0 below it, 1 above it, a straight ramp
// across it. Read off d3.zoom's own scale factor — the number the user turns —
// rather than off a pixel radius, so a layer arrives at the same zoom whatever
// size the window is.
export const rampAt = (k, [k0, k1]) => Math.max(0, Math.min(1, (k - k0) / (k1 - k0)));

// The zooms the cities arrive over. Early, because the biggest of them are
// continental landmarks rather than local detail: at a whole-continent view a
// dozen dots for Chicago, Mexico City and Toronto tell you where you are
// looking, and cities.js's own rank cut is what keeps it to a dozen.
//
// It ENDS at 2, where cities.js's rank cut still admits nothing past rank 1.
// That gives the 68 largest cities in the world a zoom of their own, at full
// ink, before rank 2 arrives at 3.5. Ending the fade at 3.5 instead put the
// two events on the same zoom, so the biggest cities were still coming up out
// of the paper at the moment the next tier landed on top of them — they were
// never once the only thing on the map.
export const CITY_FADE = [1, 2];

// A SEPARATE range from CITY_FADE, and a later one. The state labels give way
// once the city names are dense enough to have taken over the job of saying
// what is on the ground, not the moment the first dot appears — tying the two
// together would pull the atlas type down at zoom 2, where it is still the only
// thing naming anything.
//
// It starts at 4, about a state's width: by then several city names are on the
// ground in every state on screen, and a name stretched across the whole of one
// has stopped being read as a label and started being read as something lying
// over the map. It reaches the floor at 9, which is where this range used to
// begin — so the atlas type is at its palest by a county-scale view rather than
// only at the very end of the zoom.
export const STATE_LABEL_FADE = [4, 9];

// What the map's own state labels fall to across that range. The two label
// sets compete for the same ground, and by those zooms the atlas type has
// stopped being the thing you are reading: a name set to span a whole state
// is, at a county-sized view, a pale word lying across everything. It fades
// rather than going out, because it is still the answer to "which state am I
// in" — a question a city name does not answer.
export const STATE_LABEL_DIM = 0.22;

// Where the county hairline stops drawing the thinned boundary and starts
// drawing the full one. Below this, a border that follows a river packs several
// vertices into a pixel and the blended capsules stack into a band a couple of
// pixels wide and near-solid white, while a survey-line border a county away
// stays a hairline — so the same kind of line reads as two different weights.
// The compiler ships a second copy of the boundary thinned to 2 km for these
// zooms; see COARSE_TOLERANCE_KM in scripts/build-geometry.mjs.
//
// 2 is a step above where the effect is first objectionable, so the whole of
// the range it shows in is covered. The swap is a hard one rather than a fade,
// and that is the point: a fade draws both tiers at once, and two copies of one
// border at half alpha each pile up into exactly the extra weight the coarse
// tier exists to remove. It does not flash, because the two tiers differ by
// less than the width of the line that moves — at this zoom no point of the
// thinned boundary is more than 0.85 px from the full one and half of them are
// within 0.32 px, measuring in design-box units at k=1 the way the m/px figure
// in camera.js does, so on a window that fits the box at 1.3x it is a little
// over a pixel at worst.
//
// Raising it covers more zooms and makes the swap more visible; the tolerance
// and this number trade against each other and want tuning together.
export const COARSE_ZOOM = 2;

// How the river tiers thicken as the view closes in: from their nominal width
// at zoom 4, where the first tier has just arrived, to 6x it at 16, the closest
// the camera goes. Rivers are the one thing on the map whose width is
// worth more than a hairline up close — at the zoom where a county fills the
// screen, the river through it is the feature being looked at, and a 1 px thread
// reads as a scratch on the fill rather than as water. Nothing else grows: a
// county line or a coastline is a boundary, and a boundary wants to be findable,
// not loud.
//
// At the top of the range a major river is 6 px against the coastline's 1.1, and
// that is deliberate rather than a stroke that got away: this is the zoom where
// a county fills the screen, and at that scale a river is a thing with a width,
// not a boundary between two grounds. It also hides the thinning. Points are
// 1.6 km apart and a kilometre is about 3.4 px at zoom 16, so the facets are
// roughly 5 px long — a 6 px stroke with round joins is wider than its own
// faceting, and the line reads as a curve instead of a chain of chords.
//
// Linear in k puts most of the growth in the last octave, which is where it is
// wanted: 4 to 8 is a doubling of the zoom and a third of the growth, 8 to 16 is
// the other doubling and the remaining two thirds.
//
// Every tier shares this range and this factor, so the taper between them holds
// at every zoom rather than closing up at one end. layer-check enforces both
// that and the ceiling of 16 — a range that topped out past MAX_ZOOM would be a
// width the map could never reach.
const RIVER_GROW = [4, 16, 6];

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

  // The county hairline, as a pair of layers that differ only in which copy of
  // the boundary they draw and which side of COARSE_ZOOM they draw it on. One
  // style, written once, so the two tiers cannot drift apart in colour or
  // width — which would turn the swap from invisible into a flash.
  const mapLines = () => {
    const style = {
      skipEqual: true,
      carved: true,
      tier: "map lines",
      mode: MODE.arcs,
      colorB: COLORS.stateLine,
      dataColor: [0, 0, 0, 0],
    };
    return [
      line(["countyArcsCoarse", "seamsCoarse"], COLORS.countyLine, 1, {
        ...style,
        name: "map lines (wide views)",
        zoom: [null, COARSE_ZOOM],
      }),
      line(["countyArcs", "seams"], COLORS.countyLine, 1, {
        ...style,
        name: "map lines",
        zoom: [COARSE_ZOOM, null],
      }),
    ];
  };

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
    // Solid, not dotted. An atlas dots a national boundary to tell it from a
    // coastline, and it was tried here — but a dash needs a phase that runs the
    // length of the border, and a line instance only knows its own segment. The
    // border segments are shorter than any useful dot spacing at the zooms this
    // layer is seen at (median 0.40 px at the globe fit, 1.91 px at the home
    // view, against a 5 px period), so a per-segment phase restarts inside every
    // dot and the pattern closes up into a solid line anyway — with a smear at
    // the close zooms where the segments do get long enough to break. Dots here
    // would mean a per-instance arc length baked into the geometry; the colour
    // already separates a border from a shoreline, which is the job.
    line("worldBorders", COLORS.countryLine, 1, { hideInData: true }),
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
    // One layer, two groups, two colours: a state border wears the full grey
    // and every other arc the faint hairline, decided per instance from the
    // unit pair. A
    // seam is a state border that happens to come from a second source, so it
    // belongs here beside the shared county arcs. In the data view the hairline
    // goes to zero alpha — county lines do not exist there — and the shader
    // drops those instances outright.
    //
    // Written twice, at two levels of detail, because this is the one layer
    // narrow enough for the boundary's own roughness to show as extra width:
    // see COARSE_ZOOM above. `tier` marks the two as one layer, and the check
    // holds their zoom ranges to meeting exactly — a gap there is a zoom with
    // no county lines at all, and an overlap is both tiers drawn over each
    // other, which is the fault this exists to fix.
    //
    // The nearest thing in main.js is a single deck.gl PathLayer over the full
    // detail, so the parity this file documents holds above COARSE_ZOOM and is
    // deliberately broken below it.
    ...mapLines(),
    // Rivers, over the ground and under every edge of the water they run into.
    // Above the county fills and the border band, because a river is a fact
    // about the ground and breaking it wherever a state line happens to fall
    // would read as a rendering fault. Below the coastline and the lakes,
    // because a river ends where the water starts: drawn under those, a mouth
    // that overshoots its estuary or a stream that overshoots a lake shore is
    // covered by the edge it overshot instead of striking out across open
    // water. The coastline's blue, and gone in the data view, where the ground
    // is read by colour and a thread across it is only clutter.
    //
    // Four tiers, coarsest first, each fading in over a stretch of the zoom.
    // Drawing all of them at every zoom is right at no zoom at all: 5,236 lines
    // over a whole globe is a haze, and the same 5,236 is thin once the view is
    // down to a few counties. build-world.mjs decides what falls in each tier;
    // this is where they appear.
    //
    // The ranges are in d3.zoom's own k, which is what the user turns: 0.2 puts
    // the whole sphere in frame, 1 is the home view over the lower 48, 16 is as
    // close as the view goes. They do not overlap, so at most one tier is ever
    // mid-fade, and each is fully in before the next begins. A fade rather than
    // a switch because 267 lines arriving at one threshold reads as a flash.
    //
    // The home view carries no rivers at all: the first tier starts at 2, a zoom
    // step past it. At the scale where the lower 48 fits on screen a river is a
    // thread that adds texture and no information, and the map is about who owns
    // the ground. Rivers are what you find on the way in, and by the last zoom
    // step every one Natural Earth draws is there.
    //
    // They interleave with the lake tiers above rather than landing on the same
    // zooms, so each step in brings one kind of water and then the other instead
    // of doubling the map's detail at a stroke.
    //
    // Width tapers with the tier. Natural Earth's world river file carries no
    // stroke weight of its own — only its North America supplement does, and
    // build-world.mjs spends that on deciding which tier a river lands in
    // rather than on how wide it draws — but the tiers ARE a weight, and a
    // Mississippi heavier than a creek does more for legibility than the
    // filtering does. The whole taper then thickens with the zoom, by
    // RIVER_GROW above.
    line("rivers1", COLORS.coast, 1, {
      name: "rivers major",
      hideInData: true,
      fadeIn: [2.8, 3.8],
      grow: RIVER_GROW,
    }),
    line("rivers2", COLORS.coast, 0.85, {
      name: "rivers large",
      hideInData: true,
      fadeIn: [6.5, 8],
      grow: RIVER_GROW,
    }),
    line("rivers3", COLORS.coast, 0.72, {
      name: "rivers small",
      hideInData: true,
      fadeIn: [10.5, 12],
      grow: RIVER_GROW,
    }),
    line("rivers4", COLORS.coast, 0.6, {
      name: "rivers finest",
      hideInData: true,
      fadeIn: [13, 15],
      grow: RIVER_GROW,
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
    //
    // Four tiers by area, largest first, brought in with the zoom the way the
    // rivers are. All 1,346 at a whole-continent view is a rash of blue specks,
    // most of them under a pixel; the first tier is the 90 an atlas prints at
    // that scale, and the rest arrive as there is room for them.
    //
    // The first tier never fades, and that is a correctness rule rather than a
    // taste one. Natural Earth carves its largest lakes out of the land it
    // draws, so those lakes are HOLES: with no water in them the ocean shows
    // through the middle of a continent, and the coast halo that hides under
    // the land rings them in sea blue. build-world.mjs pins every carved lake
    // to this tier whatever its area, and layer-check holds the tier to no fade.
    //
    // Every fill first, then every shore. A named bay can reuse its parent
    // lake's ring and land in a different tier by area, so a later tier's fill
    // drawn between the pairs could cover an earlier tier's shoreline.
    fill("worldLakes1", COLORS.lake, { name: "lakes major", dataColor: COLORS.white }),
    fill("worldLakes2", COLORS.lake, {
      name: "lakes large",
      dataColor: COLORS.white,
      fadeIn: [1.5, 2.5],
    }),
    fill("worldLakes3", COLORS.lake, {
      name: "lakes small",
      dataColor: COLORS.white,
      fadeIn: [4.5, 6],
    }),
    fill("worldLakes4", COLORS.lake, {
      name: "lakes finest",
      dataColor: COLORS.white,
      fadeIn: [8.5, 10],
    }),
    line("worldLakeEdges1", COLORS.coast, 1.1, { name: "lake shores major" }),
    line("worldLakeEdges2", COLORS.coast, 1.1, {
      name: "lake shores large",
      fadeIn: [1.5, 2.5],
    }),
    line("worldLakeEdges3", COLORS.coast, 1.1, {
      name: "lake shores small",
      fadeIn: [4.5, 6],
    }),
    line("worldLakeEdges4", COLORS.coast, 1.1, {
      name: "lake shores finest",
      fadeIn: [8.5, 10],
    }),
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
    // CITIES: a dot on each town and its name, from Natural Earth by way of
    // cities.js, with the state capital's name underlined. Last in the list, so
    // they sit over every fill, band, river and hairline on the map — a name
    // with a river ruled through it is the one thing a label may not be.
    //
    // They are drawn rather than taken from a tile server because no free sheet
    // is cities alone: Esri's are either names with no dot, or dots fused into
    // one image with state labels and country boundaries this map already draws
    // for itself. See the head of cities.js.
    //
    // Full alpha under the fade: a name is either legible or it is clutter.
    // Only the map's own state labels go above these, and those give way on a
    // later range of their own — see STATE_LABEL_FADE.
    //
    // Selecting a state suspends the fade INSIDE that state. The fade answers
    // "is the view close enough for towns to mean anything", and a selection
    // answers it instead for the state asked about: that state is about places
    // now, at whatever zoom the question was asked from. Without this the
    // selected state's own capital — which cities.js draws whatever the zoom —
    // would be drawn at alpha zero at the home view, which is where a state is
    // most often picked.
    //
    // Inside that state and nowhere else, which is the whole of why the alpha
    // is two numbers rather than one. Lifting the layer's own fade instead
    // brought every city in the world up out of the paper the moment a state
    // was picked at the home view: asked about Texas, the map answered with San
    // Francisco and Chicago.
    {
      kind: "cities",
      name: "cities",
      color: [1, 1, 1, 1],
      fadeIn: CITY_FADE,
      showWhenSelected: true,
      hideInData: true,
    },
  ];
}
