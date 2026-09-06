import type { NodeHealth } from './failure.js';
import type { SceneNode } from './scene.js';
import type { Theme } from './theme.js';

/**
 * The component library for world mode.
 *
 * Flat boxes are fine for a topology, but they make you *read* every label to
 * know what a thing is. A little world does not: a rack reads as compute, a
 * cylinder reads as a relational store, a chip reads as a cache, and the size
 * of the rack tells you how many instances are behind it. You can glance at it.
 *
 * These are direct pictures of software, not factory metaphors - no conveyor
 * belts, no smokestacks. The only borrowed cue is mass: more instances is
 * visibly more machine.
 *
 * Extending: register a component here and any spec - hand-written or composed
 * by a model - can select it by name. The renderer never knows their internals.
 */

export interface ComponentBox {
  /** Centre x of the footprint. */
  cx: number;
  /** Top y of the footprint. */
  top: number;
  w: number;
  h: number;
}

export interface Gauge {
  label: string;
  /** 0..1 */
  value: number;
}

export interface ComponentProps {
  instances: number;
  gauges: Gauge[];
  fill: string;
  stroke: string;
  accent: string;
  muted: string;
  ground: string;
  danger: string;
  health: NodeHealth;
  /** 0..1 animation of the failure front arriving. */
  struck: number;
}

export interface WorldComponent {
  name: string;
  summary: string;
  /** Which node kinds this is a sensible default for. */
  tierHint: number;
  draw(ctx: CanvasRenderingContext2D, box: ComponentBox, p: ComponentProps): void;
}

const GAUGE_H = 3;
const GAUGE_GAP = 2;

/** Height reserved under the body for gauges. */
export function gaugeSpace(p: ComponentProps): number {
  return p.gauges.length ? p.gauges.length * (GAUGE_H + GAUGE_GAP) + 3 : 0;
}

function bodyBox(box: ComponentBox, p: ComponentProps): { x: number; y: number; w: number; h: number } {
  const reserve = gaugeSpace(p);
  return { x: box.cx - box.w / 2, y: box.top, w: box.w, h: Math.max(box.h - reserve, 12) };
}

function drawGauges(ctx: CanvasRenderingContext2D, box: ComponentBox, p: ComponentProps): void {
  if (!p.gauges.length) return;
  const w = box.w * 0.82;
  const x = box.cx - w / 2;
  let y = box.top + box.h - gaugeSpace(p) + 3;
  for (const g of p.gauges) {
    ctx.fillStyle = p.muted;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(x, y, w, GAUGE_H);
    ctx.globalAlpha = 1;
    // Saturation is the message here: a gauge past ~85% is the thing you want
    // to spot from across the room, so it changes hue rather than just length.
    ctx.fillStyle = g.value > 0.85 ? p.danger : g.value > 0.7 ? p.accent : p.stroke;
    ctx.fillRect(x, y, Math.max(1, w * clamp01(g.value)), GAUGE_H);
    y += GAUGE_H + GAUGE_GAP;
  }
}

/** How many silhouettes to stack for an instance count. Log, so 200 pods stay drawable. */
export function stackCount(instances: number): number {
  if (instances <= 1) return 1;
  return Math.min(5, 1 + Math.floor(Math.log2(instances)));
}

