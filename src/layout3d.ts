import { defaultTier } from './components.js';
import { mulberry32 } from './particles.js';
import type { Scene, SceneNode } from './scene.js';

/**
 * World layout: a real three-dimensional arrangement, not a stack of flat rows.
 *
 * Tiers are planes on the vertical axis - services on one, datastores below -
 * and each plane is a two-dimensional field the nodes are free to move around
 * in. That second in-plane axis is what makes clustering legible: services that
 * call each other constantly end up genuinely adjacent, and you can rotate the
 * camera to see round a cluster instead of squinting at crossing lines.
 *
 * The projection is **orthographic**, deliberately. Perspective would make far
 * things smaller, and size already means something here - it is the instance
 * count. Two encodings cannot share one channel.
 */

export interface WorldNode {
  id: string;
  /** World coordinates. y is up; tier 0 sits highest. */
  x: number;
  y: number;
  z: number;
  tier: number;
  w: number;
  h: number;
}

export interface Camera {
  yaw: number;
  tilt: number;
  /** Horizontal world-to-pixel scale. */
  scale: number;
  /**
   * Vertical scale, allowed to differ from the horizontal one.
   *
   * Bodies are drawn at a fixed pixel size, so stretching the *arrangement* to
   * fill a wide canvas distorts nothing that carries meaning - and a uniform
   * scale would otherwise leave a third of the width empty whenever the tier
   * stack is the binding constraint. Bounded, so clustering stays readable.
   */
  scaleY: number;
  cx: number;
  cy: number;
}

export interface Projected {
  x: number;
  y: number;
  depth: number;
}

export function project3(p: { x: number; y: number; z: number }, cam: Camera): Projected {
  const cos = Math.cos(cam.yaw);
  const sin = Math.sin(cam.yaw);
  const rx = p.x * cos - p.z * sin;
  const depth = p.x * sin + p.z * cos;
  return {
    x: cam.cx + rx * cam.scale,
    y: cam.cy - p.y * cam.scaleY + depth * cam.scaleY * cam.tilt,
    depth,
  };
}

export interface WorldLayoutOptions {
  /** Which plane each node sits on. */
  tierOf: (node: SceneNode) => number;
  /** 0..1 pull between two connected nodes. */
  attractionOf: (edgeId: string) => number;
  /** Optional categorical grouping: nodes sharing a value are pulled together. */
  groupOf?: (node: SceneNode) => string | undefined;
  /** Vertical separation between planes, in world units. */
  tierGap: number;
  nodeWidth: number;
  nodeHeight: number;
  iterations: number;
  seed: number;
  /** Must match the camera's tilt: separation is measured in projected space. */
  tilt: number;
  /** Minimum projected gap between two bodies on the same plane, in world units. */
  gap: number;
  /** Screen size of each body, so separation can be done in pixels where it matters. */
  sizeOf?: (node: SceneNode) => { w: number; h: number };
  /** Canvas the world has to fit. Given it, separation runs against the real camera. */
  viewport?: { width: number; height: number; yaw: number };
  /** Pixels to keep clear around a body, including its label block. */
  labelSpace: number;
}

export const defaultWorldLayout: WorldLayoutOptions = {
  tierOf: defaultTier,
  attractionOf: () => 0.5,
  tierGap: 1.4,
  nodeWidth: 62,
  nodeHeight: 52,
  iterations: 320,
  seed: 7,
  tilt: 0.3,
  gap: 1.2,
  labelSpace: 26,
};

/**
 * Place nodes in the world.
 *
 * A short deterministic relaxation, not a live force simulation: same scene in,
 * same world out, so two screenshots are comparable and a re-render does not
 * shuffle everything the user had just learned to read.
 */
