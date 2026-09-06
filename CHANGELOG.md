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