function withStack(
  ctx: CanvasRenderingContext2D,
  box: ComponentBox,
  p: ComponentProps,
  drawOne: (b: { x: number; y: number; w: number; h: number }, front: boolean) => void,
): void {
  const b = bodyBox(box, p);
  const n = stackCount(p.instances);
  const step = Math.min(4, b.w * 0.06);
  for (let i = n - 1; i >= 0; i--) {
    const offset = i * step;
    ctx.globalAlpha = i === 0 ? 1 : 0.42 - i * 0.05;
    drawOne({ x: b.x + offset, y: b.y - offset, w: b.w - offset, h: b.h - offset }, i === 0);
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
}

function shell(ctx: CanvasRenderingContext2D, p: ComponentProps): void {
  ctx.fillStyle = p.fill;
  ctx.strokeStyle = p.stroke;
  ctx.lineWidth = 1.2;
}

export const COMPONENTS: Record<string, WorldComponent> = {
  'service-rack': {
    name: 'service-rack',
    summary: 'a rack of compute; more instances is a deeper stack and a wider body',
    tierHint: 2,
    draw(ctx, box, p) {
      withStack(ctx, box, p, (b, front) => {
        shell(ctx, p);
        roundRect(ctx, b.x, b.y, b.w, b.h, 3);
        ctx.fill();
        ctx.stroke();
        if (!front) return;
        ctx.strokeStyle = p.muted;
        ctx.lineWidth = 1;
        const slats = Math.max(2, Math.min(4, Math.floor(b.h / 7)));
        for (let i = 1; i <= slats; i++) {
          const y = b.y + (b.h / (slats + 1)) * i;
          ctx.beginPath();
          ctx.moveTo(b.x + 4, y);
          ctx.lineTo(b.x + b.w - 9, y);
          ctx.stroke();
        }
        ctx.fillStyle = p.health === 'dead' ? p.danger : p.accent;
        ctx.fillRect(b.x + b.w - 6, b.y + 4, 2.5, 2.5);
      });
      drawGauges(ctx, box, p);
    },
  },

  'gateway-arch': {
    name: 'gateway-arch',
    summary: 'an entry point traffic passes through',
    tierHint: 1,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      shell(ctx, p);
      roundRect(ctx, b.x, b.y, b.w, b.h, 3);
      ctx.fill();
      ctx.stroke();
      // Portal cut-out: the thing traffic goes through.
      ctx.fillStyle = p.ground;
      const aw = b.w * 0.44;
      const ah = b.h * 0.62;
      ctx.beginPath();
      ctx.moveTo(b.x + (b.w - aw) / 2, b.y + b.h);
      ctx.lineTo(b.x + (b.w - aw) / 2, b.y + b.h - ah + aw / 2);
      ctx.arc(b.x + b.w / 2, b.y + b.h - ah + aw / 2, aw / 2, Math.PI, 0);
      ctx.lineTo(b.x + (b.w + aw) / 2, b.y + b.h);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      drawGauges(ctx, box, p);
    },
  },

  'client-terminal': {
    name: 'client-terminal',
    summary: 'callers outside the system',
    tierHint: 0,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      const h = b.h * 0.74;
      shell(ctx, p);
      roundRect(ctx, b.x, b.y, b.w, h, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.accent;
      ctx.fillRect(b.x + 5, b.y + 5, Math.max(3, b.w * 0.22), 2.5);
      ctx.globalAlpha = 0.6;
      ctx.fillRect(b.x + 5, b.y + 10, Math.max(3, b.w * 0.4), 2.5);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = p.stroke;
      ctx.beginPath();
      ctx.moveTo(b.x + b.w / 2, b.y + h);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h - 2);
      ctx.moveTo(b.x + b.w * 0.28, b.y + b.h - 2);
      ctx.lineTo(b.x + b.w * 0.72, b.y + b.h - 2);
      ctx.stroke();
      drawGauges(ctx, box, p);
    },
  },

  'db-cylinder': {
    name: 'db-cylinder',
    summary: 'a relational store',
    tierHint: 4,
    draw(ctx, box, p) {
      withStack(ctx, box, p, (b, front) => {
        const ry = Math.min(6, b.h * 0.17);
        shell(ctx, p);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + ry);
        ctx.lineTo(b.x, b.y + b.h - ry);
        ctx.ellipse(b.x + b.w / 2, b.y + b.h - ry, b.w / 2, ry, 0, Math.PI, 0, true);
        ctx.lineTo(b.x + b.w, b.y + ry);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ellipse(ctx, b.x + b.w / 2, b.y + ry, b.w / 2, ry);
        ctx.fill();
        ctx.stroke();
        if (!front) return;
        ctx.strokeStyle = p.muted;
        ctx.lineWidth = 1;
        ellipse(ctx, b.x + b.w / 2, b.y + ry + (b.h - ry * 2) * 0.45, b.w / 2, ry);
        ctx.stroke();
      });
      drawGauges(ctx, box, p);
    },
  },

  'db-discs': {
    name: 'db-discs',
    summary: 'a wide-column or analytics store: separated discs, not one barrel',
    tierHint: 4,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      const ry = Math.min(5, b.h * 0.14);
      const n = 3;
      shell(ctx, p);
      for (let i = 0; i < n; i++) {
        const cy = b.y + ry + ((b.h - ry * 2) / (n - 1)) * i;
        ellipse(ctx, b.x + b.w / 2, cy, b.w / 2, ry);
        ctx.fill();
        ctx.stroke();
      }
      drawGauges(ctx, box, p);
    },
  },

  'db-cube': {
    name: 'db-cube',
    summary: 'a key-value store: one addressable block',
    tierHint: 4,
    draw(ctx, box, p) {
      withStack(ctx, box, p, (b) => {
        const d = Math.min(8, b.w * 0.2);
        const w = b.w - d;
        const h = b.h - d;
        shell(ctx, p);
        ctx.fillRect(b.x, b.y + d, w, h);
        ctx.strokeRect(b.x, b.y + d, w, h);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + d);
        ctx.lineTo(b.x + d, b.y);
        ctx.lineTo(b.x + w + d, b.y);
        ctx.lineTo(b.x + w, b.y + d);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b.x + w, b.y + d);
        ctx.lineTo(b.x + w + d, b.y);
        ctx.lineTo(b.x + w + d, b.y + h);
        ctx.lineTo(b.x + w, b.y + d + h);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      });
      drawGauges(ctx, box, p);
    },
  },

  'db-drum': {
    name: 'db-drum',
    summary: 'an append-only log or stream',
    tierHint: 4,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      const rx = Math.min(7, b.w * 0.16);
      shell(ctx, p);
      ctx.beginPath();
      ctx.moveTo(b.x + rx, b.y);
      ctx.lineTo(b.x + b.w - rx, b.y);
      ctx.ellipse(b.x + b.w - rx, b.y + b.h / 2, rx, b.h / 2, 0, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(b.x + rx, b.y + b.h);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ellipse(ctx, b.x + rx, b.y + b.h / 2, rx, b.h / 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = p.muted;
      for (const f of [0.42, 0.68]) {
        ctx.beginPath();
        ctx.ellipse(b.x + rx + (b.w - rx * 2) * f, b.y + b.h / 2, rx * 0.8, b.h / 2 - 1, 0, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
      }
      drawGauges(ctx, box, p);
    },
  },

  'cache-chip': {
    name: 'cache-chip',
    summary: 'in-memory cache: a chip with pins',
    tierHint: 3,
    draw(ctx, box, p) {
      withStack(ctx, box, p, (b, front) => {
        const inset = Math.min(5, b.w * 0.12);
        shell(ctx, p);
        roundRect(ctx, b.x + inset, b.y + 2, b.w - inset * 2, b.h - 4, 2);
        ctx.fill();
        ctx.stroke();
        if (!front) return;
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = 1.1;
        const pins = Math.max(2, Math.min(4, Math.floor((b.h - 8) / 6)));
        for (let i = 0; i < pins; i++) {
          const y = b.y + 6 + ((b.h - 12) / Math.max(pins - 1, 1)) * i;
          ctx.beginPath();
          ctx.moveTo(b.x + inset, y);
          ctx.lineTo(b.x, y);
          ctx.moveTo(b.x + b.w - inset, y);
          ctx.lineTo(b.x + b.w, y);
          ctx.stroke();
        }
        ctx.strokeStyle = p.accent;
        roundRect(ctx, b.x + inset + 4, b.y + 6, b.w - inset * 2 - 8, b.h - 12, 1);
        ctx.stroke();
      });
      drawGauges(ctx, box, p);
    },
  },

  'queue-pipe': {
    name: 'queue-pipe',
    summary: 'a queue: messages waiting in a pipe',
    tierHint: 3,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      shell(ctx, p);
      roundRect(ctx, b.x, b.y + b.h * 0.22, b.w, b.h * 0.56, b.h * 0.28);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.accent;
      for (let i = 0; i < 3; i++) {
        const s = b.h * 0.2;
        ctx.fillRect(b.x + 6 + i * (s + 3), b.y + b.h / 2 - s / 2, s, s);
      }
      drawGauges(ctx, box, p);
    },
  },

  'blob-bucket': {
    name: 'blob-bucket',
    summary: 'object storage',
    tierHint: 4,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      const ry = Math.min(5, b.h * 0.15);
      shell(ctx, p);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + ry);
      ctx.lineTo(b.x + b.w * 0.16, b.y + b.h - ry);
      ctx.ellipse(b.x + b.w / 2, b.y + b.h - ry, b.w * 0.34, ry * 0.8, 0, Math.PI, 0, true);
      ctx.lineTo(b.x + b.w, b.y + ry);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ellipse(ctx, b.x + b.w / 2, b.y + ry, b.w / 2, ry);
      ctx.fill();
      ctx.stroke();
      drawGauges(ctx, box, p);
    },
  },

  'external-cloud': {
    name: 'external-cloud',
    summary: 'something outside your control',
    tierHint: 0,
    draw(ctx, box, p) {
      const b = bodyBox(box, p);
      shell(ctx, p);
      ctx.setLineDash([4, 3]);
      const r = b.h * 0.34;
      ctx.beginPath();
      ctx.arc(b.x + b.w * 0.3, b.y + b.h * 0.6, r, Math.PI * 0.5, Math.PI * 1.5);
      ctx.arc(b.x + b.w * 0.45, b.y + b.h * 0.4, r * 0.9, Math.PI, Math.PI * 1.85);
      ctx.arc(b.x + b.w * 0.72, b.y + b.h * 0.6, r, Math.PI * 1.5, Math.PI * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      drawGauges(ctx, box, p);
    },
  },
};