export function layoutWorld(
  scene: Scene,
  options: Partial<WorldLayoutOptions> = {},
): Map<string, WorldNode> {
  const opt = { ...defaultWorldLayout, ...options };
  const rand = mulberry32(opt.seed);
  const nodes = scene.nodes;
  if (!nodes.length) return new Map();

  const tiers = nodes.map((n) => opt.tierOf(n));
  const maxTier = Math.max(...tiers, 0);

  // Seed each plane on a ring, which starts things spread out and keeps the
  // relaxation from having to undo a pile in the middle.
  const perTier = new Map<number, number>();
  for (const t of tiers) perTier.set(t, (perTier.get(t) ?? 0) + 1);
  const seenInTier = new Map<number, number>();

  const px: number[] = [];
  const pz: number[] = [];
  for (const [i, node] of nodes.entries()) {
    const tier = tiers[i]!;
    const idx = seenInTier.get(tier) ?? 0;
    seenInTier.set(tier, idx + 1);
    const count = perTier.get(tier) ?? 1;
    const angle = (idx / count) * Math.PI * 2 + tier * 0.7;
    const radius = 0.55 + (rand() - 0.5) * 0.12;
    px.push(Math.cos(angle) * radius);
    pz.push(Math.sin(angle) * radius);
    void node;
  }

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links: { a: number; b: number; w: number }[] = [];
  for (const e of scene.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push({ a, b, w: opt.attractionOf(e.id) });
  }

  // Categorical grouping is a second kind of link: same value, fixed pull.
  if (opt.groupOf) {
    const buckets = new Map<string, number[]>();
    for (const [i, node] of nodes.entries()) {
      const g = opt.groupOf(node);
      if (!g) continue;
      (buckets.get(g) ?? buckets.set(g, []).get(g)!).push(i);
    }
    for (const members of buckets.values()) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          links.push({ a: members[i]!, b: members[j]!, w: 0.55 });
        }
      }
    }
  }

  const n = nodes.length;
  const fx = new Float64Array(n);
  const fz = new Float64Array(n);

  for (let step = 0; step < opt.iterations; step++) {
    const cool = 1 - step / opt.iterations;
    fx.fill(0);
    fz.fill(0);

    // Repulsion. Cross-tier pairs still repel, because they overlap on screen
    // even though they never touch in world space.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i]! - px[j]!;
        let dz = pz[i]! - pz[j]!;
        let d2 = dx * dx + dz * dz;
        if (d2 < 1e-6) {
          dx = (rand() - 0.5) * 0.01;
          dz = (rand() - 0.5) * 0.01;
          d2 = 1e-4;
        }
        const sameTier = tiers[i] === tiers[j];
        const strength = (sameTier ? 0.02 : 0.006) / d2;
        const d = Math.sqrt(d2);
        fx[i]! += (dx / d) * strength;
        fz[i]! += (dz / d) * strength;
        fx[j]! -= (dx / d) * strength;
        fz[j]! -= (dz / d) * strength;
      }
    }

    // Attraction along links, weighted by whatever is bound to distance.
    for (const link of links) {
      const dx = px[link.b]! - px[link.a]!;
      const dz = pz[link.b]! - pz[link.a]!;
      const pull = 0.02 * (0.15 + link.w);
      fx[link.a]! += dx * pull;
      fz[link.a]! += dz * pull;
      fx[link.b]! -= dx * pull;
      fz[link.b]! -= dz * pull;
    }

    // Weak gravity, so disconnected nodes do not drift to infinity.
    for (let i = 0; i < n; i++) {
      fx[i]! -= px[i]! * 0.006;
      fz[i]! -= pz[i]! * 0.006;
      px[i]! += fx[i]! * cool * 2.2;
      pz[i]! += fz[i]! * cool * 2.2;
    }
  }

  // Flatten the planes before spacing them out. A square plane spends the
  // canvas's vertical budget on depth, and vertical budget is exactly what the
  // tiers need: services have to sit visibly *above* the data they read, and
  // deep planes bleed into each other until that reading is gone.
  for (let i = 0; i < n; i++) pz[i]! *= 0.42;

  // Force relaxation gets the *arrangement* right - who is near whom - but on
  // its own it happily stacks two boxes on the same spot, and an overlapping
  // pile is worse than a wrong arrangement. So the neighbourhood comes from the
  // forces and the spacing is then enforced outright.
  separate(px, pz, tiers, rand, opt.tilt, opt.gap);

  // No normalisation. Rescaling to a unit box here would undo the spacing that
  // was just enforced - the more crowded the plane, the harder it would squeeze.
  // The camera does the fitting instead, in pixels, where it belongs.
  const centreX = px.reduce((a, b) => a + b, 0) / n;
  const centreZ = pz.reduce((a, b) => a + b, 0) / n;
  /**
   * How far apart the planes have to be so they do not overlap on screen.
   *
   * A plane is not a line: its own depth projects to `2 * zExtent * tilt` of
   * vertical space. Any tier gap smaller than that guarantees the services
   * plane bleeds into the data plane, which destroys the one reading the world
   * exists to give - what runs above what. So the gap is derived from the
   * depth actually used, not configured and hoped for.
   */
  const planeGap = (): number => {
    let zExtent = 0.2;
    for (let i = 0; i < n; i++) zExtent = Math.max(zExtent, Math.abs(pz[i]!));
    return Math.max(opt.tierGap, 2 * zExtent * opt.tilt + 0.62);
  };

  const build = (): Map<string, WorldNode> => {
    const gap = planeGap();
    const out = new Map<string, WorldNode>();
    for (const [i, node] of nodes.entries()) {
      const size = opt.sizeOf?.(node) ?? { w: opt.nodeWidth, h: opt.nodeHeight };
      out.set(node.id, {
        id: node.id,
        x: px[i]! - centreX,
        z: pz[i]! - centreZ,
        y: (maxTier - tiers[i]!) * gap,
        tier: tiers[i]!,
        w: size.w,
        h: size.h,
      });
    }
    return out;
  };

  // Final pass, and the one that actually decides whether the world is legible:
  // separate the bodies in *pixels*, against the camera that will draw them.
  // World-space spacing cannot do this on its own, because the camera rescales
  // to fit - push things further apart in the world and the camera simply zooms
  // out, leaving the overlap exactly where it was.
  if (opt.viewport) {
    for (let round = 0; round < 5; round++) {
      const current = build();
      const cam = fitCamera(
        current,
        opt.viewport.width,
        opt.viewport.height,
        opt.viewport.yaw,
        opt.tilt,
        undefined,
        worldExtent(current),
      );
      if (!separateOnScreen(px, pz, tiers, nodes, current, cam, opt)) break;
    }
  }

  return build();
}

