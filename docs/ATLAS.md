# Atlas: a map, not a graph

Design notes for visualising estates of hundreds of services, topics and
consumer groups. This is the reasoning behind `src/atlas/` and
`examples/atlas.html`.

## The problem with everything that exists

Every service map on the market (Kiali, Jaeger's dependency DAG, Datadog and
New Relic service maps, Netflix Vizceral, Grafana node graphs, Backstage
dependency plugins) is the same object: a node-link diagram of the whole
graph, laid out by a force or a layered algorithm, with zoom that scales
pixels. At 30 services it is a picture. At 600 services with 3,000 edges it is
a hairball, and the tooling responds by adding filters: "show only namespace
X", "hide edges under 1 rps". Filtering throws away the context you need to
understand what you are looking at. The navigation model is "search, then
squint".

Humans already navigate one graph with hundreds of thousands of nodes every
day without squinting: a road map. Nobody looks at every street in a country.
The map shows countries, then regions, then cities, then streets, and the
thing that changes as you zoom is not pixel size but **what a thing is drawn
as**. You always know where you are (the place name), and you always know how
to go up (zoom out) or sideways (pan).

Atlas takes that model seriously. Three commitments follow from it.

## 1. Semantic zoom over a stable hierarchy

Every leaf (a service, a topic) sits in an ownership tree:
`domain › team › leaf`. The tree is data, read from node facts, so any
hierarchy works (org › system › component, region › cluster › service).

A view is a set of **expanded** groups. A collapsed group is drawn as one
tile; an expanded group is drawn as its children. Zooming in over a tile
expands it; zooming out past the point where the map fits collapses the group
under the cursor. Double-click, Enter, breadcrumbs and `↑` do the same with
no mouse precision required. Nothing is ever filtered away: what is not
expanded is still on the map, as a tile, with all of its traffic aggregated
onto it.

Edges aggregate to whatever is visible. A single ribbon between two domain
tiles carries the sum of every call between them, and the tooltip says "212
flows between 41 and 37 services". Expand one side and the ribbon fans out
into its real endpoints. The picture at every level is truthful and complete;
it just has a different resolution.

## 2. Flow direction is sacred; ownership is the other axis

Force layouts destroy the one thing a call graph has going for it: direction.
Atlas is a **swimlane layout**. The x axis is depth in the call chain
(longest path from ingress, cycles broken by traffic weight), so clients are
on the left and stores are on the right at every level. The y axis is
ownership: one horizontal band per domain, sub-bands per team, in a fixed
order derived from mean depth so edge domains sit at the top and platform and
data at the bottom.

Collapsing a team turns its band into one row; its tile stretches from the
team's shallowest service to its deepest, so a wide tile literally means "this
team spans the whole request path" and a narrow one means "a leaf". Positions
are stable under expansion: things grow in place, they do not reshuffle.

Depth also fixes the biggest readability problem of aggregated maps -
back-edges. Calls that go against depth (cycles, callbacks) route as arcs over
the top, so the eye reads left-to-right as "downstream" without thinking.

## 3. You are always somewhere

Atlas has a **place**: the expanded path plus an optional focus. It is written
to the URL hash, so back and forward work, every view is a link, and a
screenshot can be reproduced. The breadcrumb bar is the place made visible;
clicking a crumb collapses to it.

**Focus** is the second navigational primitive. Click a service and it becomes
the centre of an ego network: every neighbour within *k* hops is forced to
leaf level (their teams expand for you), everything else dims but stays on the
map as context. The inspector lists callers and callees sorted by traffic;
each is a link, so walking the graph is a sequence of clicks in a list, which
is faster and more precise than hunting in a picture. `⌘K` search reaches any
service, topic, team or domain by name and does the expansion for you.

The **minimap** is not a tiny copy of the graph. It is a heat strip of the
lanes: each band coloured by its worst error rate or its traffic, with the
viewport drawn over it. It answers "where is the fire?" from anywhere, and a
click takes you there.

## Kafka is not an edge

A topic is a place where traffic changes hands, so it is drawn as one:
a **rail** - a horizontal pipe with partition ticks. Producers land on its
left, consumer groups leave from its right, each consume edge labelled with
its group. Consumer lag fills the pipe from the left on a log scale, amber
turning to red, so a backed-up topic is a bar filling up, visible at a glance
across a whole domain. Async flows are drawn as packet-dashed ribbons, sync
calls as solid ones, and the *Kafka* lens hides sync traffic entirely.

## Lenses instead of forty knobs

Every visual is still a bindable channel underneath, but the way in is a
handful of **lenses**, each a named preset that changes what the picture
means: *Traffic* (width and particles by rps), *Reliability* (error glow, lag
fill, dead fraction), *Latency* (ribbon heat), *Ownership* (colour by domain),
*Kafka* (only async), *Blast radius* (rigid vs breakaway, kill to propagate).
One click, one meaning. The knobs are still there for people who want them.

## Level of detail is a budget, not a setting

600 services expanded at once is never drawn: expanding a domain expands it
to its teams, not to its leaves. Particles are spent only on edges touching
the focus or an expanded team, under a global cap; every other ribbon moves
with a cheap dash animation. Labels below 9 screen pixels are skipped. Edges
below a share of the visible maximum are drawn as hairlines unless they touch
the focus. The result stays at 60 fps with a few hundred visible units on a
2D canvas; no WebGL is required at this size.

## What this is not

Not a trace viewer: a single request's path is a trail (a highlighted path
through the map), not a separate timeline. Not a dashboard: no numbers unless
you ask (hover, inspector). Not a topology editor. It is a place to stand and
look at a very large system without being lied to by a filter.
