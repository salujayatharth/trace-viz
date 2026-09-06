import type { EdgePath } from './geometry.js';
import {
  defaultEncoding,
  emissionRate,
  particleRadius,
  particleSpeed,
  type EncodingOptions,
} from './scales.js';

export interface Particle {
  /** Position along the path, 0..1. */
  t: number;
  /** Pixels per second. */
  speed: number;
  radius: number;
  error: boolean;
  /** Small lateral jitter so the stream reads as a stream, not a queue. */
  wobble: number;
}

/**
 * One edge's particle stream.
 *
 * Emission is accumulator-based rather than "one particle per frame", so the
 * density on screen tracks rps rather than the viewer's refresh rate. A 144Hz
 * monitor must not make the system look busier than a 60Hz one.
 */
/** The minimum an edge must expose to carry a stream. */
export interface StreamEdge {
  id: string;
  metrics: { rps: number; latencyMs: number; errorRate: number; bytes: number };
}

export class EdgeStream {
  readonly edge: StreamEdge;
  particles: Particle[] = [];
  private accumulator = 0;
  private emitPerSecond = 0;
  private speedPxPerSecond = 0;
  private radius = 2;
  private rand: () => number;
  private stopped = false;
  private overrideErrorRate: number | null = null;
  private spreadPx = 4.2;
  private phased = false;

  constructor(edge: StreamEdge, rand: () => number = Math.random) {
    this.edge = edge;
    this.rand = rand;
  }

  /** Recompute the encoding. Call when metrics or the rps domain changes. */
  configure(domain: { min: number; max: number }, enc: EncodingOptions = defaultEncoding): void {
    this.emitPerSecond = this.stopped ? 0 : emissionRate(this.edge.metrics.rps, domain, enc);
    this.speedPxPerSecond = particleSpeed(this.edge.metrics.latencyMs, enc);
    this.radius = particleRadius(this.edge.metrics.bytes, enc);
  }

  /**
   * Set the resolved channel values directly. The dimensional path computes
   * density, speed and radius from arbitrary bindings, so the stream must not
   * re-derive them from rps/latency.
   */
  configureDirect(density: number, speed: number, radius: number, errorRate: number): void {
    this.emitPerSecond = this.stopped ? 0 : density;
    this.speedPxPerSecond = speed;
    this.radius = radius;
    this.overrideErrorRate = errorRate;
  }

  /**
   * How this stream shares its conduit with the other lanes on the same edge.
   *
   * `spread` is how far particles scatter across the conduit, and `phase` is
   * where in the emission cycle this lane starts. Two lanes drawn on the same
   * path with the same phase would emit in lockstep and read as one alternating
   * chain; offset phases and a wide scatter make them mix, which is what you
   * want when the split is small enough to overlay - blue and green in the same
   * pipe rather than two tidy parallel dotted lines.
   */
  setLane(spread: number, phase = 0): void {
    this.spreadPx = spread;
    if (!this.phased) {
      this.accumulator = phase;
      this.phased = true;
    }
  }

  /** Cut emission without clearing what is already in flight - a severed edge drains. */
  stopEmitting(): void {
    this.stopped = true;
    this.emitPerSecond = 0;
  }

  resumeEmitting(): void {
    this.stopped = false;
  }

  get emitRate(): number {
    return this.emitPerSecond;
  }

  get speed(): number {
    return this.speedPxPerSecond;
  }

  /**
   * Advance by `dt` seconds along `path`, at `rate` speed multiplier.
   * Returns the number of particles that completed the trip, which the caller
   * can use for a delivered-requests counter.
   */
  step(dt: number, path: EdgePath, enc: EncodingOptions = defaultEncoding, rate = 1): number {
    const errorRate = this.overrideErrorRate ?? this.edge.metrics.errorRate;

    if (this.emitPerSecond > 0) {
      this.accumulator += this.emitPerSecond * dt * rate;
      // Cap the backlog: a long tab-away must not dump 10k particles at once.
      const budget = Math.min(
        Math.floor(this.accumulator),
        Math.max(0, enc.maxParticlesPerEdge - this.particles.length),
        120,
      );
      this.accumulator -= Math.floor(this.accumulator);
      for (let i = 0; i < budget; i++) {
        this.particles.push({
          // Spread new arrivals across the frame's worth of travel so they do
          // not emerge in visible clumps.
          t: (-i / Math.max(budget, 1)) * (this.speedPxPerSecond * dt) / path.length,
          speed: this.speedPxPerSecond * (0.88 + this.rand() * 0.24),
          radius: this.radius * (0.85 + this.rand() * 0.3),
          error: this.rand() < errorRate,
          wobble: (this.rand() - 0.5) * this.spreadPx,
        });
      }
    }

    let delivered = 0;
    const kept: Particle[] = [];
    for (const p of this.particles) {
      p.t += (p.speed * dt * rate) / path.length;
      if (p.t >= 1) {
        delivered++;
        continue;
      }
      kept.push(p);
    }
    this.particles = kept;
    return delivered;
  }

  clear(): void {
    this.particles.length = 0;
    this.accumulator = 0;
    this.stopped = false;
    this.phased = false;
  }
}

/** Deterministic PRNG (mulberry32) - lets tests and screenshots reproduce. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