/**
 * Resolve overlapping bodies in screen space, then convert the push back into
 * world coordinates. Returns whether anything moved.
 */
function separateOnScreen(
  px: number[],
  pz: number[],
  tiers: number[],
  nodes: SceneNode[],
  world: Map<string, WorldNode>,
  cam: Camera,
  opt: WorldLayoutOptions,
): boolean {
  const n = nodes.length;
  const boxes = nodes.map((node, i) => {
    const w = world.get(node.id)!;
    const p = project3(w, cam);
    return { i, x: p.x, y: p.y, w: w.w, h: w.h + opt.labelSpace, tier: tiers[i]! };
  });

  const cos = Math.cos(cam.yaw);
  const sin = Math.sin(cam.yaw);
  const unproject = (dxScreen: number, dyScreen: number): { dx: number; dz: number } => {
    const a = dxScreen / cam.scale;
    const b = dyScreen / (cam.scaleY * cam.tilt);
    return { dx: a * cos + b * sin, dz: -a * sin + b * cos };
  };

  let moved = false;
  for (let pass = 0; pass < 24; pass++) {
    let touched = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        // Different planes are already separated vertically by the tier gap;
        // only their in-plane positions need to stop colliding.
        const padX = 12;
        const padY = a.tier === b.tier ? 8 : 2;
        const needX = (a.w + b.w) / 2 + padX;
        const needY = (a.h + b.h) / 2 + padY;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = needX - Math.abs(dx);
        const overlapY = needY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Prefer to solve a collision sideways. Moving a body up or down means
        // moving it deeper into the plane, which eats the vertical separation
        // between tiers; there is almost always width to spare instead.
        let pushX = 0;
        let pushY = 0;
        if (overlapX / needX < (overlapY / needY) * 2.2) pushX = (dx >= 0 ? 1 : -1) * overlapX * 0.5;
        else pushY = (dy >= 0 ? 1 : -1) * overlapY * 0.5;

        const { dx: wx, dz: wz } = unproject(pushX, pushY);
        px[i]! -= wx * 0.55;
        pz[i]! -= wz * 0.55;
        px[j]! += wx * 0.55;
        pz[j]! += wz * 0.55;
        a.x -= pushX * 0.55;
        a.y -= pushY * 0.55;
        b.x += pushX * 0.55;
        b.y += pushY * 0.55;
        touched = true;
        moved = true;
      }
    }
    if (!touched) break;
  }
  return moved;
}

