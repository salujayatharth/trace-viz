## 0.4.0

- **Live updates**: `atlas.update(table)` swaps the data under the view and keeps expansion, focus, hops, kills, trails and the camera; morphs what moved. The Atlas page has a *live* toggle (`l`) that drifts the seed data, and `?src=<json url>&poll=<ms>` to watch a real feed.
- **Consumer lag is a measure**: `lag` on `FlowMeasures` (messages; sums under aggregation) flows through `project()`, the Atlas model, unit edges and the inspector. A backed-up consume edge carries an amber-to-red bead trail; a topic's rail fill is the sum over its groups.
- **Walk the graph from the keyboard**: `atlas.walk('up'|'down'|'next'|'prev')`; `←` heaviest caller, `→` heaviest callee, `↑`/`↓` siblings in the band.
- **Depth profile** on collapsed tiles: a faint histogram of where the group's members sit along the request path.
- **`AtlasView`** React wrapper (`trace-viz/react`): table changes update in place.
- `collapseAll()` clears any trail.

## 0.3.1

- Release through npm trusted publishing (OIDC + provenance); no tokens.
- README: Atlas section, releasing notes.

## 0.3.0

- **Atlas**: a map-style navigator for estates of hundreds of services (`examples/atlas.html`, `src/atlas/`, `docs/ATLAS.md`). Semantic zoom over an ownership hierarchy, swimlane layout (x = call depth, y = ownership), aggregation that conserves traffic at every level, focus with partial expansion ("N more" tiles), Kafka topics as rails with lag fill, lenses, trails, blast radius, breadcrumbs, ⌘K go-to, minimap heat strip, URL-encoded views.
- `generateEstate()`: 600 services / 80 topics / 12 domains / 61 teams seed with heavy-tailed traffic, hubs, cycles, a sick and a burning service and backed-up topics.

## 0.2.1

- Error halo redesigned: bound to an error rate, the halo is now a red glow on an absolute scale (nothing under 0.4%, a rim at ~1%, a wide slow-breathing bloom past 6%) instead of a ring relative to the worst node. `NodeStyle.haloIntensity` exposes the 0..1 strength; `ERROR_FLOOR` / `ERROR_CEIL` are exported.
- Seed mesh now has a realistic error tail: one service having a bad day (2-5%) and one busy API on fire (12-30%), the same in both regions.

# Changelog

Published on npm as `trace-viz`.

## 0.2.0

The picture became a projection of the data rather than a property of it.

- Dimensional flow model: a table of flows with arbitrary dimensions, per-thing
  facts (instances, cpu, mem, engine), and `project(table, spec)` that chooses
  what a box is at runtime.
- Twelve visual channels in a registry, each bindable to any compatible field.
  Binding a dimension to an edge channel splits edges by it; a channel refuses a
  binding it cannot show.
- `share` as a derived measure and the default for `distance`, so coupled
  services sit together. `strength` dials it.
- Fail-closed as a first-party concept: rigid vs breakaway couplings and a
  failure front that travels backwards up the call graph.
- World mode: three planes, a component library of software silhouettes,
  instances as visible mass, gauges, an orbiting camera.
- Focus: expand one service into its APIs while the rest stays collapsed.
- Re-projection morphs; particle streams are carried across.
- A spec agent that composes views from a request and validates the result
  field by field, with a deterministic fallback.
- The studio: the spec as an editable sentence, an inspector, an interactive
  legend, one-click scenarios, a ⌘K palette, and a drawer with every knob.

## 0.1.0

Flat topology renderer: density is rps, speed is 1/latency, rings are errors,
retry and challenge traffic is dashed. Seed generator and the auth-challenge
scenario pair.
