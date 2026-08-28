# State Simulator

Flip US counties into fictional states — or paint Alberta, Baja California, and Cuba into the union — and see how everything would rank.

Ever wondered what Southern California would rank for GDP if it were its own state?
Or what happens to the House if Alberta joins?

Paint any US county or Canadian census division into a new state, admit a whole Mexican state, Canadian province, or Caribbean/Central American country as a state of its own, or load a preset like Deseret or New England.
Population, GDP, House seats, electoral votes, and a replay of the 2024 election all update live as you go.

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
The second builds the per-county census-tract files behind carving (51 state shapefiles, ~84,000 tracts, ~3,150 files) and needs the first to have run.
Downloads are cached in `.cache/`.

## Turning the globe

The map is drawn on an actual globe, and the **Globe** button lets you turn it.
It pulls the view back to show the whole sphere; drag to spin it, and the map redraws facing wherever you stopped.
While you drag you see a simplified outline, and the full map — fills, borders, labels and all — comes back the moment you let go.
Turning the button off drops you back into the normal atlas view, framed on whatever you turned to rather than on the lower 48.
Reset view faces the globe home again along with undoing the pan and zoom.

Today everything on the globe is North America, so turning it mostly shows you ocean.
The point is that the map no longer assumes the continent it happens to hold: adding another part of the world is now a question of data, not of rebuilding the renderer.

## Carving counties

The Carve button arms a knife that works directly on the map.
Drag a freehand line, or click it corner by corner and finish with a double-click or Enter; the stroke slices every county it fully crosses — entering and exiting outside the county — into pieces that paint, border, and rank on their own.
Double-click a piece (with the knife put away) to rejoin its whole county, or use Reset to rejoin everything.
A state can also be painted from a boundary instead of by hand: the **From GeoJSON…** button in the state panel takes a GeoJSON file, claims every county wholly inside it, and carves the ones it crosses — useful for regions that don't follow county lines, like the Mississippi Delta.
**Copy JSON** exports the current geography as FIPS codes and Census tract GEOIDs, so it can be reconstructed exactly anywhere.
One limit: carving only works on the main globe, so an Alaska or Hawaii county can't be carved from inside its inset box.

---

See [NOTES.md](NOTES.md) for data sources, geometry processing, and other implementation details.
