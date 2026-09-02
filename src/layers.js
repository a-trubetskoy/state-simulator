// The deck.gl layer list: everything the map draws, in draw order, rebuilt
// from scratch on every refresh. Three stacks come out — the map canvas, the
// hover canvas above it, and the inset canvas above that — because deck.gl
// redraws a whole deck when any one layer's data changes, and the hover tint
// changes on every mouse move.
//
// This runs on the deck.gl path. The WebGL globe on `/` draws the same map
// from compiled geometry instead (see globe/layers.js); `?deck` selects this
// one. Both read the same color definitions, so a state wears the same fill
// either way — see groundColors, which the caller passes in.
//
// Everything the layer list reads is declared in the two argument lists
// below: the fixed pieces once at wiring time, and the four that change on
// every refresh per call, so a layer can never be built from a stale model.

import * as d3 from "d3";
import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { DataFilterExtension, MaskExtension } from "@deck.gl/extensions";
import { PathLayer, PolygonLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import {
  BAND_WIDTH,
  COAST,
  COUNTRY_LINE,
  COUNTY_LINE,
  FOREIGN_LAND,
  GRATICULE_LINE,
  HALO,
  LAKE,
  LAND,
  OCEAN,
  OUTLINE_FALLBACK,
  STATE_LINE,
  TRANSPARENT,
  WHITE,
  WORLD_LAND,
  rgba,
} from "./palette.js";
import { SYMBOL_STATS } from "./stats.js";

// Deck.gl glue, here rather than in palette.js so the palette stays a pure
// color table both renderers (and the node check scripts) can import. The
// extension instances are built once because deck.gl compares them by
// reference: a fresh array per rebuild would look like a change.
export const FLAT = { coordinateSystem: COORDINATE_SYSTEM.CARTESIAN };
export const EMPTY = [];
export const BORDER_EXT = [new DataFilterExtension({ filterSize: 1 })];
export const BAND_EXT = [new MaskExtension()];
export const SHOWN = [0.5, 1.5];

/**
 * @param deps everything the layer list reads that does not change between
 *   refreshes: the baked geometry it draws, the model it asks about, and the
 *   data-view pieces (fills, marks, hover and selection shapes) computed for
 *   it in main.js. Functions are called, never captured, so the values they
 *   return are always current.
 * @returns buildLayers({ V, assign, selected, mapVersion }) -> the three stacks
 */
export function createLayerBuilder({
  // Baked geometry and the view it is baked for. RIVER_TIERS stays owned by
  // main.js, which reads the same tiers out of the world topology at load.
  MAIN,
  RIVER_TIERS,
  SPHERE_DISC,
  insetCountyGeo,
  insetHidden,
  // The model. Both of these are read through a call rather than captured:
  // the wiring runs before the sidebar's controls exist.
  stateInfo,
  inDataView,
  statKeyOf,
  // The data view's computed pieces (see the data view section in main.js).
  groundColors,
  stateCentroids,
  symbolData,
  computeSymbolData,
  dotPositions,
  DOT_R,
  selectedEdges,
  hoverSplit,
  countyHoverLayer,
  insetHoverLayer,
}) {
  /**
   * @param V           the visible geometry for this refresh (see rebuildVisible)
   * @param assign      unit id -> the state that owns it
   * @param selected    the selected state id, or null
   * @param mapVersion  bumped whenever the drawn geometry changes, so deck.gl
   *                    can tell a real rebuild from an identical one
   */
  return function buildLayers({ V, assign, selected, mapVersion }) {
    const trigger = mapVersion;
    const dataView = inDataView();
    const statKey = statKeyOf();
    const symbol = dataView ? SYMBOL_STATS[statKey] : undefined;
    const symbols = symbol ? symbolData(statKey) : EMPTY;
    // Each open inset gets its own marks, sized and placed from its own county
    // duplicates (insetCountyGeo) rather than the globe copies above — the
    // same reasoning as the inset data labels.
    const insetSymbols = symbol
      ? ["ak", "hi"].flatMap((region) =>
          insetHidden[region] ? [] : computeSymbolData(statKey, stateCentroids(insetCountyGeo[region]))
        )
      : EMPTY;
    // Keyed by state, not by part: the deck layers below look one up per record,
    // and the globe writes each one into the palette once per unit. Same
    // definitions either way — see groundColors.
    const { fillOf: fillForState, bandOf: bandForState, groundOf } = groundColors();
    const fillOf = (part) => fillForState(assign.get(part.fips));
    const bandOf = (part) => bandForState(assign.get(part.fips));
    const countyFill = (part) => groundOf(assign.get(part.fips));

    const isBorder = (d) => assign.get(d.a) !== assign.get(d.b);
    // County hairlines and state borders share one layer per deck: same arc
    // data, same width, only the color differs per segment — so the continent's
    // arcs make one pass instead of two. A state border draws the full grey;
    // every other arc draws the faint hairline in atlas view and nothing in data view,
    // where county lines don't exist. Painting restyles segments through the
    // same per-segment attribute update the old filter used.
    const lineColor = (d) =>
      (isBorder(d) && !foreignBorder(d)) || foreignCountryBorder(d)
        ? STATE_LINE
        : dataView
          ? TRANSPARENT
          : COUNTY_LINE;
    // Borders between two units that are both still outside the union get no
    // state-border treatment (no band, no grey line): unpainted territory all
    // wears one tan and reads as context, not as states. The county
    // hairline still separates the units, and the US–foreign seam keeps the
    // full treatment — it is the union's outer edge.
    const isForeignSid = (sid) => stateInfo.get(sid)?.foreign;
    const foreignBorder = (d) =>
      isForeignSid(assign.get(d.a)) && isForeignSid(assign.get(d.b));
    // The exception to that: two foreign units in different COUNTRIES are
    // divided by an international border, and the world scenery draws its own in
    // this same grey. Mexico–Guatemala is the case inside the map; without this
    // it wore the hairline that separates two Mexican states. A state with no
    // flag is its own country, keyed on its id — see countryOf in paintGlobe,
    // which is the globe's version of this same rule.
    const countryKey = (sid) => stateInfo.get(sid)?.country ?? `~${sid}`;
    const foreignCountryBorder = (d) =>
      foreignBorder(d) && countryKey(assign.get(d.a)) !== countryKey(assign.get(d.b));
    // Which segments carry the border band. Interior segments — shared arcs
    // and the appended seam segments — wear it while their two sides belong
    // to different members of the union. Edge runs (the map's outer boundary)
    // wear it while the unit that owns them is in the union, so a foreign
    // unit's coastline stays bare until its territory is painted in.
    const bandFilter = (d) =>
      (d.edge ? !isForeignSid(assign.get(d.a)) : isBorder(d) && !foreignBorder(d)) ? 1 : 0;
    // The selected state's edge segments, already subset and cached (see
    // selectedEdges above).
    const selEdge = selectedEdges();
    // The atlas outline is the selected state's own color pushed darker; in data
    // view that color means nothing, so a neutral dark line marks the selection.
    const outline = !selected
      ? WHITE
      : dataView
        ? OUTLINE_FALLBACK
        : rgba(d3.color(stateInfo.get(selected).color).darker(1.4));

    const { main: hoverMain, inset: hoverInset } = hoverSplit();

    // Hover highlight: 7% black over the county (or, in data view, the state)
    // under the pointer, the same 0.93 multiply the overlay path used to give.
    // It gets a deck to itself because deck.gl redraws a whole deck whenever any
    // layer's data changes: left in the map stack, one mouse move repainted all
    // ~20 map layers and threw away the picking buffer that the next pick then
    // had to rebuild. The cost of the move is compositing order â this canvas
    // is above the map's lines, lakes, data symbols and selection outline, so
    // the tint now falls on those too instead of sitting under them. The inset
    // hover stays down in the inset stack (below), where it has to be: this
    // canvas is under the inset canvas, so a tint drawn here would vanish
    // beneath the boxes' white backing.
    const hoverLayers = [countyHoverLayer(hoverMain)];

    const mapLayers = [
      // Globe furniture, under everything: the ocean disc is the sphere itself,
      // and the graticule rides on it.
      new SolidPolygonLayer({
        id: "globe-sphere",
        data: [SPHERE_DISC],
        getPolygon: (d) => d.rings,
        getFillColor: OCEAN,
        ...FLAT,
      }),
      new PathLayer({
        id: "globe-graticule",
        data: MAIN.graticulePaths,
        getPath: (d) => d.path,
        getColor: GRATICULE_LINE,
        getWidth: 0.7,
        widthUnits: "common",
        ...FLAT,
      }),
      // The rest of the world, under everything the map proper draws. It is
      // scenery in both views: the sphere is bare without it. The map's own
      // units cover none of it — the build leaves out every country the map
      // draws — so nothing overlaps and no seam shows.
      //
      // The six layers are the map's own stack in miniature, in the same order
      // and the same colors: halo under the land, then the fill, the lines
      // between countries, the lakes over them, and the shoreline last. What it
      // leaves out is everything that belongs to a paintable unit — no border
      // band, no selection, no hover, no state line.
      new PathLayer({
        id: "world-coast-halo",
        data: MAIN.worldCoastPaths,
        visible: !dataView,
        getPath: (d) => d.path,
        getColor: HALO,
        getWidth: 16,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "world-land",
        data: MAIN.worldParts,
        getPolygon: (d) => d.rings,
        getFillColor: dataView ? FOREIGN_LAND : WORLD_LAND,
        ...FLAT,
      }),
      // Country lines, like the county hairlines they match: gone in data view,
      // where the ground is read by color and a line inside it would only break
      // the wash up. Grey rather than the hairline white — see COUNTRY_LINE.
      new PathLayer({
        id: "world-borders",
        data: MAIN.worldBorderPaths,
        visible: !dataView,
        getPath: (d) => d.path,
        getColor: COUNTRY_LINE,
        getWidth: 1,
        widthUnits: "pixels",
        capRounded: true,
        ...FLAT,
      }),
      // Natural Earth carves the largest lakes out of the countries it draws and
      // leaves the rest sitting inside them, so these are drawn over the land
      // either way: over a hole they fill it, over a country they cover it. Both
      // read the same, which is what the map's own two lake layers achieve
      // between them.
      new SolidPolygonLayer({
        id: "world-lakes",
        data: MAIN.worldLakeParts,
        getPolygon: (d) => d.rings,
        getFillColor: dataView ? WHITE : LAKE,
        ...FLAT,
      }),
      new PathLayer({
        id: "world-lake-edges",
        data: MAIN.worldLakeEdges,
        getPath: (d) => d.path,
        getColor: COAST,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new PathLayer({
        id: "world-coast-line",
        data: MAIN.worldCoastPaths,
        getPath: (d) => d.path,
        getColor: COAST,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      // Water first: lakes the Census file carves out of the land, then a soft
      // halo along the ocean shoreline (only — a halo over a Great Lake would
      // ring it in an off shade). The lakes get a slight same-color stroke to
      // close generalization slivers against the Census shoreline; the overshoot
      // hides under the white nation shape drawn on top of them. Data view
      // drops the blue water fill and the halo: carved lakes show the page
      // white through their holes (their shoreline stays, via coast-line
      // below), and the on-top lakes further down match by going white.
      new SolidPolygonLayer({
        id: "lakes-under",
        data: MAIN.lakesUnder,
        visible: !dataView,
        getPolygon: (d) => d.rings,
        getFillColor: LAKE,
        ...FLAT,
      }),
      new PathLayer({
        id: "lakes-under-edge",
        data: MAIN.lakeEdgesUnder,
        visible: !dataView,
        getPath: (d) => d.path,
        getColor: LAKE,
        getWidth: 2,
        widthUnits: "common",
        ...FLAT,
      }),
      // Not drawn: this stroke only feeds the band's mask, below. It is a plain
      // line straddling every state border and the nation's edge, so it covers
      // exactly the ground within half its width of a border — including, where
      // a river border doubles back on itself, the whole of a meander too tight
      // to hold a band.
      new PathLayer({
        id: "band-mask",
        data: MAIN.bandMaskPaths,
        visible: !dataView,
        operation: "mask",
        getPath: (d) => d.path,
        getWidth: BAND_WIDTH,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        getFilterValue: bandFilter,
        filterRange: SHOWN,
        updateTriggers: { getFilterValue: trigger },
        extensions: BORDER_EXT,
        ...FLAT,
      }),
      new PathLayer({
        id: "coast-halo",
        data: MAIN.coastPaths,
        visible: !dataView,
        getPath: (d) => d.path,
        getColor: HALO,
        getWidth: 16,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "nation-backing",
        data: MAIN.nationParts,
        getPolygon: (d) => d.rings,
        getFillColor: WHITE,
        ...FLAT,
      }),
      // The seam aprons (see their construction above), clipped to the land so
      // they can't paint tan into the sea.
      new SolidPolygonLayer({
        id: "land-mask",
        data: MAIN.nationParts,
        operation: "mask",
        getPolygon: (d) => d.rings,
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "seam-aprons",
        data: MAIN.apronParts,
        getPolygon: (d) => d.rings,
        getFillColor: countyFill,
        updateTriggers: { getFillColor: [trigger, statKey, dataView] },
        extensions: BAND_EXT,
        maskId: "land-mask",
        maskByInstance: false,
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "counties",
        data: MAIN.countyParts,
        getPolygon: (d) => d.rings,
        getFillColor: countyFill,
        updateTriggers: { getFillColor: [trigger, statKey, dataView] },
        pickable: true,
        ...FLAT,
      }),
      // Atlas-style borders: along the inside of every state border and the
      // nation's edge runs a band of that state's own color, more saturated than
      // its fill. It is the counties over again in the deeper color, showing only
      // where the mask above lets them — so the band is the state's own ground by
      // construction and can't spill across a border however the line bends. The
      // bands go under the county hairlines and the white state border, which is
      // what keeps those lines reading over the top of them.
      new SolidPolygonLayer({
        id: "band",
        data: MAIN.countyParts,
        visible: !dataView,
        getPolygon: (d) => d.rings,
        getFillColor: bandOf,
        updateTriggers: { getFillColor: trigger },
        extensions: BAND_EXT,
        maskId: "band-mask",
        maskByInstance: false,
        ...FLAT,
      }),
      new PathLayer({
        id: "map-lines",
        data: MAIN.arcPaths,
        getPath: (d) => d.path,
        getColor: lineColor,
        getWidth: 1,
        widthUnits: "pixels",
        capRounded: true,
        updateTriggers: { getColor: [trigger, dataView] },
        ...FLAT,
      }),
      // Rivers, over the ground and under every edge of the water they run into.
      // Above the county fills and the border band, because a river is a fact
      // about the ground and breaking it wherever a state line happens to fall
      // would read as a rendering fault. Below the lakes and the coastline, so a
      // mouth that overshoots its estuary is covered by the edge it overshot
      // rather than striking out across open water. The coastline's blue, in a
      // weight that tapers with the tier, and gone in data view, where the ground
      // is read by color and a thread across it is only clutter.
      //
      // Two differences from the globe stack. The tiers are frozen at their home
      // view state rather than following the zoom, for the reason given where
      // RIVER_TIERS is defined. And the globe draws every lake in the world above
      // this line, where here the scenery lakes are drawn far below, back with the
      // rest of the world — so a river running into Lake Victoria is covered there
      // and not here. That costs a few pixels of overshoot on lakes outside North
      // America, and closing it would mean drawing the world's lakes twice.
      ...RIVER_TIERS.map(
        (t) =>
          new PathLayer({
            id: t.group,
            data: MAIN.worldRiverPaths[t.group],
            visible: !dataView,
            getPath: (d) => d.path,
            getColor: COAST,
            getWidth: t.width,
            widthUnits: "pixels",
            jointRounded: true,
            capRounded: true,
            ...FLAT,
          })
      ),
      // Lakes that sit inside unit polygons (not carved out of the land) are
      // drawn over the fills instead, in the same water blue — and their edge
      // matches the carved lakes' lakeshore treatment (the coast-line layer
      // below), so the two render paths are indistinguishable. In data view
      // the fill flips to page white: a carved lake shows the page through its
      // hole there, and an on-top lake has to read the same — its water
      // carries no data, so it blanks the stat color underneath.
      new SolidPolygonLayer({
        id: "lakes-over",
        data: MAIN.lakesOver,
        getPolygon: (d) => d.rings,
        getFillColor: dataView ? WHITE : LAKE,
        ...FLAT,
      }),
      new PathLayer({
        id: "lakes-over-edge",
        data: MAIN.lakeEdgesOver,
        getPath: (d) => d.path,
        getColor: COAST,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      // The map's outer edge: blue where the far side is water (ocean and
      // Great Lakes alike), dark where it's land beyond the map's units.
      new PathLayer({
        id: "coast-line",
        data: MAIN.shorePaths,
        getPath: (d) => d.path,
        getColor: COAST,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new PathLayer({
        id: "border-line",
        data: MAIN.borderPaths,
        getPath: (d) => d.path,
        getColor: LAND,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      // Data view symbols, on top of everything but the selection outline.
      new ScatterplotLayer({
        id: "data-circles",
        data: symbol?.mark === "circle" ? symbols : EMPTY,
        getPosition: (d) => [d.x, d.y],
        getRadius: (d) => d.hw,
        radiusUnits: "common",
        stroked: true,
        getFillColor: symbol?.fill ?? WHITE,
        getLineColor: symbol?.edge ?? WHITE,
        getLineWidth: 1,
        lineWidthUnits: "common",
        ...FLAT,
      }),
      new PolygonLayer({
        id: "data-squares",
        data: symbol?.mark === "square" ? symbols : EMPTY,
        getPolygon: (d) => {
          const h = d.hw;
          return [
            [d.x - h, d.y - h],
            [d.x + h, d.y - h],
            [d.x + h, d.y + h],
            [d.x - h, d.y + h],
          ];
        },
        stroked: true,
        getFillColor: symbol?.fill ?? WHITE,
        getLineColor: symbol?.edge ?? WHITE,
        getLineWidth: 1,
        lineWidthUnits: "common",
        ...FLAT,
      }),
      // The electoral-vote unit chart: every dot is one vote, so the stroke
      // thins to keep the tiny circles from reading as rings.
      new ScatterplotLayer({
        id: "data-dots",
        data: symbol?.mark === "dots" ? dotPositions(symbols) : EMPTY,
        getPosition: (d) => [d.x, d.y],
        getRadius: DOT_R,
        radiusUnits: "common",
        stroked: true,
        getFillColor: symbol?.fill ?? WHITE,
        getLineColor: symbol?.edge ?? WHITE,
        getLineWidth: 0.5,
        lineWidthUnits: "common",
        ...FLAT,
      }),
      // The selection edge is a dark line over a wider white casing. The casing
      // cuts a bright gap between the line and the border bands on either side,
      // which is what makes the selection pop instead of sinking into them.
      new PathLayer({
        id: "selected-casing",
        data: selEdge.main,
        visible: !!selected,
        getPath: (d) => d.path,
        getColor: WHITE,
        getWidth: 5.6,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new PathLayer({
        id: "selected-outline",
        data: selEdge.main,
        visible: !!selected,
        getPath: (d) => d.path,
        getColor: outline,
        getWidth: 2.6,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
    ];

    // ---- Alaska/Hawaii insets: a duplicate mini-map on the inset deck's own
    // canvas, above the map. A white backing hides whatever map lies under
    // the box; the content mirrors the atlas stack (fills — the faded foreign
    // neighbors included — lakes, seam aprons, band, hover, lines, coast,
    // selection; the state names ride the overlay SVG, like the globe's). The
    // V arrays hold only the open boxes' data, so a collapsed inset costs
    // nothing.
    const insetLayers = [
      // The insets need a mask of their own: deck fits a mask to its first
      // viewport, so the main deck's mask — refitted to wherever the map is
      // zoomed — would crop the boxes right out. Width is in common units
      // because the mask pass renders through a detached viewport where
      // "pixels" means texels, not screen; at this deck's zoom 0, one common
      // unit IS one CSS pixel, so the band width matches the main map's.
      new PathLayer({
        id: "inset-band-mask",
        data: V.bandMaskPaths,
        visible: !dataView,
        operation: "mask",
        getPath: (d) => d.path,
        getWidth: BAND_WIDTH,
        widthUnits: "common",
        jointRounded: true,
        capRounded: true,
        getFilterValue: bandFilter,
        filterRange: SHOWN,
        updateTriggers: { getFilterValue: trigger },
        extensions: BORDER_EXT,
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "inset-backing",
        data: V.backing,
        getPolygon: (d) => d.rings,
        getFillColor: WHITE,
        ...FLAT,
      }),
      // Carved lakes, as on the main map: drawn under the county fills and
      // showing through their holes (the Northwest Territories' corner of the
      // Alaska box holds a slice of Great Bear Lake). In data view the fill
      // drops out and the hole shows the backing's white, like the page white
      // on the globe.
      new SolidPolygonLayer({
        id: "inset-lakes-under",
        data: V.lakesUnder,
        visible: !dataView,
        getPolygon: (d) => d.rings,
        getFillColor: LAKE,
        ...FLAT,
      }),
      new PathLayer({
        id: "inset-lakes-under-edge",
        data: V.lakeEdgesUnder,
        visible: !dataView,
        getPath: (d) => d.path,
        getColor: LAKE,
        getWidth: 2,
        widthUnits: "common",
        ...FLAT,
      }),
      // The ocean halo, as on the main map. It rides above the white backing
      // (which plays the sea inside the box) and under the county fills (which
      // stand in for the nation shape and hide its landward half).
      new PathLayer({
        id: "inset-coast-halo",
        data: V.coastPaths,
        visible: !dataView,
        getPath: (d) => d.path,
        getColor: HALO,
        getWidth: 16,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      // The seam under-fill, as on the main map, so a cross-border merge can't
      // open a white crack along the Canada seam inside the box. The main map
      // clips its aprons to the land mask; at the boxes' fixed scale the
      // aprons' overshoot past the seam's sea ends is a fraction of a pixel,
      // so no mask is needed here.
      new SolidPolygonLayer({
        id: "inset-seam-aprons",
        data: V.apronParts,
        getPolygon: (d) => d.rings,
        getFillColor: countyFill,
        updateTriggers: { getFillColor: [trigger, statKey, dataView] },
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "inset-counties",
        data: V.countyParts,
        getPolygon: (d) => d.rings,
        getFillColor: countyFill,
        updateTriggers: { getFillColor: [trigger, statKey, dataView] },
        pickable: true,
        ...FLAT,
      }),
      new SolidPolygonLayer({
        id: "inset-band",
        data: V.countyParts,
        visible: !dataView,
        getPolygon: (d) => d.rings,
        getFillColor: bandOf,
        updateTriggers: { getFillColor: trigger },
        extensions: BAND_EXT,
        maskId: "inset-band-mask",
        maskByInstance: false,
        ...FLAT,
      }),
      insetHoverLayer(hoverInset),
      new PathLayer({
        id: "inset-map-lines",
        data: V.arcPaths,
        getPath: (d) => d.path,
        getColor: lineColor,
        getWidth: 0.5,
        widthUnits: "pixels",
        capRounded: true,
        updateTriggers: { getColor: [trigger, dataView] },
        ...FLAT,
      }),
      // On-top lakes, as on the main map: over the fills, page white in data
      // view. None land in the current boxes, but the stacks stay mirrored.
      new SolidPolygonLayer({
        id: "inset-lakes-over",
        data: V.lakesOver,
        getPolygon: (d) => d.rings,
        getFillColor: dataView ? WHITE : LAKE,
        ...FLAT,
      }),
      new PathLayer({
        id: "inset-lakes-over-edge",
        data: V.lakeEdgesOver,
        getPath: (d) => d.path,
        getColor: COAST,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new PathLayer({
        id: "inset-coast-line",
        data: V.shorePaths,
        getPath: (d) => d.path,
        getColor: COAST,
        getWidth: 1.1,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      // Data view symbols, the same three marks as the globe stack, mirrored
      // over insetSymbols so a state's graduated bubble/square/dots shows up
      // inside its box too, not just on the (often out-of-view) globe copy.
      new ScatterplotLayer({
        id: "inset-data-circles",
        data: symbol?.mark === "circle" ? insetSymbols : EMPTY,
        getPosition: (d) => [d.x, d.y],
        getRadius: (d) => d.hw,
        radiusUnits: "common",
        stroked: true,
        getFillColor: symbol?.fill ?? WHITE,
        getLineColor: symbol?.edge ?? WHITE,
        getLineWidth: 1,
        lineWidthUnits: "common",
        ...FLAT,
      }),
      new PolygonLayer({
        id: "inset-data-squares",
        data: symbol?.mark === "square" ? insetSymbols : EMPTY,
        getPolygon: (d) => {
          const h = d.hw;
          return [
            [d.x - h, d.y - h],
            [d.x + h, d.y - h],
            [d.x + h, d.y + h],
            [d.x - h, d.y + h],
          ];
        },
        stroked: true,
        getFillColor: symbol?.fill ?? WHITE,
        getLineColor: symbol?.edge ?? WHITE,
        getLineWidth: 1,
        lineWidthUnits: "common",
        ...FLAT,
      }),
      new ScatterplotLayer({
        id: "inset-data-dots",
        data: symbol?.mark === "dots" ? dotPositions(insetSymbols) : EMPTY,
        getPosition: (d) => [d.x, d.y],
        getRadius: DOT_R,
        radiusUnits: "common",
        stroked: true,
        getFillColor: symbol?.fill ?? WHITE,
        getLineColor: symbol?.edge ?? WHITE,
        getLineWidth: 0.5,
        lineWidthUnits: "common",
        ...FLAT,
      }),
      new PathLayer({
        id: "inset-selected-casing",
        data: selEdge.inset,
        visible: !!selected,
        getPath: (d) => d.path,
        getColor: WHITE,
        getWidth: 5.6,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
      new PathLayer({
        id: "inset-selected-outline",
        data: selEdge.inset,
        visible: !!selected,
        getPath: (d) => d.path,
        getColor: outline,
        getWidth: 2.6,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        ...FLAT,
      }),
    ];

    return { map: mapLayers, hover: hoverLayers, inset: insetLayers };
  };
}
