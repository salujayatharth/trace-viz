/**
 * tracelight data model.
 *
 * A `Graph` is a snapshot of a service topology plus the traffic measured on
 * each edge over some window. Everything the renderer draws is derived from
 * these numbers - there is no styling information in the data.
 */

/** What a node is, which decides its glyph and default colour. */
export type NodeKind =
  | 'client'
  | 'gateway'
  | 'service'
  | 'datastore'
  | 'cache'
  | 'queue'
  | 'external';

/**
 * What a flow is. This is deliberately semantic rather than visual: `retry`
 * and `challenge` traffic is drawn as wasted work (dashed, muted, and counted
 * separately in the summary) because that is the thing worth noticing.
 */
export type EdgeKind = 'request' | 'response' | 'retry' | 'challenge' | 'async';

export interface GraphNode {
  id: string;
  label?: string;
  kind?: NodeKind;
  /** Optional grouping key, e.g. a team or a bounded context. */
  group?: string;
  /** Pin the node to a layer (column). Omit to let the layout infer it. */
  layer?: number;
  /** Pin the node to explicit canvas coordinates, bypassing layout entirely. */
  x?: number;
  y?: number;
  /** Anything you want back in the hover card. */
  meta?: Record<string, unknown>;
}

/**
 * Traffic measured on one edge.
 *
 * The visual encoding is fixed and intentional:
 *   rps        -> particle emission rate  (log-scaled; "how much")
 *   latencyMs  -> particle speed          (inverse; "how slow")
 *   errorRate  -> fraction of red particles
 *   bytes      -> particle radius         (sqrt-scaled)
 *
 * Keeping throughput and latency in separate channels is the whole point: a
 * saturated-but-fast link must not look like a quiet-but-slow one.
 */
export interface EdgeMetrics {
  /** Requests per second. Drives particle density. Must be >= 0. */
  rps: number;
  /** Mean (or p50) latency in milliseconds. Drives particle speed. */
  latencyMs?: number;
  /** Fraction of failing calls, 0..1. Drives the red particle mix. */
  errorRate?: number;
  /** Mean payload size in bytes. Drives particle radius. */
  bytes?: number;
}

export interface GraphEdge {
  /** Stable id. Generated from `from->to` if omitted. */
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
  metrics: EdgeMetrics;
  meta?: Record<string, unknown>;
}

export interface GraphMeta {
  title?: string;
  /** Human description of the measurement window, e.g. "5m avg". */
  window?: string;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface Graph {
  /** Schema version. Currently always 1. */
  version?: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta?: GraphMeta;
}

/** A graph after validation and defaulting - what the renderer actually uses. */
export interface ResolvedEdge extends GraphEdge {
  id: string;
  kind: EdgeKind;
  metrics: Required<EdgeMetrics>;
}

export interface ResolvedNode extends GraphNode {
  label: string;
  kind: NodeKind;
}

export interface ResolvedGraph {
  version: 1;
  nodes: ResolvedNode[];
  edges: ResolvedEdge[];
  meta: GraphMeta;
}
