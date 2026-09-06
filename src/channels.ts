import { isMeasure, type ChannelBinding, type ViewSpec } from './project.js';
import type { Scene, SceneEdge, SceneNode } from './scene.js';
import {
  clamp,
  contrast,
  defaultEncoding,
  emissionRate,
  logNorm,
  particleRadius,
  particleSpeed,
  rpsDomain,
  type EncodingOptions,
} from './scales.js';
import type { Theme } from './theme.js';

/**
 * The channel registry: one visualization per knob.
 *
 * A channel is a visual property with its own resolver. Bind any compatible
 * field to any channel and the picture changes - that is the whole framework.
 * Adding a channel here is the supported way to extend it; the renderer reads
 * only the resolved values, never the bindings.
 */
export type ChannelName =
  | 'density'
  | 'speed'
  | 'radius'
  | 'hue'
  | 'glyph'
  | 'dash'
  | 'lane'
  | 'coupling'
  | 'distance'
  | 'nodeFill'
  | 'halo'
  | 'column';

export type Glyph = 'dot' | 'ring' | 'square' | 'triangle' | 'bar' | 'diamond';
export type Coupling = 'plain' | 'rigid' | 'breakaway';

export interface ChannelDef {
  name: ChannelName;
  target: 'edge' | 'node';
  accepts: 'dimension' | 'measure' | 'both';
  /** Refuse a categorical binding above this many distinct values - it would be unreadable. */
  maxCardinality?: number;
  summary: string;
}

export const CHANNELS: Record<ChannelName, ChannelDef> = {
  density: { name: 'density', target: 'edge', accepts: 'measure', summary: 'particles per second along the edge (log-scaled)' },
  speed: { name: 'speed', target: 'edge', accepts: 'measure', summary: 'how fast particles travel; inverted, so high values crawl' },
  radius: { name: 'radius', target: 'edge', accepts: 'measure', summary: 'particle size (sqrt-scaled)' },
  hue: { name: 'hue', target: 'edge', accepts: 'dimension', maxCardinality: 12, summary: 'particle colour, one per category' },
  glyph: { name: 'glyph', target: 'edge', accepts: 'dimension', maxCardinality: 6, summary: 'particle shape; readable in greyscale, so it pairs with hue' },
  dash: { name: 'dash', target: 'edge', accepts: 'dimension', maxCardinality: 5, summary: 'the edge line pattern under the particles' },
  lane: { name: 'lane', target: 'edge', accepts: 'dimension', maxCardinality: 6, summary: 'splits an edge into parallel lanes, one per category' },
  coupling: { name: 'coupling', target: 'edge', accepts: 'dimension', maxCardinality: 3, summary: 'failure semantics: a rigid conduit that propagates death, or a breakaway link that stops it' },
  distance: { name: 'distance', target: 'edge', accepts: 'both', maxCardinality: 24, summary: 'how close things sit: bind a measure and heavy callers pull together, bind a dimension and same-value things cluster' },
  nodeFill: { name: 'nodeFill', target: 'node', accepts: 'dimension', maxCardinality: 10, summary: 'node fill colour, one per category' },
  halo: { name: 'halo', target: 'node', accepts: 'measure', summary: 'a ring around the node sized by a measure - traffic through it, or any numeric fact such as instances' },
  column: { name: 'column', target: 'node', accepts: 'dimension', maxCardinality: 12, summary: 'forces nodes into columns by category instead of inferring layers' },
};

export interface EdgeStyle {
  density: number;
  speed: number;
  radius: number;
  hue: string;
  glyph: Glyph;
  dash: number[] | null;
  lane: number;
  laneLabel: string | null;
  coupling: Coupling;
  /** 0..1 pull used by the world layout. Proximity is an encoding too. */
  attraction: number;
}

export interface NodeStyle {
  fill: string;
  halo: number;
  /** True when the halo encodes something bad (errors), so it is drawn in the danger colour. */
  haloDanger: boolean;
  column: number | null;
  /** The value of the column dimension, so the renderer can draw a region per group. */
  group: string | null;
}

export interface LegendSwatch {
  value: string;
  /** A colour, when the channel is colour-like. */
  color?: string;
  /** A short textual rendering of the non-colour visual, e.g. "▲" or "rigid". */
  mark?: string;
}

export interface LegendGroup {
  channel: ChannelName;
  field: string;
  kind: 'dimension' | 'measure';
  summary: string;
  swatches: LegendSwatch[];
  /** Set when a binding was refused, with the reason. */
  warning?: string;
}

