# State Simulator

Flip US counties into fictional states — or paint Alberta, Baja California, and Cuba into the union — and see how everything would rank.

Ever wondered what Southern California would rank for GDP if it were its own state?
Or what happens to the House if Alberta joins?
The map covers all of North America.
The US starts as the real 50 states (plus DC), county by county.
Canada is drawn at the same grain: its 293 census divisions are the county equivalents, each one paintable on its own, grouped into the province it belongs to.
Every Mexican state and Caribbean or Central American country is on the map as a single paintable unit.
All of them are drawn in a faint tan: on the map, but not in the union.
You can paint any county or division into a new state, load a preset like Deseret or New England, or paint a whole province into a state — at which point it counts toward that state's population, GDP, House seats, and electoral votes like anywhere else.
Clicking anything outside the union offers an "Add as US state" button in the state panel, which admits that whole province or country as a state of its own: it keeps its name and territory, takes a state color, and joins the rankings, the House apportionment, and the electoral college (its electoral votes count as won by neither side, since it cast no 2024 vote).
Rankings for population, land area, GDP, GDP per capita, household income, education, race/ethnicity shares, the 2024 presidential margin, and electoral votes update live — including for the leftover donor states.
Units outside the union stay out of every ranking while they stand there; once painted into a state, whatever they carry counts through that state.
Canadian divisions carry population, GDP, median household income, and education; Mexican states and the countries carry population and GDP only.
None of them carry race/ethnicity or 2024 vote counts, because neither has an equivalent published on the US definitions.
A small elections panel replays the 2024 vote on your map: the House is reapportioned to 435 seats (Huntington–Hill), each state's electoral votes follow, and the president is tallied winner-take-all per state (DC keeps its 3 electoral votes; units still outside the union are excluded).
A toggle on the map switches between the atlas view (the usual colored states) and a data view that draws the selected stat itself: population and electoral votes as scaled circles, GDP as scaled squares, and the per-capita, income, education, race, and margin stats as state-level choropleths.

The projection is an orthographic globe centered on the continent, drawn once at load — pan and zoom move the picture, not the sphere.
The home view frames the lower 48; the rest of North America is context to pan and zoom out into.
Alaska and Hawaii render in place on the globe, and are also duplicated into two inset boxes so they stay usable while the view is parked on the lower 48.
The insets are fixed to the UI, not to the map: they render on their own canvas with a fixed camera, pinned at constant pixel size just above the bottom-left buttons, so panning and zooming the map leaves them put.
The Alaska inset frames the state's main body rather than the entire Aleutian chain; the chain cuts off at the frame, the way printed atlases crop it.
The insets render the same picture the globe does: faded foreign neighbors (Yukon and British Columbia beside Alaska), coastlines with their halo, the border seam treatment, and fitted state name labels.
The insets are toggled by Alaska and Hawaii buttons next to Reset view, and both start open.
Painting in an inset paints the real unit — the two copies are the same county.

## Run it

```
npm install
npm run dev
```

The prebuilt data files live in `public/data/`, so this is all you need.

## Refresh the data

```
npm run data
npm run data:tracts
```

The first downloads the sources, merges them by unit id, and rewrites `public/data/`.
The second builds the per-county census-tract files behind carving (51 state shapefiles, ~84,000 tracts, ~3,150 files) and needs the first to have run, since it covers exactly the counties the map draws.
Downloads are cached in `.cache/`.

