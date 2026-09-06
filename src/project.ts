import {
  endpointDims,
  type DimValues,
  type FlowRecord,
  type FlowTable,
  type NodeFact,
} from './model.js';
import type { Scene, SceneEdge, SceneNode } from './scene.js';
import type { EdgeKind, NodeKind } from './types.js';

/** How a dimension or measure is bound to one visual channel. */
export interface ChannelBinding {
  /** Dimension or measure name. */
  field: string;
  /** Override the automatic choice of scale for measures. */
  scale?: 'log' | 'linear' | 'sqrt';
  /** Explicit value-to-visual mapping for dimensions, e.g. { 'fail-closed': 'rigid' }. */
  map?: Record<string, string>;
  /** Palette override for categorical channels. */
  palette?: string[];
  /** Reverse the direction of a measure channel. */
  invert?: boolean;
  /**
   * How hard this channel pulls, for `distance`: 0 switches it off, 1 is the
   * default, 2 doubles it. Lets you dial coupling up until the clusters are
   * unmistakable, or down until the layout is calm.
   */
  strength?: number;
  /**
   * Explicit ordering of a dimension's values, for channels where order is
   * visible: `column` (left to right) and `lane` (top to bottom). Values not
   * listed follow, sorted.
   */
  order?: string[];
}

/**
 * The knobs. Everything about what the picture *is* lives here, and all of it
 * can change between frames.
 */
export interface ViewSpec {
  /**
   * Which dimensions define a node. `['service']` gives you one box per
   * service; `['service','api']` explodes it; `['region','service']` gives you
   * the same service twice, once per region.
   */
  nodeKey: string[];
  /** Keep only records whose dimension values are in these sets. */
  where?: Record<string, string[]>;
  /** dimension or measure -> visual channel. */
  channels?: Record<string, ChannelBinding>;
  /** Node ids to kill, for the blast-radius view. */
  killed?: string[];
  /** Drop edges that collapse onto a single node (intra-group calls). */
  dropSelfEdges?: boolean;
  /**
   * Expand one part of the graph without expanding all of it.
   *
   * `{ match: { service: 'orders' }, expandBy: ['api'] }` keeps every other
   * service as a single box and explodes just this one into its APIs. This is
   * how you look at the APIs of one service without turning the whole picture
   * into forty nodes.
   */
  focus?: { match: DimValues; expandBy: string[] };
  /** Render as a flat topology or as a tiered 3D world. */
  mode?: 'flat' | 'world';
  /** Knobs on the flat layout. */
  layout?: {
    /** How rows inside a column are ordered: fewest crossings, by name, or by traffic. */
    rowSort?: 'auto' | 'name' | 'traffic';
  };
  world?: WorldSpec;
  /** Human note shown with the view. */
  title?: string;
}

/** How the miniature world is composed - all of it selected from registered components. */
export interface WorldSpec {
  /** Dimension deciding which plane a node sits on; omitted means infer from node kind. */
  tierBy?: string;
  /** Ordered tier values, top to bottom. */
  tiers?: string[];
  /** Dimension deciding the component silhouette. */
  componentBy?: string;
  /** value -> registered component name. */
  componentMap?: Record<string, string>;
  /** Node attribute driving visible mass, default "instances". */
  instances?: string;
  /** Node attributes drawn as gauges on the body, default ["cpu","mem"]. */
  gauges?: string[];
  /** Camera yaw in radians. The renderer also lets you drag it. */
  yaw?: number;
}

export interface ProjectionResult {
  scene: Scene;
  /** Dimensions that split edges into separate lanes, because a channel is bound to them. */
  splitBy: string[];
  /** Records that survived the filter. */
  matched: number;
  /** Records rejected by the filter. */
  filtered: number;
}

/** Channels that describe one edge, so binding a dimension to one must split edges by it. */
const EDGE_CHANNELS = new Set(['hue', 'glyph', 'dash', 'lane', 'coupling', 'density', 'speed', 'radius']);

export function nodeIdFor(dims: DimValues, nodeKey: string[]): string {
  return nodeKey.map((k) => dims[k] ?? '∅').join(' / ');
}

