/** The minimum a graph must expose to be laid out. Both a flat graph and a projected scene satisfy it. */
export interface LayoutInput {
  nodes: { id: string; layer?: number; x?: number; y?: number }[];
  edges: { from: string; to: string; kind?: string; id?: string }[];
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode extends Point {
  id: string;
  layer: number;
  width: number;
  height: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  padding: number;
  nodeWidth: number;
  nodeHeight: number;
  /** Extra separation between layers, on top of what fitting requires. */
  layerGap: number;
  rowGap: number;
  /**
   * 0..1 pull per edge, from the distance channel. Ordering within a column
   * weights neighbours by it, so a service ends up beside the thing it sends
   * most of its traffic to, not merely beside something it calls.
   */
  weightOf?: (edgeId: string) => number;
  /**
   * Override the crossing-minimising row order inside each column with an
   * explicit key - by name, or by traffic - when a stable, scannable order
   * matters more than fewer crossings.
   */
  rowKey?: (nodeId: string) => string | number;
}

export const defaultLayout: LayoutOptions = {
  width: 960,
  height: 540,
  padding: 48,
  nodeWidth: 132,
  nodeHeight: 46,
  layerGap: 64,
  rowGap: 26,
};

/**
 * Layered left-to-right layout ("Sugiyama-lite").
 *
 * Deliberately simple and fully deterministic: same graph in, same picture
 * out, every reload. A force layout would look organic and make it impossible
 * to compare two screenshots, which is exactly what this tool is for.
 *
 * 1. Assign layers by longest path from a source, ignoring back-edges so that
 *    a response or retry edge does not push its target rightwards.
 * 2. Order within each layer by the barycentre of already-placed neighbours,
 *    a couple of sweeps. Good enough to remove most crossings.
 * 3. Distribute evenly in the available box.
 *
 * Nodes with explicit `x`/`y` are honoured verbatim; nodes with an explicit
 * `layer` skip step 1.
 */
export function layoutGraph(
  graph: LayoutInput,
  options: Partial<LayoutOptions> = {},
): Map<string, LayoutNode> {
  const opt = { ...defaultLayout, ...options };
  const ids = graph.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));

  // Forward adjacency, skipping self-loops and edges that only exist as the
  // reverse of a forward pair (response/challenge legs).
  type Link = { id: string; w: number };
  const forward = new Map<string, Link[]>(ids.map((id) => [id, []]));
  const reverse = new Map<string, Link[]>(ids.map((id) => [id, []]));
  const structural = graph.edges.filter(
    (e) => e.from !== e.to && e.kind !== 'response' && e.kind !== 'challenge',
  );
  const edgeSource = structural.length ? structural : graph.edges.filter((e) => e.from !== e.to);
  for (const e of edgeSource) {
    const w = 0.15 + (opt.weightOf && e.id ? opt.weightOf(e.id) : 0.5);
    forward.get(e.from)!.push({ id: e.to, w });
    reverse.get(e.to)!.push({ id: e.from, w });
  }

  // --- 1. layers -----------------------------------------------------------
  const layer = new Map<string, number>();
  for (const n of graph.nodes) if (typeof n.layer === 'number') layer.set(n.id, n.layer);

  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  const depth = (id: string): number => {
    const pinned = layer.get(id);
    if (pinned !== undefined && state.get(id) === 2) return pinned;
    if (state.get(id) === 1) return pinned ?? 0; // cycle: stop descending
    state.set(id, 1);
    let d = pinned ?? 0;
    if (pinned === undefined) {
      for (const p of reverse.get(id) ?? []) d = Math.max(d, depth(p.id) + 1);
    }
    layer.set(id, d);
    state.set(id, 2);
    return d;
  };
  for (const id of ids) depth(id);

  const maxLayer = Math.max(0, ...layer.values());
  const byLayer: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) byLayer[layer.get(id)!]!.push(id);

  // --- 2. ordering ---------------------------------------------------------
  const order = new Map<string, number>();
  for (const column of byLayer) column.forEach((id, i) => order.set(id, i));

  const barycentre = (id: string, neighbours: Map<string, Link[]>): number => {
    const ns = neighbours.get(id) ?? [];
    if (!ns.length) return order.get(id) ?? 0;
    let sum = 0;
    let weight = 0;
    for (const n of ns) {
      sum += (order.get(n.id) ?? 0) * n.w;
      weight += n.w;
    }
    return sum / weight;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    const neighbours = sweep % 2 === 0 ? reverse : forward;
    const columns = sweep % 2 === 0 ? byLayer : [...byLayer].reverse();
    for (const column of columns) {
      const keyed = column.map((id) => ({
        id,
        key: barycentre(id, neighbours),
        tie: index.get(id) ?? 0,
      }));
      keyed.sort((a, b) => a.key - b.key || a.tie - b.tie);
      keyed.forEach((k, i) => order.set(k.id, i));
      column.sort((a, b) => order.get(a)! - order.get(b)!);
    }
  }

  // An explicit row key replaces the crossing-minimised order outright.
  if (opt.rowKey) {
    for (const column of byLayer) {
      column.sort((a, b) => {
        const ka = opt.rowKey!(a);
        const kb = opt.rowKey!(b);
        return typeof ka === 'number' && typeof kb === 'number' ? kb - ka : String(ka).localeCompare(String(kb));
      });
    }
  }

  // --- 3. coordinates ------------------------------------------------------
  const columns = byLayer.length;
  const availW = Math.max(opt.width - opt.padding * 2, 120);

  // Shrink the boxes when there are more layers than the canvas comfortably
  // fits, rather than letting adjacent columns touch and read as one blob.
  const MIN_COL_GAP = 36;
  const nodeWidth = Math.max(
    64,
    Math.min(opt.nodeWidth, (availW - (columns - 1) * MIN_COL_GAP) / Math.max(columns, 1)),
  );

  // Inset by half a node so boxes at the extremes are not clipped by the edge
  // of the canvas.
  // The same for rows: a column of eleven services must not stack its boxes
  // on top of each other. Shrink the box before overlapping it.
  const MIN_ROW_GAP = 8;
  const deepest = Math.max(1, ...byLayer.map((c) => c.length));
  const availH = Math.max(opt.height - opt.padding * 2, 80);
  const nodeHeight = Math.max(
    22,
    Math.min(opt.nodeHeight, (availH - (deepest - 1) * MIN_ROW_GAP) / deepest),
  );

  const usableW = Math.max(availW - nodeWidth, 1);
  const usableH = Math.max(availH - nodeHeight, 1);
  const originX = opt.padding + nodeWidth / 2;
  const originY = opt.padding + nodeHeight / 2;
  const colStep = columns > 1 ? usableW / (columns - 1) : 0;

  const positions = new Map<string, LayoutNode>();
  for (const [li, column] of byLayer.entries()) {
    const rows = column.length;
    // Fill the height when a column is deep, but do not fling two nodes to
    // opposite corners just because there is room.
    const step =
      rows > 1
        ? Math.min(
            usableH / (rows - 1),
            Math.max(nodeHeight + opt.rowGap, usableH * 0.55),
          )
        : 0;
    const blockH = step * (rows - 1);
    const top = originY + (usableH - blockH) / 2;
    for (const [ri, id] of column.entries()) {
      const node = graph.nodes[index.get(id)!]!;
      positions.set(id, {
        id,
        layer: li,
        x: node.x ?? (columns > 1 ? originX + li * colStep : opt.width / 2),
        y: node.y ?? (rows > 1 ? top + ri * step : opt.height / 2),
        width: nodeWidth,
        height: nodeHeight,
      });
    }
  }

  void opt.layerGap;
  return positions;
}
