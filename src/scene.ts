import type { DimValues, FlowMeasures } from './model.js';
import type { EdgeKind, Graph, NodeKind } from './types.js';
import { resolveGraph } from './schema.js';

/**
 * A scene is what the renderer draws: nodes, edges, and the dimensional
 * context each of them carries. Both input paths converge here - a hand-written
 * `Graph` and a projected `FlowTable` produce the same shape, so the renderer
 * has exactly one thing to understand.
 */
export interface SceneNode {
  id: string;
  label: string;
  /** Secondary line under the label - usually the coarser half of the node key. */
  sublabel?: string;
  kind: NodeKind;
  /** The dimension values that define this node's identity. */
  key: DimValues;
  /** Distinct values of every other dimension observed at this node. */
  spans: Record<string, string[]>;
  inboundRps: number;
  outboundRps: number;
  /** Numeric attributes rolled up from node facts: instances, cpu, mem, ... */
  attrs: Record<string, number>;
  /** An explicit world component name, when a fact supplied one. */
  component?: string;
  /** How many source records collapsed into this node. */
  records: number;
  layer?: number;
  x?: number;
  y?: number;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind: EdgeKind;
  /** Dimensions constant across every record in this edge - what makes it a distinct lane. */
  dims: DimValues;
  /** Distinct values of the dimensions that varied within it. */
  spans: Record<string, string[]>;
  metrics: Required<FlowMeasures>;
  records: number;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  meta: Record<string, unknown>;
  /** The node key this scene was projected on, if any. Empty for a flat graph. */
  nodeKey: string[];
}

/** Lift a hand-written flat graph into a scene, so both inputs share one path. */
export function sceneFromGraph(graph: Graph): Scene {
  const g = resolveGraph(graph);
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const e of g.edges) {
    inbound.set(e.to, (inbound.get(e.to) ?? 0) + e.metrics.rps);
    outbound.set(e.from, (outbound.get(e.from) ?? 0) + e.metrics.rps);
  }
  return {
    nodes: g.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      key: { id: n.id },
      spans: {},
      inboundRps: inbound.get(n.id) ?? 0,
      outboundRps: outbound.get(n.id) ?? 0,
      attrs: {},
      records: 1,
      ...(n.layer !== undefined ? { layer: n.layer } : {}),
      ...(n.x !== undefined ? { x: n.x } : {}),
      ...(n.y !== undefined ? { y: n.y } : {}),
    })),
    edges: g.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      dims: { kind: e.kind },
      spans: {},
      metrics: {
        ...e.metrics,
        share: (outbound.get(e.from) ?? 0) > 0 ? e.metrics.rps / outbound.get(e.from)! : 0,
      },
      records: 1,
      ...(e.label !== undefined ? { label: e.label } : {}),
    })),
    meta: g.meta,
    nodeKey: [],
  };
}
