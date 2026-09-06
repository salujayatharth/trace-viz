/**
 * The visual encoding lives here, on its own, so it can be reasoned about and
 * tested without a canvas.
 *
 * Two rules drive every choice below:
 *
 * 1. Throughput spans orders of magnitude, so it is log-scaled. Linear scaling
 *    makes a 50k rps edge solid white next to a 5 rps edge that looks empty.
 * 2. Speed is a poor quantitative channel - people read "fast vs slow" but not
 *    "3x vs 5x" - so speed carries latency (where ordinal is enough) and never
 *    throughput (where you want to compare magnitudes). Numbers on the edge do
 *    the quantitative work; the animation only tells you where to look.
 */

export interface EncodingOptions {
  /** Particles emitted per second at the busiest edge. */
  maxEmitPerSecond: number;
  /** Particles emitted per second at the quietest non-zero edge. */
  minEmitPerSecond: number;
  /** Hard cap on live particles per edge, to keep the frame budget. */
  maxParticlesPerEdge: number;
  /**
   * Exponent applied to the normalised throughput before it becomes density
   * and conduit width. 1 is faithful to the log scale; above 1 the quiet
   * edges thin out and only the genuinely hot ones fill up, which is what
   * makes the difference between 50 rps and 5,000 rps look like a hundred
   * times rather than a few notches on a dial.
   */
  densityCurve: number;
  /** Pixels per second for the fastest (lowest-latency) edge. */
  maxSpeedPxPerSecond: number;
  /** Pixels per second for the slowest edge. */
  minSpeedPxPerSecond: number;
  /** Latency at or below which an edge travels at max speed. */
  fastLatencyMs: number;
  /** Latency at or above which an edge travels at min speed. */
  slowLatencyMs: number;
  /** Particle radius in px at `bytesReference`. */
  baseRadiusPx: number;
  minRadiusPx: number;
  maxRadiusPx: number;
  bytesReference: number;
}

/**
 * Tuned so you can follow a single particle from one box into the next.
 *
 * An earlier, faster set looked impressive and told you nothing: at 260px/s and
 * 55 particles a second the streams read as texture, and texture cannot be
 * counted. Slower and sparser means each request is a thing you can watch
 * arrive, which is the whole reason for drawing them individually rather than
 * as a number on a line.
 */
export const defaultEncoding: EncodingOptions = {
  maxEmitPerSecond: 26,
  minEmitPerSecond: 0.3,
  maxParticlesPerEdge: 120,
  densityCurve: 1.7,
  maxSpeedPxPerSecond: 108,
  minSpeedPxPerSecond: 14,
  fastLatencyMs: 2,
  slowLatencyMs: 800,
  baseRadiusPx: 2.3,
  minRadiusPx: 1.3,
  maxRadiusPx: 5.6,
  bytesReference: 1024,
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Map a value onto 0..1 across a log domain. `log1p` keeps zero meaningful
 * (0 rps really is nothing, not negative infinity).
 */
export function logNorm(value: number, min: number, max: number): number {
  if (!(max > min)) return value > 0 ? 1 : 0;
  const v = Math.log1p(Math.max(0, value));
  const lo = Math.log1p(Math.max(0, min));
  const hi = Math.log1p(Math.max(0, max));
  if (!(hi > lo)) return 1;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/** rps -> particles emitted per second on this edge. */
export function emissionRate(
  rps: number,
  domain: { min: number; max: number },
  opts: EncodingOptions = defaultEncoding,
): number {
  if (rps <= 0) return 0;
  const t = contrast(logNorm(rps, domain.min, domain.max), opts.densityCurve);
  return opts.minEmitPerSecond + t * (opts.maxEmitPerSecond - opts.minEmitPerSecond);
}

/** Push a 0..1 value along the density curve. */
export function contrast(t: number, curve: number): number {
  return Math.pow(clamp(t, 0, 1), Math.max(0.2, curve));
}

/**
 * latency -> px/second. Inverse and log-scaled: a slow-crawling stream *is* a
 * slow hop, which is the intuition we want people to arrive at without a key.
 */
export function particleSpeed(
  latencyMs: number,
  opts: EncodingOptions = defaultEncoding,
): number {
  const t = logNorm(
    clamp(latencyMs, opts.fastLatencyMs, opts.slowLatencyMs),
    opts.fastLatencyMs,
    opts.slowLatencyMs,
  );
  return opts.maxSpeedPxPerSecond - t * (opts.maxSpeedPxPerSecond - opts.minSpeedPxPerSecond);
}

/** bytes -> particle radius, sqrt-scaled because area reads as quantity. */
export function particleRadius(
  bytes: number,
  opts: EncodingOptions = defaultEncoding,
): number {
  const r = opts.baseRadiusPx * Math.sqrt(Math.max(bytes, 1) / opts.bytesReference);
  return clamp(r, opts.minRadiusPx, opts.maxRadiusPx);
}

/** Edge line width. Static-mode fallback also uses this to encode rps. */
export function edgeWidth(
  rps: number,
  domain: { min: number; max: number },
  { min = 0.8, max = 9, curve = defaultEncoding.densityCurve }: { min?: number; max?: number; curve?: number } = {},
): number {
  if (rps <= 0) return min * 0.6;
  return min + contrast(logNorm(rps, domain.min, domain.max), curve) * (max - min);
}

/**
 * The log domain used for density.
 *
 * The floor is pinned three decades below the busiest edge rather than at the
 * quietest one. Normalising to the observed minimum is degenerate: in a graph
 * where every edge carries 2.5k-5k rps, the quietest edge would render as empty
 * despite being busy. Three decades is enough separation to read, and it makes
 * two different graphs roughly comparable.
 */
export function rpsDomain(values: number[]): { min: number; max: number } {
  const positive = values.filter((v) => v > 0);
  if (!positive.length) return { min: 0, max: 1 };
  const max = Math.max(...positive);
  return { min: Math.min(Math.min(...positive), max / 1000), max };
}

/** 12345 -> "12.3k". Used on edge labels and the summary bar. */
export function formatRps(rps: number): string {
  if (rps === 0) return '0';
  if (rps >= 1_000_000) return `${(rps / 1_000_000).toFixed(rps >= 10_000_000 ? 0 : 1)}M`;
  if (rps >= 1_000) return `${(rps / 1_000).toFixed(rps >= 10_000 ? 0 : 1)}k`;
  if (rps >= 10) return rps.toFixed(0);
  return rps.toFixed(rps < 1 ? 2 : 1);
}

export function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(1)}ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${bytes.toFixed(0)}B`;
}