/** How far the planes reach, so the ground can be drawn under everything on it. */
export function worldExtent(world: Map<string, WorldNode>, margin = 0.35): number {
  let extent = 0.6;
  for (const n of world.values()) extent = Math.max(extent, Math.abs(n.x), Math.abs(n.z));
  return extent + margin;
}

/**
 * Push apart anything closer than the room a body needs.
 *
 * The target gap comes from how many things share the plane: a dozen services
 * on one plane need to be further apart in world units than three do, because
 * they are competing for the same projected area.
 */
function separate(
  px: number[],
  pz: number[],
  tiers: number[],
  rand: () => number,
  tilt: number,
  gap: number,
): void {
  const n = px.length;
  // Separation has to be measured in the space the viewer sees, not the space
  // the nodes live in. The projection squashes the depth axis by `tilt`, so two
  // bodies a comfortable distance apart in z land almost on top of each other
  // on screen. Measuring with z pre-squashed is what makes the plane read as a
  // plane instead of a pile.
  const squash = Math.max(tilt, 0.15);
  for (let pass = 0; pass < 90; pass++) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sameTier = tiers[i] === tiers[j];
        // Different planes still collide on screen, just less severely.
        const want = sameTier ? gap : gap * 0.3;
        let dx = px[j]! - px[i]!;
        let dz = (pz[j]! - pz[i]!) * squash;
        let d = Math.hypot(dx, dz);
        if (d < 1e-5) {
          dx = rand() - 0.5;
          dz = rand() - 0.5;
          d = Math.hypot(dx, dz) || 1;
        }
        if (d >= want) continue;
        const push = ((want - d) / d) * 0.5;
        px[i]! -= dx * push;
        pz[i]! -= (dz / squash) * push;
        px[j]! += dx * push;
        pz[j]! += (dz / squash) * push;
        worst = Math.max(worst, want - d);
      }
    }
    if (worst < 0.004) break;
  }
}

/** Fit the projected world into a box, leaving room for labels under each body. */
export function fitCamera(
  world: Map<string, WorldNode>,
  width: number,
  height: number,
  yaw: number,
  tilt = 0.3,
  padding = 44,
  /** Include the tier planes in the fit, so the ground is not clipped. */
  extent?: number,
): Camera {
  const probe: Camera = { yaw, tilt, scale: 1, scaleY: 1, cx: 0, cy: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const ys = [...world.values()].map((n) => n.y);
  const probes: { x: number; y: number; z: number }[] = [...world.values()].map((n) => ({ x: n.x, y: n.y, z: n.z }));
  if (extent && ys.length) {
    for (const y of [Math.min(...ys), Math.max(...ys)]) {
      for (const sx of [-extent, extent]) for (const sz of [-extent, extent]) probes.push({ x: sx, y, z: sz });
    }
  }
  for (const node of probes) {
    const p = project3(node, probe);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    return { yaw, tilt, scale: 100, scaleY: 100, cx: width / 2, cy: height / 2 };
  }

  const boxW = Math.max(width - padding * 2, 120);
  const boxH = Math.max(height - padding * 2 - 44, 120);
  const fitX = boxW / Math.max(maxX - minX, 0.001);
  const fitY = boxH / Math.max(maxY - minY, 0.001);
  const base = Math.min(fitX, fitY);
  const MAX_STRETCH = 1.6;
  const scale = Math.min(fitX, base * MAX_STRETCH);
  const scaleY = Math.min(fitY, base * MAX_STRETCH);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return { yaw, tilt, scale, scaleY, cx: width / 2 - midX * scale, cy: height / 2 - midY * scaleY };
}