export interface StyledScene {
  edges: Map<string, EdgeStyle>;
  nodes: Map<string, NodeStyle>;
  /** Set when `distance` is bound to a dimension: nodes sharing its value cluster. */
  clusterBy: string | null;
  legend: LegendGroup[];
  /** Dimensions whose values were seen, for the UI to offer as filters. */
  issues: string[];
}

/**
 * Categorical palette.
 *
 * Ordered so the first few stay distinguishable under the common forms of
 * colour-vision deficiency, and legible on both a light and a dark ground.
 *
 * Red is absent and amber comes late on purpose: those two are *semantic* here.
 * Red means an error and amber means degraded, and a category that borrows one
 * of them makes a healthy region look like an incident. Two encodings cannot
 * share a colour any more than they can share a channel.
 */
export const CATEGORICAL = [
  '#3b82f6',
  '#10b981',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#8b5cf6',
  '#14b8a6',
  '#eab308',
  '#f97316',
];

const GLYPHS: Glyph[] = ['dot', 'ring', 'square', 'triangle', 'bar', 'diamond'];
const DASHES: (number[] | null)[] = [null, [7, 5], [2, 4], [12, 4, 2, 4], [1, 5]];
const GLYPH_MARK: Record<Glyph, string> = {
  dot: '●',
  ring: '◍',
  square: '■',
  triangle: '▲',
  bar: '▬',
  diamond: '◆',
};

/**
 * Stable value ordering, so a category keeps its colour across re-projections.
 * An explicit `order` on the binding comes first; anything unlisted follows,
 * sorted, so a partial order is still a complete one.
 */