/** Does this endpoint fall inside the focus? */
function inFocus(dims: DimValues, focus: ViewSpec['focus']): boolean {
  if (!focus) return false;
  return Object.entries(focus.match).every(([k, v]) => dims[k] === v);
}

/**
 * Roll a flow table up into a drawable scene.
 *
 * Two things happen that are easy to miss and matter a lot:
 *
 * 1. Binding a *dimension* to any per-edge channel adds it to `splitBy`, so the
 *    edges are grouped by it rather than averaged over it. Colouring by region
 *    therefore turns one edge into two lanes, one per region - which is the
 *    honest picture. Averaging a dimension you are also encoding would draw a
 *    colour that describes nothing.
 * 2. Measures aggregate differently by kind: throughput sums, everything else
 *    is a throughput-weighted mean. A 10k rps hop at 2ms and a 1 rps hop at 900ms
 *    do not average to 451ms.
 */
export function project(table: FlowTable, spec: ViewSpec): ProjectionResult {
  const nodeKey = spec.nodeKey.length ? spec.nodeKey : ['service'];
  const splitBy = new Set<string>();
  for (const [channel, binding] of Object.entries(spec.channels ?? {})) {
    if (!EDGE_CHANNELS.has(channel)) continue;
    // Only dimensions split; measures are aggregated numbers.
    if (!isMeasure(binding.field)) splitBy.add(binding.field);
  }
  for (const k of nodeKey) splitBy.delete(k);
  const split = [...splitBy];

  let matched = 0;
  let filtered = 0;

  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, MutableEdge>();

  for (const record of table.records) {
    if (!passes(record, spec.where)) {
      filtered++;
      continue;
    }
    matched++;

    const fromDims = endpointDims(record, 'from');
    const toDims = endpointDims(record, 'to');
    // Focus expands the key locally, so one service can show its APIs while
    // every other service stays a single box.
    const fromKey = inFocus(fromDims, spec.focus) ? [...nodeKey, ...spec.focus!.expandBy] : nodeKey;
    const toKey = inFocus(toDims, spec.focus) ? [...nodeKey, ...spec.focus!.expandBy] : nodeKey;
    const fromId = nodeIdFor(fromDims, fromKey);
    const toId = nodeIdFor(toDims, toKey);

    const rps = Math.max(record.metrics.rps, 0);
    touchNode(nodes, fromId, fromDims, fromKey, record, { outbound: rps });
    touchNode(nodes, toId, toDims, toKey, record, { inbound: rps });

    if (spec.dropSelfEdges && fromId === toId) continue;

    const laneDims: DimValues = {};
    for (const d of split) {
      const v = record.dims?.[d] ?? record.from[d] ?? record.to[d];
      if (v !== undefined) laneDims[d] = v;
    }
    const edgeId = [fromId, '→', toId, ...split.map((d) => laneDims[d] ?? '∅')].join('|');

    let edge = edges.get(edgeId);
    if (!edge) {
      edges.set(
        edgeId,
        (edge = {
          id: edgeId,
          from: fromId,
          to: toId,
          dims: laneDims,
          spans: {},
          rps: 0,
          latencyWeighted: 0,
          errorWeighted: 0,
          bytesWeighted: 0,
          lag: 0,
          records: 0,
        }),
      );
    }
    edge.rps += rps;
    edge.latencyWeighted += (record.metrics.latencyMs ?? 25) * rps;
    edge.errorWeighted += (record.metrics.errorRate ?? 0) * rps;
    edge.bytesWeighted += (record.metrics.bytes ?? 1024) * rps;
    edge.lag += record.metrics.lag ?? 0;
    edge.records++;
    collectSpans(edge.spans, { ...record.dims, ...record.from }, split, nodeKey);
    collectSpans(edge.spans, { ...record.dims, ...record.to }, split, nodeKey);
  }

  const sceneNodes: SceneNode[] = [...nodes.values()].map((n) => ({
    id: n.id,
    label: n.label,
    ...(n.sublabel ? { sublabel: n.sublabel } : {}),
    kind: n.kind,
    key: n.key,
    spans: sortSpans(n.spans),
    inboundRps: n.inbound,
    outboundRps: n.outbound,
    attrs: {},
    records: n.records,
  }));

  attachFacts(sceneNodes, table.nodes ?? []);

  // Error rate is measured on flows, but "how badly is this thing failing" is
  // a question about a node: the rps-weighted error rate of what it serves.
  // Exposed as a node attribute so halo (or anything else) can bind to it.
  const errWeighted = new Map<string, { err: number; rps: number }>();
  for (const e of edges.values()) {
    const acc = errWeighted.get(e.to) ?? { err: 0, rps: 0 };
    acc.err += e.errorWeighted;
    acc.rps += e.rps;
    errWeighted.set(e.to, acc);
  }
  for (const n of sceneNodes) {
    const acc = errWeighted.get(n.id);
    n.attrs.errorRate = acc && acc.rps > 0 ? round(acc.err / acc.rps, 5) : 0;
  }

  // Infer a role for anything the data did not label, so the palette still
  // distinguishes a client from a datastore after an arbitrary projection.
  for (const n of sceneNodes) {
    if (n.kind !== 'service') continue;
    if (n.inboundRps === 0 && n.outboundRps > 0) n.kind = 'client';
    else if (n.outboundRps === 0 && n.inboundRps > 0) n.kind = 'datastore';
  }

  const outboundOf = new Map<string, number>();
  for (const e of edges.values()) outboundOf.set(e.from, (outboundOf.get(e.from) ?? 0) + e.rps);

  const sceneEdges: SceneEdge[] = [...edges.values()].map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kind: edgeKindOf(e.dims),
    dims: e.dims,
    spans: sortSpans(e.spans),
    metrics: {
      rps: round(e.rps, 2),
      latencyMs: e.rps > 0 ? round(e.latencyWeighted / e.rps, 2) : 0,
      errorRate: e.rps > 0 ? round(e.errorWeighted / e.rps, 5) : 0,
      bytes: e.rps > 0 ? Math.round(e.bytesWeighted / e.rps) : 0,
      lag: Math.round(e.lag),
      share: (outboundOf.get(e.from) ?? 0) > 0 ? round(e.rps / outboundOf.get(e.from)!, 4) : 0,
    },
    records: e.records,
    ...(labelFor(e.dims, split) ? { label: labelFor(e.dims, split) } : {}),
  }));

  return {
    scene: {
      nodes: sceneNodes,
      edges: sceneEdges,
      meta: { ...table.meta, ...(spec.title ? { title: spec.title } : {}) },
      nodeKey,
    },
    splitBy: split,
    matched,
    filtered,
  };
}

