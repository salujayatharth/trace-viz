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
