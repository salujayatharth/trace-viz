/**
 * The dimensional model.
 *
 * v0.1 had one shape: a node is a box, an edge is a number. That shape cannot
 * express a real system, where a "service" is a dozen APIs, each API is
 * deployed into several environments and regions, and each dependency has its
 * own failure semantics. Those are all *dimensions* of the same traffic.
 *
 * So the input is a flat table of flows carrying arbitrary dimensions, and the
 * picture is a **projection** of it. Which dimensions define a node, which are
 * filtered away, and which drive a visual channel are all runtime choices - the
 * knobs. Nothing here is drawn; see `project.ts` and `channels.ts`.
 */

/** Values a dimension can take. Everything is stringly-typed on purpose: dimensions are categorical. */
export type DimValues = Record<string, string>;

export interface FlowMeasures {
  rps: number;
  latencyMs?: number;
  errorRate?: number;
  bytes?: number;
  /**
   * Derived, never supplied: this edge's rps as a fraction of everything its
   * caller sends. 0.8 means the caller puts most of its traffic here - that is
   * coupling, and it is what `distance` pulls on by default.
   */
  share?: number;
}

/**
 * One measured flow between two endpoints.
 *
 * `from` and `to` are coordinates in dimension space, not ids: `{ service:
 * 'orders', api: 'POST /orders' }`. What counts as a node is decided later, by
 * the projection. `dims` holds dimensions of the flow itself - the region it
 * was measured in, the environment, whether the caller fails closed on it.
 */
export interface FlowRecord {
  from: DimValues;
  to: DimValues;
  dims?: DimValues;
  metrics: FlowMeasures;
}

/**
 * A fact about a *thing*, not a flow: how many instances it runs, what engine
 * it is, how hot its CPU is. `key` is a partial coordinate - it attaches to
 * every node whose identity is consistent with it, at whatever resolution the
 * current projection happens to use.
 */
export interface NodeFact {
  key: DimValues;
  /** Numeric attributes: instances, cpu, mem, disk, connections - anything. */
  attrs?: Record<string, number>;
  /** Force a particular world component, e.g. "db-drum". */
  component?: string;
  /** Extra dimensions carried by the thing itself, e.g. engine or team. */
  dims?: DimValues;
}

export interface FlowTable {
  version?: 1;
  records: FlowRecord[];
  /** Optional per-thing facts, used by world mode for size, gauges and shape. */
  nodes?: NodeFact[];
  meta?: Record<string, unknown>;
}

export interface DimensionMeta {
  name: string;
  /** Distinct values, sorted. Truncated at `maxValues` with `truncated: true`. */
  values: string[];
  cardinality: number;
  truncated: boolean;
  /** True when the dimension appears on `from`/`to` and can therefore define node identity. */
  endpoint: boolean;
  /** True when it appears on the flow itself and can therefore split an edge into lanes. */
  flow: boolean;
}

export interface TableSchema {
  dimensions: DimensionMeta[];
  measures: string[];
  /** Numeric node attributes available for size, gauges and distance. */
  nodeAttrs: string[];
  records: number;
}

/**
 * Describe what knobs a table actually offers.
 *
 * Cardinality matters for more than documentation: a 40-value dimension on a
 * colour channel is unreadable, and both the UI and the spec agent use these
 * counts to refuse that binding.
 */
export function describeTable(table: FlowTable, maxValues = 64): TableSchema {
  const seen = new Map<string, { values: Set<string>; endpoint: boolean; flow: boolean }>();
  const measures = new Set<string>();

  const note = (dims: DimValues | undefined, where: 'endpoint' | 'flow'): void => {
    if (!dims) return;
    for (const [k, v] of Object.entries(dims)) {
      let entry = seen.get(k);
      if (!entry) seen.set(k, (entry = { values: new Set(), endpoint: false, flow: false }));
      entry.values.add(v);
      entry[where] = true;
    }
  };

  for (const r of table.records) {
    note(r.from, 'endpoint');
    note(r.to, 'endpoint');
    note(r.dims, 'flow');
    for (const [k, v] of Object.entries(r.metrics)) if (typeof v === 'number') measures.add(k);
  }

  const nodeAttrs = new Set<string>();
  for (const f of table.nodes ?? []) {
    note(f.key, 'endpoint');
    note(f.dims, 'endpoint');
    for (const k of Object.keys(f.attrs ?? {})) nodeAttrs.add(k);
  }

  const dimensions: DimensionMeta[] = [...seen.entries()]
    .map(([name, e]) => {
      const all = [...e.values].sort();
      return {
        name,
        values: all.slice(0, maxValues),
        cardinality: all.length,
        truncated: all.length > maxValues,
        endpoint: e.endpoint,
        flow: e.flow,
      };
    })
    .sort((a, b) => a.cardinality - b.cardinality || a.name.localeCompare(b.name));

  // `share` is computed at projection time from rps, so it is always available;
  // so is a per-node errorRate, rolled up from the flows a node serves.
  if (measures.has('rps')) measures.add('share');
  if (measures.has('errorRate')) nodeAttrs.add('errorRate');
  return { dimensions, measures: [...measures].sort(), nodeAttrs: [...nodeAttrs].sort(), records: table.records.length };
}

/** Every dimension available on a flow, endpoint dimensions winning on collision. */
export function endpointDims(record: FlowRecord, side: 'from' | 'to'): DimValues {
  return { ...record.dims, ...record[side] };
}

/** Look up a field on a record, whichever side of it lives on. */
export function fieldValue(record: FlowRecord, field: string, side?: 'from' | 'to'): string | undefined {
  if (side) {
    const v = record[side][field];
    if (v !== undefined) return v;
  }
  return record.dims?.[field] ?? record.from[field] ?? record.to[field];
}