/**
 * Attach per-thing facts to whichever nodes they belong to.
 *
 * A fact keyed `{ service: 'orders' }` attaches to the single `orders` node at
 * service resolution, and to every `orders / <api>` node when the projection is
 * finer. Counts sum, everything else is an instance-weighted mean - averaging
 * CPU across twelve pods and one pod without weighting is how dashboards lie.
 */
function attachFacts(nodes: SceneNode[], facts: NodeFact[]): void {
  if (!facts.length) return;
  const weights = new Map<string, number>();

  const valueOf = (node: SceneNode, k: string): string | undefined =>
    node.key[k] ?? (node.spans[k]?.length === 1 ? node.spans[k]![0] : undefined);

  for (const fact of facts) {
    const identity = Object.entries(fact.key);
    if (!identity.length) continue;
    for (const node of nodes) {
      // The key must match exactly - that is what makes this fact about this
      // thing. The fact's own dimensions only *narrow*: if the node knows a
      // conflicting value, the fact belongs to a different deployment; if the
      // node has never heard of the dimension, the fact is new information.
      if (!identity.every(([k, v]) => valueOf(node, k) === v)) continue;
      const conflicts = Object.entries(fact.dims ?? {}).some(([k, v]) => {
        const own = valueOf(node, k);
        return own !== undefined && own !== v;
      });
      if (conflicts) continue;

      const w = fact.attrs?.instances ?? 1;
      for (const [k, v] of Object.entries(fact.attrs ?? {})) {
        if (COUNT_ATTRS.has(k)) node.attrs[k] = (node.attrs[k] ?? 0) + v;
        else node.attrs[k] = (node.attrs[k] ?? 0) + v * w;
      }
      weights.set(node.id, (weights.get(node.id) ?? 0) + w);
      if (fact.component) node.component = fact.component;
      for (const [k, v] of Object.entries(fact.dims ?? {})) {
        (node.spans[k] ??= []).includes(v) || node.spans[k]!.push(v);
      }
    }
  }

  for (const node of nodes) {
    const w = weights.get(node.id);
    if (!w) continue;
    for (const k of Object.keys(node.attrs)) {
      if (!COUNT_ATTRS.has(k)) node.attrs[k] = round(node.attrs[k]! / w, 3);
    }
  }
}