| File | Contents | Source |
| --- | --- | --- |
| `na-counties-topo.json` | County boundaries (50 states + DC), Canada's census divisions, plus one unit per Mexican state and Caribbean / Central American country | Census cartographic boundary file, 2023 (5m); Statistics Canada census division cartographic boundary file, 2021; Natural Earth 10m admin-0 / admin-1 (lakes variants) |
| `na-map-overlays.json` | Classified map boundary (coast / lakeshore / land border), the US–Canada/Mexico border seam, notable lakes | Derived from the boundary files + Natural Earth |
| `tracts/<county>.json` | Census-tract boundaries and ACS shares, one file per US county, loaded lazily when a county is carved (built by `npm run data:tracts`) | Census cartographic boundary files cb_2023_*_tract_500k; ACS 2019–23 5-year (B01003, B19013, B15003, B03002) |
| `na-county-data.json` | Population | Census county population estimates, vintage 2025 |
| | GDP | BEA county GDP (CAGDP2), 2024, current dollars |
| | Median household income | Census SAIPE, 2023 |
| | Race/ethnicity counts | Census county characteristics estimates (ASRH), vintage 2025 |
| | Educational attainment (adults 25+) | USDA ERS county data (ACS 5-year counts) |
| | 2024 presidential results | County-level returns ([tonmcg/US_County_Level_Election_Results](https://github.com/tonmcg/US_County_Level_Election_Results_08-24)) |
| | Canadian division population | StatCan population estimates by census division, 2021 boundaries (17-10-0152) |
| | Canadian division income, education, earnings | 2021 Census Profile, census divisions (98-401-X2021004) |
| | Canadian provincial income growth, 2020→2023 | StatCan T1 Family File, income of census families (11-10-0009) |
| | Non-US population & GDP | Hand-compiled table in `scripts/na-unit-data.mjs` (national statistics agencies / World Bank, 2023–24) |

Notes on the geometry:

- US counties and non-US units are built into one TopoJSON topology.
  Everything is simplified together (Visvalingam–Whyatt, about 1.6 km) before it is written, for the same reasons as ever: the map can't draw finer detail than that, and shared arcs simplify once so neighbors keep identical borders.
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

Notes on the merge:

- BEA reports some small independent cities combined with a neighboring county (mostly in Virginia).
  The script allocates those combined totals back to the member counties in proportion to population.
- Connecticut is mapped by its nine planning regions, which replaced counties as census areas in 2022.
- "Bachelor's degree or higher" is aggregated from ACS counts, so percentages for custom states are exact.
- Race/ethnicity counts (not-Hispanic white/Black/Native/Asian alone, plus Hispanic of any race) are additive, so custom-state shares are exact.
- Median household income for a state is the population-weighted mean of its county medians, since medians aren't additive.
  It tracks published state medians closely but not exactly.
- Alaska reports election results by state house district, not county.
  The script sums them to a statewide total and allocates it to county-equivalents by population, so Alaska's state-level margin is exact and only its county-level split is approximate.
- Kalawao County, HI (population under 100) reports its votes with Maui County, so it carries no vote data of its own.
- Non-US population and GDP are rounded static estimates, compiled by hand in `scripts/na-unit-data.mjs` with per-row sources.
  GDP is in thousands of current US dollars, matching the BEA county units, so foreign units sum and rank directly against US counties.
  Cuba's GDP is the official figure and is widely considered unreliable.
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
- Canadian divisions carry no race/ethnicity or vote counts.
  Canada measures visible-minority and Indigenous identity rather than the US race categories, and it holds no US presidential election, so both stay null rather than being mapped across on a guess.

Notes on the map overlays:

- The map's outer boundary is split into ocean coastline (drawn blue, with a soft water halo), carved-lake shoreline (drawn blue, no halo), and land border with territory beyond the map's units — which is now just Panama–Colombia (drawn dark).
  Each boundary segment is classified by probing points offset to either side, at growing distances, against the map's own polygons plus Natural Earth: a probe in another map unit means a border seam, a probe in a carved-out lake means lakeshore, and a probe outside every land polygon means ocean.
  Natural Earth's own US polygon joins the land test so the hairline gap between the Census border and the Natural Earth border can't read as coast.
  A probe outside every land polygon that sits in a hole of the map's merged land is enclosed water and reads as lakeshore, not ocean.
  Short misclassified runs are absorbed by their neighbors, and on a closed ring (an island, a carved lake) the absorption wraps across the ring's start point — without that, a two-kilometre "coast" blip at a ring seam kept an ocean halo in the middle of Lake Huron's North Channel.
- Notable lakes come from Natural Earth 10m, now including the big Canadian lakes and the Nicaraguan pair.
  Lake Manitoba is deliberately left out: it isn't carved out of Manitoba's polygon, and drawn on top its narrow full-detail outline read as a stray squiggle of coastline next to the carved Lake Winnipeg.
  Whether a lake is carved out of the map's land (drawn under the fills) or sits inside unit polygons (drawn on top) is sampled rather than assumed, so it adapts to how each source drew its units; a lake carved on one side of the border but covered on the other (Lake of the Woods) draws on top, which reads correctly on both sides.

## Carving counties

The Carve button arms a knife that works directly on the map — no separate view or drill-in.
Drag a freehand line, or click it corner by corner and finish with a double-click or Enter, and the stroke applies to every county it fully slices: each one is cut along its census tracts into pieces that paint, border, and rank exactly like counties.
"Fully slices" means the stroke passes through the county and both starts and ends outside it; a county the line merely grazes, or terminates inside, stays whole.
For each sliced county the line is closed far outside it and each tract joins the side its centroid falls on; every piece keeps the state of whatever it was cut from, so carving just creates seams to paint across (and a stroke drawn as a loop cuts out an enclave).
A cut through an already-carved county refines its partition, so pieces can be carved again, one stroke can slice several counties — adjacent ones included — and each county's tract file (about 17 KB on average) loads lazily, only when a cut first touches it.
Double-clicking a piece — with the knife put away — rejoins its whole county into that piece's state, and Reset rejoins everything.
`node scripts/split-check.mjs` verifies the carve logic against the real files without a browser, the adjacent-carve and re-carve cases included.

A state can also be painted from a boundary instead of by hand: while painting, a quiet **From GeoJSON…** button in the state panel takes a GeoJSON file (Feature, FeatureCollection, or bare Polygon/MultiPolygon), claims every county wholly inside it, and carves the counties it crosses — each tract joins by its centroid, exactly like a knife cut — painting the inside pieces into the state.
This is for the regions that don't follow county lines: the Mississippi Delta, a metro area, a watershed.
**Copy JSON** round-trips the geography in spirit: a whole county exports as its FIPS code, while a carved piece exports its parent's FIPS plus the tract GEOIDs that define it — stable Census identifiers that reconstruct the exact shape anywhere (the piece's session-local id would not).

Three decisions carry the design, all explained at length in `src/split.js`:

- The county keeps its drawn shape.
  Tract outlines are far finer than the map's simplified county outline, so one piece — the backing, chosen as the most populous — renders as the parent's own polygon under the other pieces' tract unions, and neighboring fills clip the sub-pixel fringe where the two sources disagree: the same trick as the seam aprons, instead of a second two-sources-no-shared-arcs seam.
- A carve never moves a state or national total.
  Tract ACS values are a different vintage than the county row, so they serve only as shares to divide the county's published numbers; the piece rows sum back to the county row exactly, the way provincial GDP is already apportioned across Canada's divisions.
  Population, race/ethnicity, education, and income divide by their own tract counts.
  GDP and the 2024 vote have no tract-level source, divide by population share, and are flagged as estimated in the tooltip.
- Boundary ownership is derived, not stored.
  Which piece owns each stretch of a carved county's original border depends on every carve made since — the far side may itself get carved — so the as-loaded border records are re-owned from the current partitions on every world rebuild, by probing just inside the drawn line and asking which piece's fill is visible there.
  The divider lines between pieces come from the tract topology arc by arc, so state borders, the atlas band, selection outlines, and adjacency all work through the existing assignment tests.

One knife limit remains: it draws on the globe, so an Alaska or Hawaii county carves on its globe copy but not inside its inset box.

## How it works

Vanilla JavaScript + [D3](https://d3js.org/), bundled with Vite. No framework.

- `src/main.js` — map rendering, county painting, stats, elections, and rankings
- `src/presets.js` — preset regions as county FIPS lists
- `src/labels.js` — atlas-style state name labels (non-US units stay unlabeled)
- `src/split.js` — county carving: reconciling tract detail with the drawn map, dividing a county's row without moving any total, and re-owning borders as carves accumulate
- `scripts/build-data.mjs` — the data pipeline described above
- `scripts/build-tracts.mjs` — the per-county tract files behind carving (`npm run data:tracts`)
- `scripts/geo-lib.mjs` — the caching downloader and simplification repairs both pipelines share
- `scripts/na-unit-data.mjs` — the static population/GDP table for non-US units, which doubles as the provincial control totals Canada's divisions are apportioned from
- `scripts/split-check.mjs` — browserless checks of the carve logic against the real data

State borders are not stored anywhere: they are recomputed on every change as the
topological boundary between units assigned to different states
(`topojson.mesh` with a filter), which is what lets borders redraw instantly as you paint.
The atlas-style tinted band along every border is a single translucent near-black stroke on that mesh:
compositing black at low opacity multiplies the fill underneath, so each side of a border reads as a band of its own state's color.
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
