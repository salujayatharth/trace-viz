import type { Coupling, EdgeStyle } from './channels.js';
import type { Scene } from './scene.js';

/**
 * Blast radius.
 *
 * `fail-closed` and `fail-open` are not decoration on a dependency, they are
 * the dependency's contract: they say what happens to the caller when the
 * callee dies. So they get a first-class model, not just a colour.
 *
 * An edge `a -> b` means a calls b:
 *
 * - **rigid** (fail-closed): if b is dead, a is dead. Death travels backwards
 *   up the call graph, and this is the propagation people underestimate.
 * - **breakaway** (fail-open): if b is dead, a is *degraded* and still serving.
 *   The link parts, the caller survives. A fail-open dependency is a firebreak,
 *   and it is the only thing that stops the front.
 * - **plain** (unknown): treated as breakaway, because assuming an undeclared
 *   dependency is load-bearing would turn every diagram black on the first kill
 *   and teach nothing. The UI flags these rather than guessing loudly.
 */
export type NodeHealth = 'ok' | 'degraded' | 'dead';
export type EdgeHealth = 'flowing' | 'strained' | 'severed';

export interface FailureResult {
  health: Map<string, NodeHealth>;
  edgeHealth: Map<string, EdgeHealth>;
  /** Hops from the nearest killed node, following the propagation. Drives the wavefront timing. */
  hop: Map<string, number>;
  /** Edges where a breakaway coupling stopped the front. */
  firebreaks: string[];
  deadRps: number;
  degradedRps: number;
  totalRps: number;
}

export function propagateFailure(
  scene: Scene,
  killed: string[],
  styles: Map<string, EdgeStyle>,
  couplingBound: boolean,
): FailureResult {
  const health = new Map<string, NodeHealth>();
  const hop = new Map<string, number>();
  for (const n of scene.nodes) health.set(n.id, 'ok');

  const alive = new Set(scene.nodes.map((n) => n.id));
  for (const id of killed) {
    if (!alive.has(id)) continue;
    health.set(id, 'dead');
    hop.set(id, 0);
  }

  const couplingOf = (edgeId: string): Coupling => {
    if (!couplingBound) return 'breakaway';
    const c = styles.get(edgeId)?.coupling ?? 'plain';
    return c === 'plain' ? 'breakaway' : c;
  };

  // Fixpoint, so cycles terminate. Bounded by node count.
  for (let pass = 0; pass < scene.nodes.length + 1; pass++) {
    let changed = false;
    for (const edge of scene.edges) {
      if (edge.from === edge.to) continue;
      const callee = health.get(edge.to) ?? 'ok';
      const caller = health.get(edge.from) ?? 'ok';
      if (caller === 'dead') continue;
      const coupling = couplingOf(edge.id);

      if (coupling === 'rigid' && callee === 'dead') {
        health.set(edge.from, 'dead');
        hop.set(edge.from, Math.min(hop.get(edge.from) ?? Infinity, (hop.get(edge.to) ?? 0) + 1));
        changed = true;
      } else if (
        caller === 'ok' &&
        ((coupling === 'breakaway' && callee !== 'ok') || (coupling === 'rigid' && callee === 'degraded'))
      ) {
        health.set(edge.from, 'degraded');
        hop.set(edge.from, Math.min(hop.get(edge.from) ?? Infinity, (hop.get(edge.to) ?? 0) + 1));
        changed = true;
      }
    }
    if (!changed) break;
  }

  const edgeHealth = new Map<string, EdgeHealth>();
  const firebreaks: string[] = [];
  let deadRps = 0;
  let degradedRps = 0;
  let totalRps = 0;

  for (const edge of scene.edges) {
    totalRps += edge.metrics.rps;
    const to = health.get(edge.to) ?? 'ok';
    const from = health.get(edge.from) ?? 'ok';
    if (to === 'dead' || from === 'dead') {
      edgeHealth.set(edge.id, 'severed');
      deadRps += edge.metrics.rps;
      if (to === 'dead' && from !== 'dead' && couplingOf(edge.id) === 'breakaway') firebreaks.push(edge.id);
    } else if (to === 'degraded' || from === 'degraded') {
      edgeHealth.set(edge.id, 'strained');
      degradedRps += edge.metrics.rps;
    } else {
      edgeHealth.set(edge.id, 'flowing');
    }
  }

  return { health, edgeHealth, hop, firebreaks, deadRps, degradedRps, totalRps };
}

export function emptyFailure(scene: Scene): FailureResult {
  const health = new Map<string, NodeHealth>();
  for (const n of scene.nodes) health.set(n.id, 'ok');
  const edgeHealth = new Map<string, EdgeHealth>();
  let totalRps = 0;
  for (const e of scene.edges) {
    edgeHealth.set(e.id, 'flowing');
    totalRps += e.metrics.rps;
  }
  return { health, edgeHealth, hop: new Map(), firebreaks: [], deadRps: 0, degradedRps: 0, totalRps };
}