function domainOf(values: Iterable<string>, order?: string[]): string[] {
  const all = [...new Set(values)];
  if (!order?.length) return all.sort();
  const rank = new Map(order.map((v, i) => [v, i]));
  return all.sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

function measureOf(edge: SceneEdge, field: string): number {
  const m = edge.metrics as unknown as Record<string, number>;
  return m[field] ?? 0;
}

function dimOf(edge: SceneEdge, field: string): string | undefined {
  return edge.dims[field] ?? (edge.spans[field]?.length === 1 ? edge.spans[field]![0] : undefined);
}

function nodeDimOf(node: SceneNode, field: string): string | undefined {
  return node.key[field] ?? (node.spans[field]?.length === 1 ? node.spans[field]![0] : undefined);
}

/**
 * Resolve every binding into concrete visual values.
 *
 * Unbound channels fall back to the v0.1 encoding, so a scene with no spec at
 * all still draws the way it always did.
 */
export function styleScene(
  scene: Scene,
  spec: ViewSpec,
  theme: Theme,
  enc: EncodingOptions = defaultEncoding,
): StyledScene {
  const bindings = (spec.channels ?? {}) as Partial<Record<ChannelName, ChannelBinding>>;
  const legend: LegendGroup[] = [];
  const issues: string[] = [];

  const rpsDom = rpsDomain(scene.edges.map((e) => e.metrics.rps));

  // --- helpers -------------------------------------------------------------

  const categorical = (
    channel: ChannelName,
    values: string[],
    binding: ChannelBinding,
  ): { index: Map<string, number>; ok: boolean } => {
    const def = CHANNELS[channel];
    const index = new Map(values.map((v, i) => [v, i]));
    if (def.maxCardinality && values.length > def.maxCardinality) {
      const warning = `${values.length} distinct values of "${binding.field}" is too many for ${channel} (max ${def.maxCardinality}); left at the default`;
      issues.push(warning);
      legend.push({ channel, field: binding.field, kind: 'dimension', summary: def.summary, swatches: [], warning });
      return { index, ok: false };
    }
    return { index, ok: true };
  };

  const measureNorm = (value: number, domain: { min: number; max: number }, binding: ChannelBinding): number => {
    const scale = binding.scale ?? (binding.field === 'share' || binding.field === 'errorRate' ? 'linear' : 'log');
    let t: number;
    if (scale === 'linear') t = domain.max > domain.min ? (value - domain.min) / (domain.max - domain.min) : 1;
    else if (scale === 'sqrt') t = domain.max > 0 ? Math.sqrt(Math.max(value, 0) / domain.max) : 0;
    else t = logNorm(value, domain.min, domain.max);
    return binding.invert ? 1 - t : t;
  };

  const measureDomain = (field: string): { min: number; max: number } => {
    if (field === 'share' || field === 'errorRate') return { min: 0, max: 1 };
    const values = scene.edges.map((e) => measureOf(e, field)).filter((v) => v > 0);
    if (!values.length) return { min: 0, max: 1 };
    const max = Math.max(...values);
    return { min: Math.min(Math.min(...values), max / 1000), max };
  };

  // --- edge channels -------------------------------------------------------

  const edgeStyles = new Map<string, EdgeStyle>();

  const hueBinding = bindings.hue;
  const hueDomain = hueBinding && !isMeasure(hueBinding.field)
    ? domainOf(scene.edges.map((e) => dimOf(e, hueBinding.field) ?? '—'))
    : [];
  const hueIdx = hueBinding ? categorical('hue', hueDomain, hueBinding) : null;

  const glyphBinding = bindings.glyph;
  const glyphDomain = glyphBinding ? domainOf(scene.edges.map((e) => dimOf(e, glyphBinding.field) ?? '—')) : [];
  const glyphIdx = glyphBinding ? categorical('glyph', glyphDomain, glyphBinding) : null;

  const dashBinding = bindings.dash;
  const dashDomain = dashBinding ? domainOf(scene.edges.map((e) => dimOf(e, dashBinding.field) ?? '—')) : [];
  const dashIdx = dashBinding ? categorical('dash', dashDomain, dashBinding) : null;

  const laneBinding = bindings.lane;
  const laneDomain = laneBinding ? domainOf(scene.edges.map((e) => dimOf(e, laneBinding.field) ?? '—'), laneBinding.order) : [];
  const laneIdx = laneBinding ? categorical('lane', laneDomain, laneBinding) : null;

  const distanceBinding = bindings.distance;
  const distanceIsMeasure = Boolean(distanceBinding && isMeasure(distanceBinding.field));
  const distanceDomain = distanceBinding && distanceIsMeasure ? measureDomain(distanceBinding.field) : { min: 0, max: 1 };
  const clusterBy = distanceBinding && !distanceIsMeasure ? distanceBinding.field : null;

  const couplingBinding = bindings.coupling;
  const couplingDomain = couplingBinding
    ? domainOf(scene.edges.map((e) => dimOf(e, couplingBinding.field) ?? '—'))
    : [];

  const densityBinding = bindings.density;
  const densityDomain = densityBinding ? measureDomain(densityBinding.field) : rpsDom;
  const speedBinding = bindings.speed;
  const speedDomain = speedBinding ? measureDomain(speedBinding.field) : { min: 0, max: 1 };
  const radiusBinding = bindings.radius;
  const radiusDomain = radiusBinding ? measureDomain(radiusBinding.field) : { min: 0, max: 1 };

  const palette = (binding: ChannelBinding | undefined): string[] => binding?.palette ?? CATEGORICAL;

  for (const edge of scene.edges) {
    // density
    let density: number;
    if (densityBinding) {
      const t = contrast(measureNorm(measureOf(edge, densityBinding.field), densityDomain, densityBinding), enc.densityCurve);
      density = measureOf(edge, densityBinding.field) <= 0 ? 0 : enc.minEmitPerSecond + t * (enc.maxEmitPerSecond - enc.minEmitPerSecond);
    } else {
      density = emissionRate(edge.metrics.rps, rpsDom, enc);
    }

    // speed
    let speed: number;
    if (speedBinding) {
      const t = measureNorm(measureOf(edge, speedBinding.field), speedDomain, speedBinding);
      speed = enc.maxSpeedPxPerSecond - t * (enc.maxSpeedPxPerSecond - enc.minSpeedPxPerSecond);
    } else {
      speed = particleSpeed(edge.metrics.latencyMs, enc);
    }

    // radius
    let radius: number;
    if (radiusBinding) {
      const t = measureNorm(measureOf(edge, radiusBinding.field), radiusDomain, { ...radiusBinding, scale: radiusBinding.scale ?? 'sqrt' });
      radius = enc.minRadiusPx + t * (enc.maxRadiusPx - enc.minRadiusPx);
    } else {
      radius = particleRadius(edge.metrics.bytes, enc);
    }

    // hue
    let hue = theme.flow[edge.kind];
    if (hueBinding && hueIdx?.ok) {
      const v = dimOf(edge, hueBinding.field) ?? '—';
      const p = palette(hueBinding);
      hue = bindOverride(hueBinding, v) ?? p[(hueIdx.index.get(v) ?? 0) % p.length]!;
    }

    // glyph
    let glyph: Glyph = 'dot';
    if (glyphBinding && glyphIdx?.ok) {
      const v = dimOf(edge, glyphBinding.field) ?? '—';
      glyph = (bindOverride(glyphBinding, v) as Glyph) ?? GLYPHS[(glyphIdx.index.get(v) ?? 0) % GLYPHS.length]!;
    }

    // dash
    let dash: number[] | null = edge.kind === 'retry' || edge.kind === 'challenge' ? [5, 5] : null;
    if (dashBinding && dashIdx?.ok) {
      const v = dimOf(edge, dashBinding.field) ?? '—';
      dash = DASHES[(dashIdx.index.get(v) ?? 0) % DASHES.length] ?? null;
    }

    // lane
    let lane = 0;
    let laneLabel: string | null = null;
    if (laneBinding && laneIdx?.ok) {
      const v = dimOf(edge, laneBinding.field) ?? '—';
      lane = laneIdx.index.get(v) ?? 0;
      laneLabel = v;
    }

    // coupling
    let coupling: Coupling = 'plain';
    if (couplingBinding) {
      const v = dimOf(edge, couplingBinding.field) ?? '—';
      coupling = couplingFor(v, couplingBinding);
    }

    // Unbound, distance pulls on share: the fraction of the caller's traffic
    // that goes down this edge. Two services that send most of what they have
    // to each other are coupled, whatever the absolute rps.
    const strength = distanceBinding?.strength ?? 1;
    const attraction = clamp(
      (distanceBinding && distanceIsMeasure
        ? measureNorm(measureOf(edge, distanceBinding.field), distanceDomain, distanceBinding)
        : clamp(edge.metrics.share ?? 0.3, 0, 1)) * strength,
      0,
      2,
    );

    edgeStyles.set(edge.id, { density, speed, radius, hue, glyph, dash, lane, laneLabel, coupling, attraction });
  }

  // --- node channels -------------------------------------------------------

  const nodeStyles = new Map<string, NodeStyle>();
  const fillBinding = bindings.nodeFill;
  const fillDomain = fillBinding ? domainOf(scene.nodes.map((n) => nodeDimOf(n, fillBinding.field) ?? '—')) : [];
  const fillIdx = fillBinding ? categorical('nodeFill', fillDomain, fillBinding) : null;

  const columnBinding = bindings.column;
  const columnDomain = columnBinding ? domainOf(scene.nodes.map((n) => nodeDimOf(n, columnBinding.field) ?? '—'), columnBinding.order) : [];
  const columnIdx = columnBinding ? categorical('column', columnDomain, columnBinding) : null;

  const haloBinding = bindings.halo;
  // A halo can size by traffic through the node or by any numeric fact on it
  // (instances, connections, ...). Node facts win when the name matches one.
  const haloValue = (n: SceneNode): number => {
    const f = haloBinding?.field ?? 'inboundRps';
    if (f === 'outboundRps') return n.outboundRps;
    if (f === 'inboundRps' || f === 'rps') return n.inboundRps;
    return n.attrs[f] ?? 0;
  };
  const haloValues = scene.nodes.map(haloValue);
  const haloMax = Math.max(1, ...haloValues);

  for (const node of scene.nodes) {
    let fill = theme.node[node.kind];
    if (fillBinding && fillIdx?.ok) {
      const v = nodeDimOf(node, fillBinding.field) ?? '—';
      const p = palette(fillBinding);
      fill = mix(p[(fillIdx.index.get(v) ?? 0) % p.length]!, theme.name === 'dark' ? 0.72 : 0.84, theme);
    }
    let halo = 0;
    const haloDanger = /error|fail|5xx/i.test(haloBinding?.field ?? '');
    if (haloBinding) {
      const v = haloValue(node);
      // Rates are 0..1 and read linearly; counts span decades and read on a log.
      const t = haloDanger || haloBinding.field === 'share'
        ? clamp(v / Math.max(haloMax, 0.0001), 0, 1)
        : v > 0 ? logNorm(v, Math.max(haloMax / 1000, 0.001), haloMax) : 0;
      // A rate halo below a small fraction of the worst case is noise: every
      // box has *some* errors, and a ring on all of them says nothing.
      halo = v > 0 && !(haloDanger && t < 0.12) ? 3 + t * 13 : 0;
    }
    const groupValue = columnBinding ? (nodeDimOf(node, columnBinding.field) ?? null) : null;
    const column =
      columnBinding && columnIdx?.ok
        ? (columnIdx.index.get(nodeDimOf(node, columnBinding.field) ?? '—') ?? null)
        : null;
    nodeStyles.set(node.id, { fill, halo, haloDanger, column, group: groupValue });
  }

  // --- legend --------------------------------------------------------------

  if (hueBinding && hueIdx?.ok) {
    const p = palette(hueBinding);
    legend.push({
      channel: 'hue',
      field: hueBinding.field,
      kind: 'dimension',
      summary: CHANNELS.hue.summary,
      swatches: hueDomain.map((v, i) => ({ value: v, color: bindOverride(hueBinding, v) ?? p[i % p.length]! })),
    });
  }
  if (glyphBinding && glyphIdx?.ok) {
    legend.push({
      channel: 'glyph',
      field: glyphBinding.field,
      kind: 'dimension',
      summary: CHANNELS.glyph.summary,
      swatches: glyphDomain.map((v, i) => ({ value: v, mark: GLYPH_MARK[GLYPHS[i % GLYPHS.length]!] })),
    });
  }
  if (dashBinding && dashIdx?.ok) {
    legend.push({
      channel: 'dash',
      field: dashBinding.field,
      kind: 'dimension',
      summary: CHANNELS.dash.summary,
      swatches: dashDomain.map((v, i) => ({ value: v, mark: DASHES[i % DASHES.length] ? '– –' : '——' })),
    });
  }
  if (laneBinding && laneIdx?.ok) {
    legend.push({
      channel: 'lane',
      field: laneBinding.field,
      kind: 'dimension',
      summary: CHANNELS.lane.summary,
      swatches: laneDomain.map((v, i) => ({ value: v, mark: `lane ${i + 1}` })),
    });
  }
  if (couplingBinding) {
    legend.push({
      channel: 'coupling',
      field: couplingBinding.field,
      kind: 'dimension',
      summary: CHANNELS.coupling.summary,
      swatches: couplingDomain.map((v) => ({ value: v, mark: couplingFor(v, couplingBinding) })),
    });
  }
  if (distanceBinding) {
    legend.push({
      channel: 'distance',
      field: distanceBinding.field,
      kind: distanceIsMeasure ? 'measure' : 'dimension',
      summary: !distanceIsMeasure
        ? 'things sharing this value cluster together'
        : distanceBinding.field === 'share'
          ? 'coupled services sit together: the more of its traffic a caller sends down an edge, the shorter it is'
          : 'heavier flows pull their endpoints together',
      swatches: [],
    });
  }
  for (const [name, binding] of [
    ['density', densityBinding],
    ['speed', speedBinding],
    ['radius', radiusBinding],
    ['halo', haloBinding],
  ] as const) {
    if (!binding) continue;
    legend.push({ channel: name, field: binding.field, kind: 'measure', summary: CHANNELS[name].summary, swatches: [] });
  }
  if (fillBinding && fillIdx?.ok) {
    const p = palette(fillBinding);
    legend.push({
      channel: 'nodeFill',
      field: fillBinding.field,
      kind: 'dimension',
      summary: CHANNELS.nodeFill.summary,
      swatches: fillDomain.map((v, i) => ({ value: v, color: p[i % p.length]! })),
    });
  }
  if (columnBinding && columnIdx?.ok) {
    legend.push({
      channel: 'column',
      field: columnBinding.field,
      kind: 'dimension',
      summary: CHANNELS.column.summary,
      swatches: columnDomain.map((v, i) => ({ value: v, mark: `col ${i + 1}` })),
    });
  }

  return { edges: edgeStyles, nodes: nodeStyles, clusterBy, legend, issues };
}

function bindOverride(binding: ChannelBinding, value: string): string | undefined {
  return binding.map?.[value];
}

/**
 * Failure semantics are a first-party concept, not just another category, so
 * the mapping recognises the vocabulary people actually use.
 */
export function couplingFor(value: string, binding?: ChannelBinding): Coupling {
  const override = binding?.map?.[value];
  if (override === 'rigid' || override === 'breakaway' || override === 'plain') return override;
  const v = value.toLowerCase().replace(/[\s_]/g, '-');
  if (v.includes('fail-closed') || v === 'closed' || v === 'hard' || v === 'required' || v === 'critical') return 'rigid';
  if (v.includes('fail-open') || v === 'open' || v === 'soft' || v === 'optional' || v === 'best-effort') return 'breakaway';
  return 'plain';
}

/** Blend a palette colour toward the theme surface, so node fills stay backgrounds. */
function mix(hex: string, toward: number, theme: Theme): string {
  const base = hexToRgb(hex);
  const ground = hexToRgb(theme.surface);
  const r = Math.round(base.r + (ground.r - base.r) * toward);
  const g = Math.round(base.g + (ground.g - base.g) * toward);
  const b = Math.round(base.b + (ground.b - base.b) * toward);
  return `rgb(${r}, ${g}, ${b})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = Number.parseInt(n, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