export type ComponentName = keyof typeof COMPONENTS;

/** Vocabulary an engine name might come in as, mapped to a silhouette. */
const ENGINE_HINTS: [RegExp, string][] = [
  [/postgres|mysql|maria|aurora|spanner|cockroach|sql|rdbms|relational/i, 'db-cylinder'],
  [/cassandra|bigtable|scylla|clickhouse|druid|column|olap|warehouse|snowflake|bigquery/i, 'db-discs'],
  [/dynamo|rocksdb|leveldb|etcd|kv|key-?value|riak/i, 'db-cube'],
  [/kafka|kinesis|pulsar|log|stream|wal|event/i, 'db-drum'],
  [/redis|memcache|cache/i, 'cache-chip'],
  [/sqs|rabbit|queue|celery|nsq/i, 'queue-pipe'],
  [/s3|gcs|blob|object|bucket|minio/i, 'blob-bucket'],
];

/**
 * Pick a silhouette for a node. An explicit hint wins; then an engine-ish
 * dimension; then the node kind. Falling back to the kind means an unannotated
 * table still produces a legible world.
 */
export function pickComponent(node: SceneNode, hint?: string): string {
  if (hint && COMPONENTS[hint]) return hint;
  const candidates = [
    node.attrs?.component as unknown as string,
    ...Object.values(node.key),
    ...Object.values(node.spans).flatMap((v) => (v.length === 1 ? v : [])),
  ].filter((v): v is string => typeof v === 'string');
  for (const value of candidates) {
    if (COMPONENTS[value]) return value;
    for (const [re, name] of ENGINE_HINTS) if (re.test(value)) return name;
  }
  switch (node.kind) {
    case 'client':
      return 'client-terminal';
    case 'gateway':
      return 'gateway-arch';
    case 'cache':
      return 'cache-chip';
    case 'queue':
      return 'queue-pipe';
    case 'datastore':
      return 'db-cylinder';
    case 'external':
      return 'external-cloud';
    default:
      return 'service-rack';
  }
}

/**
 * Default tier for a node kind, top to bottom: what talks to you, what runs
 * your code, what holds your state.
 *
 * Three planes, not seven. Each plane costs real vertical pixels - the body,
 * its gauges, and two lines of label - and a world with more planes than the
 * canvas can afford is a world where every plane overlaps the next. Split
 * further with `world.tierBy` when a particular question needs it.
 */
export function defaultTier(node: SceneNode): number {
  switch (node.kind) {
    case 'client':
    case 'external':
    case 'gateway':
      return 0;
    case 'service':
      return 1;
    case 'cache':
    case 'queue':
    case 'datastore':
      return 2;
    default:
      return 1;
  }
}

export const TIER_LABELS = ['edge', 'services', 'data'];

export function componentProps(theme: Theme): Pick<ComponentProps, 'stroke' | 'muted' | 'ground' | 'danger' | 'accent'> {
  return {
    stroke: theme.border,
    muted: theme.textMuted,
    ground: theme.background,
    danger: theme.error,
    accent: theme.flow.request,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