/** Attributes that sum rather than average when several things roll into one node. */
const COUNT_ATTRS = new Set(['instances', 'replicas', 'pods', 'shards', 'connections']);

// --- internals -------------------------------------------------------------

interface MutableNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: NodeKind;
  key: DimValues;
  spans: Record<string, Set<string>>;
  inbound: number;
  outbound: number;
  records: number;
}

interface MutableEdge {
  id: string;
  from: string;
  to: string;
  dims: DimValues;
  spans: Record<string, Set<string>>;
  rps: number;
  latencyWeighted: number;
  errorWeighted: number;
  bytesWeighted: number;
  lag: number;
  records: number;
}

const MEASURES = new Set(['rps', 'latencyMs', 'errorRate', 'bytes', 'lag', 'share']);
export function isMeasure(field: string): boolean {
  return MEASURES.has(field);
}

function passes(record: FlowRecord, where: ViewSpec['where']): boolean {
  if (!where) return true;
  for (const [field, allowed] of Object.entries(where)) {
    if (!allowed.length) continue;
    const value = record.dims?.[field] ?? record.from[field] ?? record.to[field];
    if (value === undefined || !allowed.includes(value)) return false;
  }
  return true;
}

function touchNode(
  nodes: Map<string, MutableNode>,
  id: string,
  dims: DimValues,
  nodeKey: string[],
  record: FlowRecord,
  delta: { inbound?: number; outbound?: number },
): void {
  let n = nodes.get(id);
  if (!n) {
    const parts = nodeKey.map((k) => dims[k] ?? '∅');
    nodes.set(
      id,
      (n = {
        id,
        // Label with the most specific part of the key; the coarser parts go on
        // the second line, where they read as context rather than noise.
        label: parts[parts.length - 1] ?? id,
        ...(parts.length > 1 ? { sublabel: parts.slice(0, -1).join(' · ') } : {}),
        kind: (dims.kind as NodeKind) ?? 'service',
        key: Object.fromEntries(nodeKey.map((k, i) => [k, parts[i]!])),
        spans: {},
        inbound: 0,
        outbound: 0,
        records: 0,
      }),
    );
  }
  n.inbound += delta.inbound ?? 0;
  n.outbound += delta.outbound ?? 0;
  n.records++;
  collectSpans(n.spans, dims, [], nodeKey);
  void record;
}

function collectSpans(
  into: Record<string, Set<string>>,
  dims: DimValues,
  exclude: string[],
  nodeKey: string[],
): void {
  for (const [k, v] of Object.entries(dims)) {
    if (exclude.includes(k) || nodeKey.includes(k)) continue;
    (into[k] ??= new Set()).add(v);
  }
}

function sortSpans(spans: Record<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(spans)) out[k] = [...v].sort();
  return out;
}

function labelFor(dims: DimValues, split: string[]): string | undefined {
  const parts = split.map((d) => dims[d]).filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** Map known failure/traffic dimensions onto the renderer's edge kinds. */
function edgeKindOf(dims: DimValues): EdgeKind {
  const k = dims.kind ?? dims.edgeKind;
  if (k === 'retry' || k === 'challenge' || k === 'response' || k === 'async' || k === 'request') return k;
  return 'request';
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
