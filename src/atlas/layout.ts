import { restOf, type AtlasModel, type Unit } from './model.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Band extends Rect {
  id: string;
  level: number;
}

export interface AtlasLayout {
  /** One rect per visible unit (collapsed group tile or leaf tile). */
  rects: Map<string, Rect>;
  /** One region per expanded group, outermost first. */
  bands: Band[];
  /** World bounds. */
  world: Rect;
  colX: (depth: number) => number;
  metrics: typeof LAYOUT;
}

export const LAYOUT = {
  colW: 210,
  tileW: 160,
  tileH: 30,
  rowH: 42,
  headerH: 26,
  bandPad: 12,
  gap: { 0: 44, 1: 12, other: 6 } as Record<number | 'other', number>,
  x0: 60,
  y0: 40,
};

/**
 * Swimlane layout: x is call depth, y is ownership.
 *
 * Every expanded group is a horizontal band holding its children in display
 * order; every collapsed group is one tile stretched across the depth range
 * of its members; every leaf is a tile in its depth column. Heights are only
 * spent on what is expanded, so a fully collapsed estate is a dozen rows and
 * one open team adds only its own rows. Positions of everything else do not
 * move except to make room, which is what keeps the map memorable.
 */
export function layoutAtlas(model: AtlasModel, units: Unit[], expanded: Set<string>): AtlasLayout {
  const M = LAYOUT;
  const colX = (d: number): number => M.x0 + d * M.colW;
  const rects = new Map<string, Rect>();
  const bands: Band[] = [];
  const unitById = new Map(units.map((u) => [u.id, u]));
  // Row index of already-placed leaves, for barycentre ordering.
  const rowOf = new Map<string, number>();

  const gapFor = (level: number): number => M.gap[level] ?? M.gap.other;

  const place = (gid: string, top: number): number => {
    const g = model.groups.get(gid)!;
    if (!expanded.has(gid)) {
      const u = unitById.get(gid)!;
      const x = colX(u.depthMin);
      rects.set(gid, { x, y: top + (M.rowH - M.tileH) / 2, w: colX(u.depthMax) + M.tileW - x, h: M.tileH });
      return M.rowH;
    }
    let y = top + M.headerH;
    for (const child of g.groups) {
      y += place(child, y) + gapFor(g.level + 1);
    }
    if (g.leaves.length) {
      // Bucket leaves by depth column; order each column by the mean row of
      // its already-placed callers, falling back to traffic.
      const cols = new Map<number, string[]>();
      for (const lid of g.leaves) {
        if (!unitById.has(lid)) continue;
        const d = model.leaves.get(lid)!.depth;
        cols.set(d, [...(cols.get(d) ?? []), lid]);
      }
      const depths = [...cols.keys()].sort((a, b) => a - b);
      let rows = 0;
      for (const d of depths) {
        const ids = cols.get(d)!;
        const key = (id: string): number => {
          const callers = (model.inc.get(id) ?? [])
            .map((eid) => model.byId.get(eid)!.from)
            .filter((c) => rowOf.has(c));
          if (!callers.length) return 1000 - model.leaves.get(id)!.inRps / 1e6;
          return callers.reduce((s, c) => s + rowOf.get(c)!, 0) / callers.length;
        };
        ids.sort((a, b) => key(a) - key(b) || model.leaves.get(b)!.inRps - model.leaves.get(a)!.inRps);
        ids.forEach((id, row) => {
          rowOf.set(id, row);
          rects.set(id, { x: colX(d), y: y + row * M.rowH + (M.rowH - M.tileH) / 2, w: M.tileW, h: M.tileH });
        });
        rows = Math.max(rows, ids.length);
      }
      y += rows * M.rowH;
      // The folded remainder of a partially opened group: one row, its own depth span.
      const rest = unitById.get(restOf(gid));
      if (rest) {
        const rx = colX(rest.depthMin);
        rects.set(rest.id, { x: rx, y: y + (M.rowH - M.tileH) / 2, w: colX(rest.depthMax) + M.tileW - rx, h: M.tileH });
        y += M.rowH;
      }
    } else {
      y -= gapFor(g.level + 1);
    }
    const x = colX(g.depthMin) - M.bandPad;
    const bottom = y + M.bandPad / 2;
    bands.push({ id: gid, level: g.level, x, y: top, w: colX(g.depthMax) + M.tileW + M.bandPad - x, h: bottom - top });
    return bottom - top;
  };

  let y = M.y0;
  for (const r of model.roots) y += place(r, y) + gapFor(0);

  // Outer bands first so inner ones draw on top.
  bands.sort((a, b) => a.level - b.level);

  const world: Rect = {
    x: 0,
    y: 0,
    w: colX(model.maxDepth) + M.tileW + M.x0 + M.bandPad * 2,
    h: y + M.y0,
  };
  return { rects, bands, world, colX, metrics: M };
}
