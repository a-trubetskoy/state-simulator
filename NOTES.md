# Implementation Notes

Data provenance, geometry processing, rendering internals, and the reasoning behind the less obvious design decisions — written for maintainers and coding agents working on the codebase.
If you just want to run the app, see [README.md](README.md).

## App behavior

The map covers all of North America.
The US starts as the real 50 states (plus DC), county by county.
Canada is drawn at the same grain: its 293 census divisions are the county equivalents, each one paintable on its own, grouped into the province it belongs to.
Every Mexican state and Caribbean or Central American country is on the map as a single paintable unit.
All of them are drawn in a faint tan: on the map, but not in the union.
You can paint any county or division into a new state, load a preset like Deseret or New England, or paint a whole province into a state — at which point it counts toward that state's population, GDP, House seats, and electoral votes like anywhere else.
Clicking anything outside the union offers an "Add as US state" button in the state panel, which admits that whole province or country as a state of its own: it keeps its name and territory, takes a state color, and joins the rankings, the House apportionment, and the electoral college (its electoral votes count as won by neither side, since it cast no 2024 vote).
Rankings for population, land area, GDP, GDP per capita, household income, education, life expectancy, race/ethnicity shares, the 2024 presidential margin, and electoral votes update live — including for the leftover donor states.
Units outside the union stay out of every ranking while they stand there; once painted into a state, whatever they carry counts through that state.
Canadian divisions carry population, GDP, median household income, and education from real census figures; Mexican states and the Caribbean/Central American countries carry population, GDP, education, and income too, but the latter two are rough hand-compiled estimates rather than a matched survey (see the sourcing note in `scripts/na-unit-data.mjs`) — good enough to rank, not to cite.
None of them carry race/ethnicity, life expectancy, or 2024 vote counts: race and the vote have no equivalent published on the US definitions, and life expectancy simply has no non-US source in the pipeline yet.
A small elections panel replays the 2024 vote on your map: the House is reapportioned to 435 seats (Huntington–Hill), each state's electoral votes follow, and the president is tallied winner-take-all per state (DC keeps its 3 electoral votes; units still outside the union are excluded).
A toggle on the map switches between the atlas view (the usual colored states) and a data view that draws the selected stat itself: population and electoral votes as scaled circles, GDP as scaled squares, and the per-capita, income, education, race, and margin stats as state-level choropleths.

The projection is an orthographic globe centered on the continent, with the rest of the world's land drawn behind the map as scenery.
Zoom moves the picture rather than the sphere; a drag turns the sphere itself, so the map can face anywhere, and it re-projects to that facing.
The zoom's floor is "fit the sphere" rather than "fit the land", so the whole globe is reachable by zooming out; the home view starts framed on the lower 48.
The rest of North America is context to turn and zoom out into.
Alaska and Hawaii render in place on the globe, and are also duplicated into two inset boxes so they stay usable while the view is parked on the lower 48.
The insets are fixed to the UI, not to the map: they render on their own canvas with a fixed camera, pinned at constant pixel size just above the bottom-left buttons, so panning and zooming the map leaves them put.
The Alaska inset frames the state's main body rather than the entire Aleutian chain; the chain cuts off at the frame, the way printed atlases crop it.
The insets render the same picture the globe does: faded foreign neighbors (Yukon and British Columbia beside Alaska), coastlines with their halo, the border seam treatment, and fitted state name labels.
The insets are toggled by Alaska and Hawaii buttons next to Reset view, and both start open.
Painting in an inset paints the real unit — the two copies are the same county.

## Architecture

