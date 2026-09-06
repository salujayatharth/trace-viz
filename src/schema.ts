import type {
  Graph,
  GraphEdge,
  GraphNode,
  ResolvedEdge,
  ResolvedGraph,
  ResolvedNode,
} from './types.js';

export class GraphValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid graph:\n  - ${issues.join('\n  - ')}`);
    this.name = 'GraphValidationError';
    this.issues = issues;
  }
}

const NODE_KINDS = new Set([
  'client',
  'gateway',
  'service',
  'datastore',
  'cache',
  'queue',
  'external',
]);
const EDGE_KINDS = new Set(['request', 'response', 'retry', 'challenge', 'async']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate and normalise a graph. Unknown fields are preserved; missing
 * optional fields are filled with defaults so the renderer never has to
 * branch on undefined.
 *
 * Throws {@link GraphValidationError} listing every problem at once, rather
 * than failing on the first one - you usually want the whole list when a
 * pipeline is producing the JSON.
 */
export function resolveGraph(input: Graph): ResolvedGraph {
  const issues: string[] = [];

  if (!input || typeof input !== 'object') {
    throw new GraphValidationError(['graph must be an object']);
  }
  if (!Array.isArray(input.nodes)) issues.push('nodes must be an array');
  if (!Array.isArray(input.edges)) issues.push('edges must be an array');
  if (issues.length) throw new GraphValidationError(issues);

  const seen = new Set<string>();
  const nodes: ResolvedNode[] = [];

  for (const [i, raw] of input.nodes.entries()) {
    const n = raw as GraphNode;
    if (!n || typeof n.id !== 'string' || n.id === '') {
      issues.push(`nodes[${i}]: id must be a non-empty string`);
      continue;
    }
    if (seen.has(n.id)) {
      issues.push(`nodes[${i}]: duplicate id ${JSON.stringify(n.id)}`);
      continue;
    }
    seen.add(n.id);
    if (n.kind !== undefined && !NODE_KINDS.has(n.kind)) {
      issues.push(
        `nodes[${i}] (${n.id}): unknown kind ${JSON.stringify(n.kind)}; expected one of ${[...NODE_KINDS].join(', ')}`,
      );
    }
    nodes.push({ ...n, label: n.label ?? n.id, kind: n.kind ?? 'service' });
  }

  const edges: ResolvedEdge[] = [];
  const usedIds = new Set<string>();

  for (const [i, raw] of input.edges.entries()) {
    const e = raw as GraphEdge;
    if (!e || typeof e !== 'object') {
      issues.push(`edges[${i}]: must be an object`);
      continue;
    }
    if (!seen.has(e.from)) issues.push(`edges[${i}]: unknown from-node ${JSON.stringify(e.from)}`);
    if (!seen.has(e.to)) issues.push(`edges[${i}]: unknown to-node ${JSON.stringify(e.to)}`);
    if (e.kind !== undefined && !EDGE_KINDS.has(e.kind)) {
      issues.push(
        `edges[${i}]: unknown kind ${JSON.stringify(e.kind)}; expected one of ${[...EDGE_KINDS].join(', ')}`,
      );
    }

    const m = e.metrics;
    if (!m || typeof m !== 'object') {
      issues.push(`edges[${i}] (${e.from}->${e.to}): metrics is required`);
      continue;
    }
    if (!isFiniteNumber(m.rps) || m.rps < 0) {
      issues.push(`edges[${i}] (${e.from}->${e.to}): metrics.rps must be a number >= 0`);
    }
    if (m.latencyMs !== undefined && (!isFiniteNumber(m.latencyMs) || m.latencyMs < 0)) {
      issues.push(`edges[${i}] (${e.from}->${e.to}): metrics.latencyMs must be a number >= 0`);
    }
    if (m.errorRate !== undefined && (!isFiniteNumber(m.errorRate) || m.errorRate < 0 || m.errorRate > 1)) {
      issues.push(`edges[${i}] (${e.from}->${e.to}): metrics.errorRate must be between 0 and 1`);
    }
    if (m.bytes !== undefined && (!isFiniteNumber(m.bytes) || m.bytes < 0)) {
      issues.push(`edges[${i}] (${e.from}->${e.to}): metrics.bytes must be a number >= 0`);
    }

    let id = e.id ?? `${e.from}->${e.to}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}#${n}`)) n++;
      id = `${id}#${n}`;
    }
    usedIds.add(id);

    edges.push({
      ...e,
      id,
      kind: e.kind ?? 'request',
      metrics: {
        rps: m.rps,
        latencyMs: m.latencyMs ?? 25,
        errorRate: m.errorRate ?? 0,
        bytes: m.bytes ?? 1024,
      },
    });
  }

  if (issues.length) throw new GraphValidationError(issues);

  return {
    version: 1,
    nodes,
    edges,
    meta: input.meta ?? {},
  };
}

/** Non-throwing variant, for feeding user-supplied JSON into a UI. */
export function safeResolveGraph(
  input: Graph,
): { ok: true; graph: ResolvedGraph } | { ok: false; issues: string[] } {
  try {
    return { ok: true, graph: resolveGraph(input) };
  } catch (err) {
    if (err instanceof GraphValidationError) return { ok: false, issues: err.issues };
    return { ok: false, issues: [(err as Error).message] };
  }
}
