import type { LayoutNode, Point } from './layout.js';

/** A quadratic bezier from `a` to `b`, with sampled arc-length. */
export interface EdgePath {
  a: Point;
  b: Point;
  ctrl: Point;
  length: number;
  pointAt(t: number): Point;
  tangentAt(t: number): Point;
}

function quad(a: Point, c: Point, b: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x,
    y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y,
  };
}

/** Where a line from `from` towards `to` leaves `from`'s rounded box. */
export function borderPoint(box: LayoutNode, towards: Point, inset = 4): Point {
  const dx = towards.x - box.x;
  const dy = towards.y - box.y;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  const hw = box.width / 2 + inset;
  const hh = box.height / 2 + inset;
  const scale = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  return { x: box.x + dx * scale, y: box.y + dy * scale };
}

/**
 * Build the path for one edge.
 *
 * `offset` bows the curve sideways. Bidirectional pairs get equal and opposite
 * offsets so the forward and reverse streams are visibly separate lanes -
 * without that, a 401 challenge leg hides underneath the request it answers,
 * and the whole point of the picture is lost.
 */
export function edgePath(from: LayoutNode, to: LayoutNode, offset = 0): EdgePath {
  if (from.id === to.id) return selfLoop(from);

  const a = borderPoint(from, { x: to.x, y: to.y });
  const b = borderPoint(to, { x: from.x, y: from.y });
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector, scaled by the requested lane offset.
  const ctrl: Point = { x: mx + (-dy / len) * offset * 2, y: my + (dx / len) * offset * 2 };

  return finish(a, b, ctrl);
}

function selfLoop(node: LayoutNode): EdgePath {
  const a: Point = { x: node.x + node.width / 2, y: node.y - node.height / 4 };
  const b: Point = { x: node.x + node.width / 2, y: node.y + node.height / 4 };
  const ctrl: Point = { x: node.x + node.width / 2 + 54, y: node.y };
  return finish(a, b, ctrl);
}

function finish(a: Point, b: Point, ctrl: Point): EdgePath {
  const SAMPLES = 24;
  let length = 0;
  let prev = a;
  for (let i = 1; i <= SAMPLES; i++) {
    const p = quad(a, ctrl, b, i / SAMPLES);
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return {
    a,
    b,
    ctrl,
    length: length || 1,
    pointAt: (t) => quad(a, ctrl, b, t),
    tangentAt: (t) => {
      const mt = 1 - t;
      const x = 2 * mt * (ctrl.x - a.x) + 2 * t * (b.x - ctrl.x);
      const y = 2 * mt * (ctrl.y - a.y) + 2 * t * (b.y - ctrl.y);
      const m = Math.hypot(x, y) || 1;
      return { x: x / m, y: y / m };
    },
  };
}

/** Shortest distance from a point to the sampled curve, for hit-testing. */
export function distanceToPath(path: EdgePath, p: Point, samples = 20): number {
  let best = Infinity;
  let prev = path.pointAt(0);
  for (let i = 1; i <= samples; i++) {
    const cur = path.pointAt(i / samples);
    best = Math.min(best, distanceToSegment(p, prev, cur));
    prev = cur;
  }
  return best;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