Vanilla JavaScript + [D3](https://d3js.org/), bundled with Vite. No framework.

- `src/main.js` — map rendering, county painting, stats, elections, and rankings
- `src/presets.js` — preset regions as county FIPS lists, with tract-carved partial counties where a region's border cuts through one
- `src/labels.js` — atlas-style state name labels (non-US units stay unlabeled)
- `src/split.js` — county carving: reconciling tract detail with the drawn map, dividing a county's row without moving any total, and re-owning borders as carves accumulate
- `scripts/build-data.mjs` — the data pipeline described below
- `scripts/build-tracts.mjs` — the per-county tract files behind carving (`npm run data:tracts`)
- `scripts/build-world.mjs` — the scenery land beyond the map's own units (`npm run data:world`)
- `scripts/build-geometry.mjs` — the shipped JSON compiled to unit-sphere triangles and line segments (`npm run data:geometry`), for the globe renderer described in `globe-rewrite-plan.txt`. Nothing loads it yet; the map still projects on the CPU.
- `scripts/geo-lib.mjs` — the caching downloader and simplification repairs both pipelines share
- `scripts/na-unit-data.mjs` — the static population/GDP table for non-US units, which doubles as the provincial control totals Canada's divisions are apportioned from
- `scripts/split-check.mjs` — browserless checks of the carve logic against the real data
- `scripts/globe-check.mjs` — browserless checks of the projection: that the atlas view is unchanged, that turning the globe keeps producing drawable geometry, and that the spin preview and the scenery land stay cheap and right way round

State borders are not stored anywhere: they are recomputed on every change as the topological boundary between units assigned to different states (`topojson.mesh` with a filter), which is what lets borders redraw instantly as you paint.
The atlas-style tinted band along every border is a single translucent near-black stroke on that mesh: compositing black at low opacity multiplies the fill underneath, so each side of a border reads as a band of its own state's color.
(An earlier version clipped a thick stroke to each state's shape, but fifty clip masks re-rasterizing per frame made zooming crawl.)
County lines are likewise one static mesh path instead of per-county strokes, which keeps the 3,400+ county and division fills cheap to repaint while zooming.
The US–Canada/Mexico seam joins the same segment list with its annotated (county, unit) pair standing in for the shared arc, so it filters with assignments like any other border.
Because a Canadian division's state is its province, the line between two divisions of the same province is not a state border at all: it draws as a plain county hairline, and the line between Ontario and Quebec draws as a border, all from the same test.

Four more things are the way they are for speed, all measured:

- The tooltip renders once per county and sits where it appeared, instead of following the cursor.
  Rewriting its HTML and reading its size back for the edge clamp forces a synchronous layout pass, so doing that on every mouse move taxed exactly the moments the pointer was busiest; now it happens only when the pointer enters a county or the model under it changes.
- The state name labels rebuild only when something they read changes, on version counters of their own.
  Territory changes rebuild the whole label pipeline; a rename or an admission refits only the text against cached geometry (the continent raster, its connected components and hulls, and each state's baseline profile); a selection or color change rebuilds nothing.
  Without the split, every click and every rename keystroke re-rasterized the continent — about 150 ms of main-thread work per event, which read as lag on exactly those two interactions.
- The county under the pointer is darkened by an overlay path that moves with the cursor, not by `filter: brightness()` on the county itself.
  A CSS filter makes the browser re-render the map through a filter pass on every mouse move, whether the pointer travels one county or the width of the country.
  Compositing 7% black over the fill is the same 0.93 multiply for a third of the cost.
- While a brush stroke is in progress the map's unchanging layers (coastline, county lines, lakes) are promoted to their own compositing layers.
  Rewriting the state borders each frame dirties the whole map, and without this those layers re-rasterize along with it for no reason.
  The promotion is scoped to the stroke because a promoted layer has to re-rasterize at every new scale, which would make zooming several times slower.

States are colored in the four-color-theorem spirit: a greedy graph coloring over the state adjacency graph keeps bordering states on different fills, and new custom states pick from the same base palette (falling back to stronger colors only when every base color clashes with a neighbor).
Units outside the union stay out of the palette: they all wear one faint tan until painted into a state (or admitted whole).
Foreign territory also wears none of the atlas border treatment: borders between two such units skip the band and the grey line, and the band skips foreign coastlines and the foreign side of the US seam too, so Canada and Mexico carry no dark rim of any kind.
The US side of the seam keeps the full treatment as the union's outer edge, and admitting or painting a unit into the union moves that edge — its coastline picks up the band the moment it joins.

## Data sources

| File | Contents | Source |
| --- | --- | --- |
| `na-counties-topo.json` | County boundaries (50 states + DC), Canada's census divisions, plus one unit per Mexican state and Caribbean / Central American country | Census cartographic boundary file, 2023 (5m); Statistics Canada census division cartographic boundary file, 2021; Natural Earth 10m admin-0 / admin-1 (lakes variants) |
| `na-map-overlays.json` | Classified map boundary (coast / lakeshore / land border), the US–Canada/Mexico border seam, notable lakes | Derived from the boundary files + Natural Earth 10m lakes; TIGER 2023 area hydrography for the water Natural Earth files as coastal |
| `tracts/<county>.json` | Census-tract boundaries and ACS shares, one file per US county, loaded lazily when a county is carved (built by `npm run data:tracts`) | Census cartographic boundary files cb_2023_*_tract_500k; ACS 2019–23 5-year (B01003, B19013, B15003, B03002) |
| `na-county-data.json` | Population | Census county population estimates, vintage 2025 |
| | GDP | BEA county GDP (CAGDP2), 2024, current dollars |
| | Median household income | Census SAIPE, 2023 |
| | Race/ethnicity counts | Census county characteristics estimates (ASRH), vintage 2025 |
| | Educational attainment (adults 25+) | USDA ERS county data (ACS 5-year counts) |
| | Life expectancy (US counties only) | County Health Rankings & Roadmaps analytic file, 2021–23 (NCHS mortality + Census population) |
| | 2024 presidential results | County-level returns ([tonmcg/US_County_Level_Election_Results](https://github.com/tonmcg/US_County_Level_Election_Results_08-24)) |
| | Canadian division population | StatCan population estimates by census division, 2021 boundaries (17-10-0152) |
| | Canadian division income, education, earnings | 2021 Census Profile, census divisions (98-401-X2021004) |
| | Canadian provincial income growth, 2020→2023 | StatCan T1 Family File, income of census families (11-10-0009) |
| | Non-US population & GDP | Hand-compiled table in `scripts/na-unit-data.mjs` (national statistics agencies / World Bank, 2023–24) |
| | Non-US education & income | Same table: Mexico from INEGI census 2020 & ENIGH 2024; other countries' education from national censuses/UNESCO/World Bank (years vary); other countries' income from World Bank GNI per capita × a flat household-pooling factor — rough estimates, see the sourcing note in the file |

## Geometry

- US counties and non-US units are built into one TopoJSON topology.
  Everything is simplified together (Visvalingam–Whyatt, about 1.6 km) before it is written, so shared arcs simplify once and neighbors keep identical borders.
- Canada's boundaries come from Statistics Canada in NAD83 / Statistics Canada Lambert (EPSG:3347), so the build reprojects all 17 million vertices to lon/lat before they join the map.
  It uses `proj4` rather than d3's conic conformal, because d3's is spherical: against the GRS80 ellipsoid the two disagree by kilometres at Canadian latitudes, which is the same order as the simplification tolerance the whole map is built to respect.
  The cartographic ("b") boundary file is the one to use, since it is clipped to the shoreline the way the Census county file is — the Great Lakes and Hudson Bay stay carved out of the land instead of being filled to the territorial limit.
- The two sides of the US land border come from different sources (Census vs Statistics Canada or Natural Earth) and share no arcs.
  Rather than conflating the geometries, the build ships the Census side of the border as "seam" segments annotated with the county and foreign unit that flank each one.
  The app appends those to its border-segment list, so the seam renders and filters exactly like an interior state border: paint Alberta into Montana's state and the line disappears.
  The annotated pairs double as the cross-border adjacency the shared-arc walk can't see, which keeps the coloring correct across the border.
  A ribbon of "apron" quads under the county fills, clipped to the land shape, hides the few-km disagreement between the two sources' border lines.
- Mexico and the countries get one unit each because that is all the use case needs: they join the union whole.
  Mexico's own county equivalents, the 2,469 municipios, would roughly double the map for a question ("what if Baja California were a state") that only ever moves whole units.
  Guantanamo Bay is folded back into Cuba; Guadeloupe, Martinique, and the Caribbean Netherlands are carved out of the France and Netherlands polygons by bounding box.
- Rings smaller than 0.5 km² — a speck about 700 m across, two pixels at maximum zoom — are dropped before any point thinning.
  Statistics Canada draws every lake islet and offshore rock, and thinning alone left hundreds of thousands of four-point rings, more points than the rest of the continent had between them, none of them wider than the 150 m grid the file is quantized onto.
  The filter spares any ring that shares an arc with a neighbour whatever its size, so a unit's mainland can never go: only free-standing specks do.
- Every unit is checked after simplification for drawable, non-zero-area geometry, and the small islands that survive the filter are held at four points so they cannot collapse.
- A spherical renderer reads a ring by its winding, so a ring wound backwards means everything-but-the-ring: one flipped islet fills the whole globe with its unit's colour.
  Thinning can flip a ring, because the few vertices that survive from a concave ring can wind the opposite way from the ring they came from, and quantization can do the same to a sliver.
  So after both steps every ring is rewound to the orientation its role demands — an exterior ring encloses less than a hemisphere, a hole more — by reversing the ring's walk over its arcs, which leaves shared arcs and the neighbours that use them untouched.
  The build fails if any unit still measures larger than a hemisphere.
- State land area for the "Land area" ranking is computed at load time from this same unit geometry — each unit's spherical polygon area (d3-geo's `geoArea`, at Earth's mean radius) summed by state — rather than pulled from a separately published table, so it can never drift from what the map draws.
  The Census and StatCan cartographic files it starts from already exclude the Great Lakes and other named water, matching the usual "land area" convention, but the same 1.6 km simplification and sub-0.5 km² island dropping that keep the map light also shave a bit off whichever state's coastline is most convoluted (Alaska, by far): the ranking reads a few percent low there against the published figure, while boxier interior states land almost exactly on it.

### Scenery land

The rest of the world is drawn behind the map, so the globe shows a world rather than one continent adrift on a blank sphere.
It is scenery and nothing more: no unit belongs to it, nothing hovers, nothing paints, and it enters no total.
`scripts/build-world.mjs` builds it from the Natural Earth 10m admin-0 and 10m lakes files the main pipeline already caches, through the same simplify/despeckle/rewind pipeline the map runs.
It adds the Census-only lakes described under Lakes below.
The land is thinned at 6 km rather than the map's 1.6 km, since it is only ever read at continental zoom.
That coarser tolerance is most of what keeps the file to 1.75 MB, against the 1.83 MB the map's own counties cost.
The lakes are the one exception and keep every point Natural Earth gave them, for the reason under Lakes below.

The countries the map draws itself are left out of the file rather than covered over by it.
The US and Canada come from the Census and StatCan cartographic files, whose coastlines disagree with Natural Earth's by a few km, so a Natural Earth copy underneath would show as a tan fringe outside the drawn shore wherever it ran wider.
Dropping USA, CAN, MEX and the Caribbean/Central America subregions — exactly the coverage the map's own units have — is exact instead: what is left abuts them along Natural Earth's own edge-matched borders, so there is nothing to fringe and nothing to hide.
It costs about 35 ms of the ~130 ms settle, and the spin preview carries a coarsened copy so the world does not blink out mid-drag.

The scenery wears what the map's own unpainted ground wears, rather than a style of its own: the same tan a non-union unit carries, a white hairline between neighbours, a blue shoreline with the same halo behind it, and water blue in the lakes.
What marks the map out is not a duller tan — it is that the map's ground takes state colours, hover, labels, names and paint, and none of that reaches here.
A tan of its own had the opposite effect of the one intended: the only place the two kinds of land touch is Colombia's border with Panama, and a deeper shade put a visible step across it.

Four objects come out of the file and they all share one set of arcs, so each line lands exactly on the edge of the shape it belongs to: `land`, `lakes`, `coast` (every edge where the scenery meets water) and `borders` (every edge where it meets another scenery country).
Splitting the two meshes needs to know what lies on the far side of an edge, so the map's own countries go into the topology alongside the rest and are dropped at the end, when the topology is rebuilt from what survives.
That is what lets the Panama seam fall out of both meshes: it is the one edge with the map on one side and the scenery on the other, and the map already draws it as its own dark border line.
Without that step it would read as a coastline and be drawn blue, a few km off the border the map draws.

Natural Earth has a seam of its own, where it cuts the two countries that straddle the antimeridian in half and closes each half along it — Russia through Chukotka, Fiji through its eastern islands.
That edge has to stay in the land, which needs closed rings, but it is not a shore, so the coastline is broken wherever it meets one: the real shore either side is untouched and the join between them goes undrawn.
Left in, it drew a straight blue line and its halo 700 km down the middle of the Chukotka Peninsula.

Lakes are drawn over the land rather than carved out of it, because Natural Earth carves only the largest ones — Baikal, Ladoga, Balkhash, Victoria, Tanganyika, Malawi, Albert and the Aral remnants — and leaves the rest sitting inside the countries they belong to.
Drawing them over covers both cases with one layer: over a hole it fills it, over a country it hides that much of it.
It also settles the halo, which follows every edge in the `coast` mesh including the shore of a carved lake: the halo goes under the land, the lake goes over it, so what would have ringed Baikal in sea blue is covered by Baikal.
There is no area floor: all 1,355 lakes in the file are drawn.
There used to be one, at 1,000 km².
It was picked to clear two bars — every lake the admin-0 file carves out of the land had to be covered, the smallest being the North Aral Sea at 3,400 km², and the rest had to reach about as far down the list as a reader expects on a world map.
Taking the file whole is simpler than defending a threshold, and it costs little: 163,000 points against 93,000.
Natural Earth 10m is also the finest tier they publish, so there is no deeper list this could have fallen back to.
One consequence is that the despeckle pass has to spare the lakes.
It drops rings under 10 km², and 52 lakes are smaller than that, so only the land faces that floor.
Nineteen lakes still come out with no area at all, because the file quantizes to a 400 m grid.
Every one of those is a Natural Earth speck under 0.01 km², which is about 70 m across and under a pixel at any zoom this layer is drawn at.
The lakes inside North America are kept rather than filtered out: the map draws its own territory over this layer, so its own Great Lakes cover them.

One lake is not Natural Earth's at all.
Natural Earth's lake layer carries inland water, and where it judges a body to be coastal instead, that body is in no lake file it publishes.
Lake Pontchartrain is the case that matters here: it is absent from `ne_10m_lakes` and from the North America supplement, and Natural Earth's own Louisiana polygon stops at its shore, treating it as a bay.
The Census disagrees, and the Census is what draws this map — its parishes run straight across the lake, so nothing carves it out of the land and no Natural Earth lake covered it back up.
The map drew 1,600 km² of solid parish where the water is.
Water in that position, covered by the map's own units and absent from Natural Earth, comes from the Census's own hydrography instead: `CENSUS_LAKES` in `scripts/geo-lib.mjs` names each such lake and the counties it spans, and both lake sets read it — `na-map-overlays.json`, where the map's own water lives, and this file, whose lake set is what the globe renderer actually draws over the county fills.

TIGER splits a water body at county lines, so the six parish pieces have to be put back together.
They overlap by a few metres rather than sharing arcs, and `topojson.merge` only dissolves an arc that two polygons share, so it leaves spurious rings behind: sliver polygons off the outline, and holes along each parish line and under the causeway's right-of-way.
The outline itself comes out right, so only outer rings above 1 km² are kept.
Rasterized against the source pieces at 160 m, that covers all but 0.1 km² of their 1,631 km², and adds back the 5.5 km² the artifacts would otherwise cut out of the middle of the lake.
TIGER also draws hydrography far finer than anything else on the map, so it is thinned to Natural Earth 10m's grain rather than kept whole: 500 m puts the median segment at 1.5 km, which is Natural Earth's own median, and takes Pontchartrain from 12,036 points to 121 while holding its area to within 0.5%.

## Data merge

- BEA reports some small independent cities combined with a neighboring county (mostly in Virginia).
  The script allocates those combined totals back to the member counties in proportion to population.
- Connecticut is mapped by its nine planning regions, which replaced counties as census areas in 2022.
- "Bachelor's degree or higher" is aggregated from ACS counts, so percentages for custom states are exact.
- Race/ethnicity counts (not-Hispanic white/Black/Native/Asian alone, plus Hispanic of any race) are additive, so custom-state shares are exact.
- Median household income for a state is the population-weighted mean of its county medians, since medians aren't additive.
  It tracks published state medians closely but not exactly.
- Life expectancy for a state is likewise the population-weighted mean of its county estimates, the same non-additive approximation as median household income.
  County Health Rankings & Roadmaps reports no value for a county with fewer than 5,000 population-years-at-risk in the window, and for Connecticut's nine planning regions specifically: NCHS hasn't recomputed life expectancy for that geography yet, so Connecticut carries none until it does.
  A carved county's pieces all inherit the parent county's value unchanged, since life expectancy has no census-tract-level source to split by.
- Alaska reports election results by state house district, not county.
  The script sums them to a statewide total and allocates it to county-equivalents by population, so Alaska's state-level margin is exact and only its county-level split is approximate.
- Kalawao County, HI (population under 100) reports its votes with Maui County, so it carries no vote data of its own.
- Non-US population and GDP are rounded static estimates, compiled by hand in `scripts/na-unit-data.mjs` with per-row sources.
  GDP is in thousands of current US dollars, matching the BEA county units, so foreign units sum and rank directly against US counties.
  Cuba's GDP is the official figure and is widely considered unreliable.
- Non-US education and income (bachelor's-or-higher share and household income, for Mexico and the Caribbean/Central American countries) are looser estimates than everything else in the pipeline, since almost none of these places publish a survey matched to what the US/Canada figures measure.
  Mexico's numbers come from a real INEGI census and household-income survey; every other country's education figure is whatever year and source was actually published (some decades old, a few outright estimated), and its income figure is World Bank GNI per capita scaled by a flat household-pooling factor rather than a measured household income.
  Puerto Rico and the US Virgin Islands use a directly known/estimated income figure instead of that formula, since the GNI-based estimate overshoots there.
  The full reasoning and per-region caveats live in the comment at the top of `scripts/na-unit-data.mjs`.
- Canadian population is published per census division, on the same 2021 boundaries as the geometry, and at the same vintage as the US county estimates it ranks against.
  A province is simply the sum of its divisions.
- Statistics Canada publishes no GDP below the province, so each province's published total is split across its divisions by their share of aggregate employment income (recipients × average earnings), the finest-grained measure of where a province's earnings actually are.
  A province therefore still totals exactly what it did when it was one unit — only the split inside it is an estimate.
  A division whose earnings are suppressed falls back to its population times the province's earnings per head, so the shares still sum to one.
- Canadian median household income starts as the 2021 census median total household income, which measures income received in 2020, and is carried forward to 2023 by the province's own change in median income over those three years, from the T1 Family File.
  Two things make that necessary rather than fussy.
  The census figure is three years older than the US SAIPE figures it ranks against, and 2020 was the CERB year, so Canadian household income peaked in exactly the year the census caught.
  Because the same series supplies both ends of the ratio, the CERB bulge sits in the denominator too and cancels.
  The T1 Family File is used rather than the survey-based income tables because it is administrative data in current dollars, so the ratio is nominal growth directly, with no separate inflation step; the survey tables are published in constant dollars, where the same ratio would be real growth.
  Tax records group people as census families and as persons not in a census family, neither of which is a household, so the two are blended by their counts into one household-shaped composite — and because this is a ratio and not a level, whatever that composite gets wrong about households divides out between the two years.
- Canadian money is converted at the market rate, not at purchasing power parity.
  The map's question is what a province would look like as a state, and joining the union would not change what anyone is paid; a Canadian province would simply be a cheap place to live inside the US, the way a poorer state is, until investment closed the gap over years.
  Purchasing power parity would answer a different question — how living standards compare between two countries — and would quietly hand every Canadian division a raise it hasn't had.
- Canadian education counts cover ages 25 to 64, the band the census publishes, against 25 and over for US counties.
  Excluding over-65s, who hold degrees at lower rates, tilts the Canadian share slightly high.
- Canadian divisions carry no race/ethnicity or vote counts: Canada measures visible-minority and Indigenous identity rather than the US race categories, so race/ethnicity stays null rather than being mapped across on a guess.

## Map overlays

- The map's outer boundary is split into ocean coastline (drawn blue, with a soft water halo), carved-lake shoreline (drawn blue, no halo), and land border with territory beyond the map's units — which is now just Panama–Colombia (drawn dark).
  Each boundary segment is classified by probing points offset to either side, at growing distances, against the map's own polygons plus Natural Earth: a probe in another map unit means a border seam, a probe in a carved-out lake means lakeshore, and a probe outside every land polygon means ocean.
  Natural Earth's own US polygon joins the land test so the hairline gap between the Census border and the Natural Earth border can't read as coast.
  A probe outside every land polygon that sits in a hole of the map's merged land is enclosed water and reads as lakeshore, not ocean.
  Short misclassified runs are absorbed by their neighbors, and on a closed ring (an island, a carved lake) the absorption wraps across the ring's start point — without that, a two-kilometre "coast" blip at a ring seam kept an ocean halo in the middle of Lake Huron's North Channel.
- Notable lakes come from Natural Earth 10m, now including the big Canadian lakes and the Nicaraguan pair.
  Lake Manitoba is deliberately left out: it isn't carved out of Manitoba's polygon, and drawn on top its narrow full-detail outline read as a stray squiggle of coastline next to the carved Lake Winnipeg.
  Whether a lake is carved out of the map's land (drawn under the fills) or sits inside unit polygons (drawn on top) is sampled rather than assumed, so it adapts to how each source drew its units; a lake carved on one side of the border but covered on the other (Lake of the Woods) draws on top, which reads correctly on both sides.

## Turning the globe

The projection used to be a literal buried in one expression, which quietly hardwired the whole app to North America.
It is a parameter now, so the same renderer, masks, labels, hover and carving work at any facing — which is what adding a region beyond North America later needs.
Nothing about that promise is speculative: `scripts/globe-check.mjs` projects the counties at several facings and checks that the geometry stays finite, stays inside the sphere's disc, and clips the far hemisphere away rather than folding it onto the near one.

Four decisions carry the design.

**The fit runs once; scale and translate are then frozen.**
`fitSize` is still what places the lower 48 in the 975x610 design box, exactly as before, but only at the home facing.
Its scale and translate are kept and reused for every other facing rather than recomputed, because re-fitting per rotation would re-frame whatever swung into view and the sphere would visibly breathe as it turned.
Translate is where the sub-viewer point lands on screen, so holding it fixed is precisely what pins the globe's center.
The check asserts that a bake at the home facing is bit-identical to the old expression — 398,406 coordinates, none differing — so the atlas view is provably untouched.

**The re-bake runs on the CPU, not through deck.gl's `GlobeView`.**
`GlobeView` is the obvious candidate and it is the wrong one here.
It is still experimental, it does not support `MaskExtension` (which the border band, the seam aprons and the inset clipping all use), and it documents no high-precision rendering above zoom 12 — while carving works at zoom 16.
It also only accepts lon/lat, so the plane coordinates that hover picking, the label raster, the carve fringe quads and the centroids all work in would have to be maintained as a second, separate projection that must agree with the GPU's to the pixel.
Re-baking keeps one projection and one source of truth, and every one of those consumers keeps working with no changes at all.

**A spin previews coarsely and settles precisely.**
A full re-bake is about 130 ms, which is fine once at the end of a drag and hopeless at 60 fps.
Thinning the full map does not rescue it: the cost is dominated by per-geometry stream overhead across ~3,400 counties and ~20,000 arcs, so even a heavily decimated full map sits around a 55 ms floor.
So a drag re-projects one merged, thinned outline per state instead — about 130 shapes and 12,500 points, roughly 4 ms a frame beside the sphere and the graticule — and the full stack comes back on release.
Merging per state rather than merging the continent whole is what lets the preview keep the map's own colors, which is the point: a turn that greys the map out reads as a glitch rather than as a preview.
The shapes come off the shared topology, so neighbors still tile exactly and the preview needs no white backing under them.
Merging costs ~50 ms, so it is cached until territory changes hands, and paid at startup rather than on the first frame of a drag.
Making the outlines cheap is mostly about dropping rings, not points: most of a merged outline's rings are already short (every lake islet and offshore rock), so a stride hits its don't-collapse floor on thousands of them and the point count barely moves.
Dropping rings under a quarter degree first, then thinning, takes the preview from 15 ms to about 4 ms a frame, and the check holds it there.
The one ring a state cannot afford to lose to that filter is its only one: DC is 0.15 degrees across, and dropping it would punch a hole in the land where it belongs, so the widest polygon of a state survives at any size.

**The labels sit out the drag.**
State names are placed by a raster built against the facing of the last bake, and they ride the SVG overlay rather than the canvas, so leaving them up strands them over the wrong ground while the globe turns underneath.
A class on the SVG hides them for the length of the gesture, and the settle rebuilds the labeler, so they come back in the same frame as the baked map.
The inset boxes keep theirs — the boxes do not turn.

A rotation rebuilds more than the geometry, because several things are derived from it and cached.
The label raster is sized from the land's projected bounds at construction, so the labeler is rebuilt rather than updated.
The zoom's lower bound is "fit the land", which a new facing changes.
Carves survive: the tract topology each cut was made from is kept on the split record, so a carved county is re-projected rather than lost, and the pieces, their allocated rows and their names all stand.

## Carving: design decisions

Three decisions carry the design, all explained at length in `src/split.js`:

- The county keeps its drawn shape.
  Tract outlines are far finer than the map's simplified county outline, so one piece — the backing, chosen as the most populous — renders as the parent's own polygon under the other pieces' tract unions, and neighboring fills clip the sub-pixel fringe where the two sources disagree: the same trick as the seam aprons, instead of a second two-sources-no-shared-arcs seam.
  The fringe strip between a piece's true union and the drawn county line wears a ribbon of quads in the owning piece's color (over the backing, under the unions), and boundary probes look past the fringe to the territory beyond it — without both, a region assembled from carved counties would show phantom borders and foreign-colored slivers tracing every county line inside it.
- A carve never moves a state or national total.
  Tract ACS values are a different vintage than the county row, so they serve only as shares to divide the county's published numbers; the piece rows sum back to the county row exactly, the way provincial GDP is already apportioned across Canada's divisions.
  Population, race/ethnicity, education, and income divide by their own tract counts.
  GDP and the 2024 vote have no tract-level source, divide by population share, and are flagged as estimated in the tooltip.
- Boundary ownership is derived, not stored.
  Which piece owns each stretch of a carved county's original border depends on every carve made since — the far side may itself get carved — so the as-loaded border records are re-owned from the current partitions on every world rebuild, by probing just inside the drawn line and asking which piece's fill is visible there.
  The divider lines between pieces come from the tract topology arc by arc, so state borders, the atlas band, selection outlines, and adjacency all work through the existing assignment tests.

`node scripts/split-check.mjs` verifies the carve logic against the real files without a browser, the adjacent-carve and re-carve cases included.
`node scripts/globe-check.mjs` does the same for the projection.
