import type { FlowTable } from '../model.js';
import { resolveTheme, type Theme } from '../theme.js';
import { CATEGORICAL, ERROR_CEIL, ERROR_FLOOR } from '../channels.js';
import { clamp, edgeWidth, emissionRate, formatLatency, formatRps, logNorm, particleSpeed, rpsDomain } from '../scales.js';
import { mulberry32 } from '../particles.js';
import {
  aggregateEdges,
  buildAtlas,
  emptyState,
  neighbourhood,
  propagate,
  search as searchModel,
  trail as trailModel,
  visibleUnits,
  baseOf,
  type AtlasModel,
  type AtlasModelOptions,
  type AtlasState,
  type Unit,
  type UnitEdge,
} from './model.js';
import { layoutAtlas, type AtlasLayout, type Rect } from './layout.js';

export type LensName = 'traffic' | 'reliability' | 'latency' | 'ownership' | 'kafka' | 'blast';

export const LENSES: Record<LensName, { label: string; summary: string }> = {
  traffic: { label: 'Traffic', summary: 'ribbon width and particles by rps; async flows as packets' },
  reliability: { label: 'Reliability', summary: 'red glow by error rate, topic lag as pipe fill, dead fraction on tiles' },
  latency: { label: 'Latency', summary: 'ribbons heat from cool to warm as latency grows' },
  ownership: { label: 'Ownership', summary: 'everything coloured by its top-level group' },
  kafka: { label: 'Kafka', summary: 'only async flows: producers, topics, consumer groups, lag' },
  blast: { label: 'Blast radius', summary: 'rigid (fail-closed) vs breakaway (fail-open); kill a service to propagate' },
};

export interface AtlasHover {
  kind: 'unit' | 'edge' | 'band';
  id: string;
  x: number;
  y: number;
}

export interface AtlasOptions extends AtlasModelOptions {
  theme?: 'auto' | 'light' | 'dark' | Theme;
  lens?: LensName;
  animate?: boolean;
  seed?: number;
  /** Screen areas covered by the page's own chrome, so fits avoid them. */
  insets?: { top?: number; right?: number; bottom?: number; left?: number };
  onState?: (state: AtlasState) => void;
  onHover?: (hover: AtlasHover | null) => void;
  onSelect?: (id: string | null) => void;
  onCamera?: () => void;
}

export interface InspectEntry {
  id: string;
  label: string;
  kind: string;
  rps: number;
  latencyMs: number;
  errorRate: number;
  async: boolean;
  rigid: boolean;
  apis: string[];
}

export interface Inspection {
  id: string;
  kind: 'leaf' | 'group';
  label: string;
  path: string[];
  dims: Record<string, string>;
  attrs: Record<string, number>;
  inRps: number;
  outRps: number;
  errorRate: number;
  members: number;
  upstream: InspectEntry[];
  downstream: InspectEntry[];
  health: 'ok' | 'degraded' | 'dead';
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Particle {
  t: number;
  speed: number;
  err: boolean;
}

interface EdgeView {
  edge: UnitEdge;
  a: { x: number; y: number };
  b: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  width: number;
  length: number;
}

const MORPH_MS = 520;
const CAMERA_MS = 460;
const PARTICLE_EDGES = 90;
const FULL_EDGES = 360;

export class Atlas {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLDivElement;
  private theme: Theme;
  private opts: AtlasOptions;
  private rand: () => number;

  private model: AtlasModel | null = null;
  private state: AtlasState = emptyState();
  private lens: LensName;
  private units: Unit[] = [];
  private unitById = new Map<string, Unit>();
  private expanded = new Set<string>();
  private layoutResult: AtlasLayout | null = null;
  private edges: UnitEdge[] = [];
  private unitOf = new Map<string, string>();
  private internal = new Map<string, number>();
  private domainRps = { min: 1, max: 1000 };
  private health: { dead: Set<string>; degraded: Set<string> } = { dead: new Set(), degraded: new Set() };
  private trailIds: Set<string> | null = null;
  private trailEdges: Set<string> = new Set();
  private ego: Set<string> | null = null;

  /** Where every shape (tile or band) is now, and where it is going. */
  private shapes = new Map<string, Rect>();
  private shapesFrom = new Map<string, Rect>();
  private shapesTo = new Map<string, Rect>();
  private morphStart = 0;
  private morphing = false;
  private appearing = new Set<string>();

  private camera: Camera = { x: 0, y: 0, scale: 1 };
  private cameraFrom: Camera | null = null;
  private cameraTo: Camera | null = null;
  private cameraStart = 0;
  private fitScale = 1;

  private views: EdgeView[] = [];
  private particles = new Map<string, { list: Particle[]; acc: number }>();
  private dash = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private hovered: AtlasHover | null = null;
  private pointer: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private lastSemantic = 0;
  private resizeObserver?: ResizeObserver;
  private groupColour = new Map<string, string>();

  constructor(container: HTMLElement, options: AtlasOptions = {}) {
    this.container = container;
    this.opts = options;
    this.theme = resolveTheme(options.theme ?? 'auto');
    this.lens = options.lens ?? 'traffic';
    this.rand = mulberry32(options.seed ?? 3);
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' });
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('atlas: 2d canvas unavailable');
    this.ctx = ctx;
    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'absolute', pointerEvents: 'none', opacity: '0', transition: 'opacity 90ms ease',
      font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace', padding: '8px 10px', borderRadius: '7px',
      whiteSpace: 'pre', zIndex: '2', maxWidth: '360px', boxShadow: '0 6px 20px rgba(0,0,0,.28)',
      background: this.theme.tooltipBg, color: this.theme.tooltipText,
    });
    container.appendChild(this.tooltip);
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDbl);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.resize();
    this.start();
  }

  // --- public API -------------------------------------------------------------

  setTable(table: FlowTable, options: AtlasModelOptions = {}): void {
    this.model = buildAtlas(table, { ...this.opts, ...options });
    this.groupColour.clear();
    this.model.roots.forEach((r, i) => this.groupColour.set(r, CATEGORICAL[i % CATEGORICAL.length]!));
    this.state = emptyState();
    this.shapes.clear();
    this.rebuild(false);
    this.fit(undefined, false);
  }

  getModel(): AtlasModel | null {
    return this.model;
  }

  getState(): AtlasState {
    return { ...this.state, expanded: [...this.state.expanded], killed: [...this.state.killed], pins: [...(this.state.pins ?? [])] };
  }

  setState(state: Partial<AtlasState>, fitTo?: string | null): void {
    this.state = { ...this.state, ...state, expanded: [...(state.expanded ?? this.state.expanded)], killed: [...(state.killed ?? this.state.killed)], pins: [...(state.pins ?? this.state.pins ?? [])] };
    this.rebuild(true);
    if (fitTo !== undefined) this.fit(fitTo ?? undefined);
  }

  getLens(): LensName {
    return this.lens;
  }

  setLens(lens: LensName): void {
    const was = this.lens;
    this.lens = lens;
    this.particles.clear();
    // The Kafka lens aggregates only async flows, so a mixed ribbon shows its
    // event share, not its rpc share.
    if ((was === 'kafka') !== (lens === 'kafka')) this.rebuild(false);
  }

  setTheme(theme: 'auto' | 'light' | 'dark' | Theme): void {
    this.theme = resolveTheme(theme);
    this.tooltip.style.background = this.theme.tooltipBg;
    this.tooltip.style.color = this.theme.tooltipText;
  }

  expand(id: string, fit = true): void {
    id = baseOf(id);
    if (!this.model?.groups.has(id)) return;
    if (this.expanded.has(id) && this.state.expanded.includes(id)) return;
    this.setState({ expanded: [...this.state.expanded, id] }, fit ? id : undefined);
  }

  collapse(id: string, fit = true): void {
    if (!this.model?.groups.has(id)) return;
    // Collapsing a group also collapses everything under it.
    const drop = new Set<string>([id]);
    for (const gid of this.state.expanded) if (gid.startsWith(id + '/')) drop.add(gid);
    const expanded = this.state.expanded.filter((g) => !drop.has(g));
    // If the focus lives in this group, it would force it open again.
    const focus = this.state.focus && this.model.leaves.get(this.state.focus)?.path.includes(id) ? null : this.state.focus;
    this.setState({ expanded, focus }, fit ? id : undefined);
  }

  toggle(id: string): void {
    if (this.expanded.has(id)) this.collapse(id);
    else this.expand(id);
  }

  /** Collapse one level: the deepest expanded group containing the focus, else the most recently expanded. */
  up(): void {
    if (!this.model) return;
    const focusPath = this.state.focus ? this.model.leaves.get(this.state.focus)?.path ?? [] : [];
    if (this.state.focus) {
      this.focus(null);
      const deepest = [...focusPath].reverse().find((g) => this.expanded.has(g));
      if (deepest) this.fit(deepest);
      return;
    }
    const last = this.state.expanded[this.state.expanded.length - 1];
    if (last) this.collapse(last);
    else this.fit();
  }

  collapseAll(): void {
    this.setState({ expanded: [], focus: null }, null);
  }

  focus(id: string | null, hops?: number): void {
    if (id && !this.model?.leaves.has(id)) {
      if (this.model?.groups.has(id)) this.expand(id);
      return;
    }
    this.setState({ focus: id, hops: hops ?? this.state.hops }, id ? `ego:${id}` : undefined);
    this.opts.onSelect?.(id);
  }

  setHops(hops: number): void {
    this.setState({ hops: Math.max(0, Math.min(4, hops)) }, this.state.focus ? `ego:${this.state.focus}` : undefined);
  }

  kill(ids: string[]): void {
    const killed = [...new Set([...this.state.killed, ...ids])];
    this.setState({ killed });
  }

  revive(): void {
    this.setState({ killed: [] });
  }

  setTrail(from: string, to: string): string[] | null {
    if (!this.model) return null;
    const path = trailModel(this.model, from, to);
    this.trailIds = path ? new Set(path) : null;
    this.trailEdges = new Set();
    if (path) {
      for (let i = 0; i < path.length - 1; i++) this.trailEdges.add(`${path[i]}>${path[i + 1]}`);
      // The path must be visible: pin it, so its groups open just enough.
      this.setState({ pins: path, focus: null }, `trail`);
    }
    return path;
  }

  clearTrail(): void {
    const had = this.trailIds;
    this.trailIds = null;
    this.trailEdges = new Set();
    if (had) this.setState({ pins: [] });
  }

  search(query: string, limit = 12): ReturnType<typeof searchModel> {
    return this.model ? searchModel(this.model, query, limit) : [];
  }

  /** Expand down to a unit and centre it. Works for leaves and groups. */
  goTo(id: string): void {
    if (!this.model) return;
    if (this.model.leaves.has(id)) {
      const expanded = new Set(this.state.expanded);
      for (const g of this.model.leaves.get(id)!.path) expanded.add(g);
      this.setState({ expanded: [...expanded], focus: id }, `ego:${id}`);
      this.opts.onSelect?.(id);
    } else if (this.model.groups.has(id)) {
      this.expand(id);
    }
  }

  /** Where the viewer is: the expanded chain that contains the focus, or the deepest expanded chain. */
  breadcrumb(): { id: string; label: string; kind: string }[] {
    if (!this.model) return [];
    const chain: string[] = [];
    if (this.state.focus && this.model.leaves.has(this.state.focus)) {
      chain.push(...this.model.leaves.get(this.state.focus)!.path, this.state.focus);
    } else {
      const last = this.state.expanded[this.state.expanded.length - 1];
      if (last) {
        let g = this.model.groups.get(last);
        const p: string[] = [];
        while (g) {
          p.unshift(g.id);
          g = g.parent ? this.model.groups.get(g.parent) : undefined;
        }
        chain.push(...p);
      }
    }
    return chain.map((id) => {
      const g = this.model!.groups.get(id);
      return g
        ? { id, label: g.label, kind: this.model!.hierarchy[g.level] ?? 'group' }
        : { id, label: id, kind: this.model!.leaves.get(id)?.kind ?? 'leaf' };
    });
  }

  inspect(id: string): Inspection | null {
    const m = this.model;
    if (!m) return null;
    id = baseOf(id);
    const leaf = m.leaves.get(id);
    const group = m.groups.get(id);
    if (!leaf && !group) return null;
    const members = leaf ? [id] : group!.all;
    const memberSet = new Set(members);
    const up = new Map<string, InspectEntry & { lat: number; err: number }>();
    const down = new Map<string, InspectEntry & { lat: number; err: number }>();
    let inRps = 0;
    let outRps = 0;
    let errW = 0;
    const add = (map: typeof up, other: string, e: { rps: number; latencyMs: number; errorRate: number; async: boolean; rigid: boolean; apis: string[] }): void => {
      const cur = map.get(other) ?? { id: other, label: other, kind: m.leaves.get(other)?.kind ?? 'service', rps: 0, latencyMs: 0, errorRate: 0, async: e.async, rigid: e.rigid, apis: [], lat: 0, err: 0 };
      cur.rps += e.rps;
      cur.lat += e.latencyMs * e.rps;
      cur.err += e.errorRate * e.rps;
      cur.async = cur.async && e.async;
      cur.rigid = cur.rigid || e.rigid;
      cur.apis = [...new Set([...cur.apis, ...e.apis])];
      map.set(other, cur);
    };
    for (const mid of members) {
      for (const eid of m.inc.get(mid) ?? []) {
        const e = m.byId.get(eid)!;
        if (memberSet.has(e.from)) continue;
        inRps += e.rps;
        errW += e.errorRate * e.rps;
        add(up, e.from, e);
      }
      for (const eid of m.out.get(mid) ?? []) {
        const e = m.byId.get(eid)!;
        if (memberSet.has(e.to)) continue;
        outRps += e.rps;
        add(down, e.to, e);
      }
    }
    const finish = (map: typeof up): InspectEntry[] =>
      [...map.values()]
        .map((x) => ({ id: x.id, label: x.label, kind: x.kind, rps: x.rps, latencyMs: x.rps ? x.lat / x.rps : 0, errorRate: x.rps ? x.err / x.rps : 0, async: x.async, rigid: x.rigid, apis: x.apis }))
        .sort((a, b) => b.rps - a.rps);
    const health = this.health.dead.has(id) ? 'dead' : this.health.degraded.has(id) ? 'degraded' : 'ok';
    return leaf
      ? { id, kind: 'leaf', label: leaf.label, path: leaf.path, dims: leaf.dims, attrs: leaf.attrs, inRps: leaf.inRps, outRps: leaf.outRps, errorRate: leaf.errorRate, members: 1, upstream: finish(up), downstream: finish(down), health }
      : { id, kind: 'group', label: group!.label, path: group!.parent ? [group!.parent] : [], dims: {}, attrs: { lag: group!.lag }, inRps, outRps, errorRate: inRps ? errW / inRps : 0, members: members.length, upstream: finish(up), downstream: finish(down), health };
  }

  /** Animate the camera to a unit, a band, `ego:<leaf>`, `trail`, or the whole map. */
  fit(target?: string, animate = true): void {
    if (!this.layoutResult) return;
    const L = this.layoutResult;
    let rect: Rect | null = null;
    if (!target) rect = L.world;
    else if (target.startsWith('ego:')) rect = this.egoRect(target.slice(4));
    else if (target === 'trail') rect = this.trailIds ? this.union([...this.trailIds].map((id) => this.shapesTo.get(id) ?? L.rects.get(id))) : L.world;
    else rect = this.shapesTo.get(target) ?? L.rects.get(target) ?? L.bands.find((b) => b.id === target) ?? null;
    if (!rect) rect = L.world;
    this.zoomTo(rect, animate);
  }

  zoomTo(rect: Rect, animate = true): void {
    // Fit into the part of the screen the page's chrome leaves free.
    const ins = { top: 24, right: 24, bottom: 24, left: 24, ...this.opts.insets };
    const availW = Math.max(100, this.width - ins.left - ins.right);
    const availH = Math.max(100, this.height - ins.top - ins.bottom);
    const scale = clamp(Math.min(availW / Math.max(1, rect.w), availH / Math.max(1, rect.h)), this.fitScale * 0.5, 1.35);
    const cx = ins.left + availW / 2;
    const cy = ins.top + availH / 2;
    const target: Camera = {
      x: rect.x + rect.w / 2 - cx / scale,
      y: rect.y + rect.h / 2 - cy / scale,
      scale,
    };
    if (!animate || !(this.opts.animate ?? true)) {
      this.camera = target;
      this.cameraTo = null;
      return;
    }
    this.cameraFrom = { ...this.camera };
    this.cameraTo = target;
    this.cameraStart = now();
  }

  getCamera(): Camera {
    return { ...this.camera };
  }

  panBy(dx: number, dy: number): void {
    this.cameraTo = null;
    this.camera.x += dx / this.camera.scale;
    this.camera.y += dy / this.camera.scale;
  }

  /** Paint the whole map as a heat strip with the viewport, into another canvas. */
  drawMinimap(canvas: HTMLCanvasElement): void {
    const L = this.layoutResult;
    const m = this.model;
    const ctx = canvas.getContext('2d');
    if (!L || !m || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = Math.min(w / L.world.w, h / L.world.h);
    const ox = (w - L.world.w * s) / 2;
    const oy = (h - L.world.h * s) / 2;
    const t = this.theme;
    for (const b of L.bands) {
      ctx.fillStyle = b.level === 0 ? t.surface : t.grid;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(ox + b.x * s, oy + b.y * s, b.w * s, b.h * s);
    }
    for (const u of this.units) {
      const r = this.shapes.get(u.id) ?? L.rects.get(u.id);
      if (!r) continue;
      const err = this.errorOf(u);
      const heat = err > 0 ? logNorm(err, ERROR_FLOOR, ERROR_CEIL) : 0;
      ctx.globalAlpha = 1;
      ctx.fillStyle = heat > 0 ? t.error : this.lens === 'ownership' ? this.colourOf(u.id) : t.edge;
      ctx.globalAlpha = heat > 0 ? 0.35 + heat * 0.65 : 0.5;
      ctx.fillRect(ox + r.x * s, oy + r.y * s, Math.max(2, r.w * s), Math.max(2, r.h * s));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = t.highlight;
    ctx.lineWidth = 1;
    const vx = ox + this.camera.x * s;
    const vy = oy + this.camera.y * s;
    ctx.strokeRect(vx + 0.5, vy + 0.5, (this.width / this.camera.scale) * s, (this.height / this.camera.scale) * s);
  }

  /** Map a click on the minimap to a camera move. */
  minimapClick(canvas: HTMLCanvasElement, px: number, py: number): void {
    const L = this.layoutResult;
    if (!L) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const s = Math.min(w / L.world.w, h / L.world.h);
    const ox = (w - L.world.w * s) / 2;
    const oy = (h - L.world.h * s) / 2;
    const wx = (px - ox) / s;
    const wy = (py - oy) / s;
    this.cameraFrom = { ...this.camera };
    this.cameraTo = { x: wx - this.width / 2 / this.camera.scale, y: wy - this.height / 2 / this.camera.scale, scale: this.camera.scale };
    this.cameraStart = now();
  }

  toDataURL(type = 'image/png'): string {
    return this.canvas.toDataURL(type);
  }

  stats(): { units: number; edges: number; leaves: number; particles: number } {
    let p = 0;
    for (const s of this.particles.values()) p += s.list.length;
    return { units: this.units.length, edges: this.edges.length, leaves: this.model?.leaves.size ?? 0, particles: p };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
    this.tooltip.remove();
  }

  // --- model → layout -----------------------------------------------------------

  private rebuild(morph: boolean): void {
    const m = this.model;
    if (!m) return;
    const { units, expanded } = visibleUnits(m, this.state);
    this.units = units;
    this.unitById = new Map(units.map((u) => [u.id, u]));
    this.expanded = expanded;
    const L = layoutAtlas(m, units, expanded);
    this.layoutResult = L;
    const agg = aggregateEdges(m, units, this.lens === 'kafka' ? (e) => e.async : undefined);
    this.edges = agg.edges;
    this.unitOf = agg.unitOf;
    this.internal = agg.internal;
    this.domainRps = rpsDomain(this.edges.map((e) => e.rps));
    this.health = propagate(m, this.state.killed);
    this.ego = this.state.focus ? neighbourhood(m, this.state.focus, this.state.hops) : null;

    // Shapes: where things are going, and where they come from. A new shape
    // grows out of the nearest thing that existed before it.
    const to = new Map<string, Rect>();
    for (const [id, r] of L.rects) to.set(id, r);
    for (const b of L.bands) to.set(b.id, { x: b.x, y: b.y, w: b.w, h: b.h });
    const from = new Map<string, Rect>();
    this.appearing.clear();
    for (const id of to.keys()) {
      const prev = this.shapes.get(id);
      if (prev) {
        from.set(id, prev);
        continue;
      }
      from.set(id, this.ancestorShape(id) ?? to.get(id)!);
      this.appearing.add(id);
    }
    this.shapesFrom = from;
    this.shapesTo = to;
    if (morph && (this.opts.animate ?? true)) {
      this.morphStart = now();
      this.morphing = true;
    } else {
      this.shapes = new Map(to);
      this.morphing = false;
    }
    this.fitScale = this.computeFitScale();
    for (const id of [...this.particles.keys()]) if (!this.edges.some((e) => e.id === id)) this.particles.delete(id);
    this.opts.onState?.(this.getState());
  }

  private ancestorShape(id: string): Rect | null {
    const m = this.model!;
    id = baseOf(id);
    const path = m.leaves.get(id)?.path ?? (() => {
      const p: string[] = [];
      let g = m.groups.get(id);
      while (g?.parent) {
        p.unshift(g.parent);
        g = m.groups.get(g.parent);
      }
      return p;
    })();
    for (let i = path.length - 1; i >= 0; i--) {
      const r = this.shapes.get(path[i]!);
      if (r) return r;
    }
    // Collapsing: the group's tile grows out of its previous band, which had the same id.
    return null;
  }

  private egoRect(id: string): Rect | null {
    if (!this.model || !this.ego) return null;
    const ids = new Set<string>();
    for (const l of this.ego) ids.add(this.unitOf.get(l) ?? l);
    return this.union([...ids].map((u) => this.shapesTo.get(u)));
  }

  private union(rects: (Rect | undefined)[]): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
      if (!r) continue;
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    return Number.isFinite(x0) ? { x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40 } : null;
  }

  // --- frame ----------------------------------------------------------------------

  private start(): void {
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      const t = now();
      const dt = Math.min(0.05, (t - (this.last || t)) / 1000);
      this.last = t;
      this.step(dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private step(dt: number): void {
    if (this.morphing) {
      const p = clamp((now() - this.morphStart) / MORPH_MS, 0, 1);
      const e = ease(p);
      for (const [id, to] of this.shapesTo) {
        const from = this.shapesFrom.get(id) ?? to;
        this.shapes.set(id, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e });
      }
      for (const id of [...this.shapes.keys()]) if (!this.shapesTo.has(id)) this.shapes.delete(id);
      if (p >= 1) this.morphing = false;
    }
    if (this.cameraTo && this.cameraFrom) {
      const p = clamp((now() - this.cameraStart) / CAMERA_MS, 0, 1);
      const e = ease(p);
      const f = this.cameraFrom, t = this.cameraTo;
      // Interpolate scale geometrically so zooms feel even.
      const scale = f.scale * Math.pow(t.scale / f.scale, e);
      this.camera = { x: f.x + (t.x - f.x) * e, y: f.y + (t.y - f.y) * e, scale };
      if (p >= 1) {
        this.camera = { ...t };
        this.cameraTo = null;
      }
      this.opts.onCamera?.();
    }
    this.dash += dt * 28;
    this.buildViews();
    this.stepParticles(dt);
  }

  private buildViews(): void {
    // Three routes, chosen by geometry:
    //  - target wholly to the right: a horizontal S, the classic layered look;
    //  - x ranges overlap (wide tiles, same column, most back-edges): a
    //    vertical S between the tiles' facing sides, attached where along
    //    the request path the traffic actually leaves and lands. On a
    //    collapsed domain that turns its bar into a depth axis: a ribbon
    //    leaving at depth 3 leaves at depth 3;
    //  - same row and going backwards: an arc over the top.
    // Ports on a side are spread by the other end's position so a busy unit
    // fans in instead of piling onto one point.
    const shown = this.edges.filter((e) => this.showEdge(e));
    const L = this.layoutResult!;
    const half = L.metrics.tileW / 2;
    const routeOf = (e: UnitEdge): 'h' | 'v' | 'arc' => {
      const A = this.shapes.get(e.from)!;
      const B = this.shapes.get(e.to)!;
      if (B.x >= A.x + A.w - 2) return 'h';
      const sameRow = Math.abs(A.y - B.y) < 1;
      return sameRow ? 'arc' : 'v';
    };
    type Port = { e: UnitEdge; key: number };
    const ports = new Map<string, Port[]>();
    const addPort = (k: string, e: UnitEdge, key: number): void => { ports.set(k, [...(ports.get(k) ?? []), { e, key }]); };
    const routes = new Map<string, 'h' | 'v' | 'arc'>();
    for (const e of shown) {
      const A = this.shapes.get(e.from);
      const B = this.shapes.get(e.to);
      if (!A || !B) continue;
      const r = routeOf(e);
      routes.set(e.id, r);
      if (r === 'h') {
        addPort(`${e.from}:right`, e, B.y + B.h / 2);
        addPort(`${e.to}:left`, e, A.y + A.h / 2);
      }
    }
    const index = new Map<string, { i: number; n: number }>();
    for (const [k, list] of ports) {
      list.sort((a, b) => a.key - b.key);
      list.forEach((p, i) => index.set(`${k}:${p.e.id}`, { i, n: list.length }));
    }
    this.views = [];
    for (const e of shown) {
      const A = this.shapes.get(e.from);
      const B = this.shapes.get(e.to);
      if (!A || !B) continue;
      const width = edgeWidth(e.rps, this.domainRps, { min: 0.7, max: 8 });
      const r = routes.get(e.id)!;
      let a, b, c1, c2;
      if (r === 'h') {
        const po = index.get(`${e.from}:right:${e.id}`)!;
        const pi = index.get(`${e.to}:left:${e.id}`)!;
        a = { x: A.x + A.w, y: A.y + (A.h * (po.i + 1)) / (po.n + 1) };
        b = { x: B.x, y: B.y + (B.h * (pi.i + 1)) / (pi.n + 1) };
        const dx = Math.max(40, (b.x - a.x) * 0.5);
        c1 = { x: a.x + dx, y: a.y };
        c2 = { x: b.x - dx, y: b.y };
      } else if (r === 'v') {
        const down = B.y > A.y;
        const sx = clamp(L.colX(e.fromDepth) + half, A.x + 10, A.x + A.w - 10);
        const tx = clamp(L.colX(e.toDepth) + half, B.x + 10, B.x + B.w - 10);
        a = { x: sx, y: down ? A.y + A.h : A.y };
        b = { x: tx, y: down ? B.y : B.y + B.h };
        const dy = (b.y - a.y) * 0.5;
        c1 = { x: sx, y: a.y + dy };
        c2 = { x: tx, y: b.y - dy };
      } else {
        a = { x: A.x + A.w * 0.75, y: A.y };
        b = { x: B.x + B.w * 0.25, y: B.y };
        const lift = 60 + Math.abs(a.x - b.x) * 0.12;
        c1 = { x: a.x + 30, y: a.y - lift };
        c2 = { x: b.x - 30, y: b.y - lift };
      }
      const length = Math.hypot(b.x - a.x, b.y - a.y) * 1.1;
      this.views.push({ edge: e, a, b, c1, c2, width, length });
    }
  }

  private showEdge(e: UnitEdge): boolean {
    return this.lens !== 'kafka' || e.async;
  }

  private stepParticles(dt: number): void {
    if (!(this.opts.animate ?? true) || this.lens === 'ownership') {
      this.particles.clear();
      return;
    }
    // Spend particles on the edges that matter: those touching the focus and
    // the busiest at leaf level, under a global cap.
    const eligible = this.views
      .filter((v) => this.isLeafEdge(v.edge) || (this.ego && this.touchesEgo(v.edge)))
      .sort((a, b) => (this.touchesEgo(a.edge) ? 1 : 0) - (this.touchesEgo(b.edge) ? 1 : 0) || b.edge.rps - a.edge.rps)
      .slice(0, PARTICLE_EDGES);
    const live = new Set<string>();
    for (const v of eligible) {
      live.add(v.edge.id);
      let s = this.particles.get(v.edge.id);
      if (!s) {
        s = { list: [], acc: 0 };
        this.particles.set(v.edge.id, s);
      }
      const rate = emissionRate(v.edge.rps, this.domainRps) * (v.edge.async ? 0.35 : 0.55);
      s.acc += rate * dt;
      const speed = particleSpeed(v.edge.latencyMs) / Math.max(60, v.length);
      while (s.acc >= 1 && s.list.length < 60) {
        s.acc -= 1;
        s.list.push({ t: 0, speed: speed * (0.9 + this.rand() * 0.2), err: this.rand() < v.edge.errorRate });
      }
      if (s.acc > 4) s.acc = 4;
      for (const p of s.list) p.t += p.speed * dt;
      s.list = s.list.filter((p) => p.t < 1);
    }
    for (const id of [...this.particles.keys()]) if (!live.has(id)) this.particles.delete(id);
  }

  private isLeafEdge(e: UnitEdge): boolean {
    return this.unitById.get(e.from)?.kind === 'leaf' || this.unitById.get(e.to)?.kind === 'leaf';
  }

  private touchesEgo(e: UnitEdge): boolean {
    if (!this.ego) return false;
    return e.leafEdges.some((le) => this.ego!.has(le.from) && this.ego!.has(le.to));
  }

  // --- drawing --------------------------------------------------------------------

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    if (this.layoutResult) this.fitScale = this.computeFitScale();
  }

  private computeFitScale(): number {
    const L = this.layoutResult!;
    const ins = { top: 24, right: 24, bottom: 24, left: 24, ...this.opts.insets };
    return Math.min((this.width - ins.left - ins.right) / Math.max(1, L.world.w), (this.height - ins.top - ins.bottom) / Math.max(1, L.world.h));
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.camera.x) * this.camera.scale, y: (y - this.camera.y) * this.camera.scale };
  }

  private toWorld(x: number, y: number): { x: number; y: number } {
    return { x: x / this.camera.scale + this.camera.x, y: y / this.camera.scale + this.camera.y };
  }

  private draw(): void {
    const { ctx, theme: t } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = t.background;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.model || !this.layoutResult) return;
    const s = this.camera.scale;
    ctx.save();
    ctx.translate(-this.camera.x * s, -this.camera.y * s);
    ctx.scale(s, s);
    this.drawColumns();
    this.drawBands();
    const focusUnit = this.state.focus ? this.unitOf.get(this.state.focus) ?? this.state.focus : null;
    const hoverUnit = this.hovered?.kind === 'unit' ? this.hovered.id : null;
    const hoverEdge = this.hovered?.kind === 'edge' ? this.hovered.id : null;
    // Edges: full treatment for the top N by traffic plus anything the viewer
    // is looking at; hairlines for the long tail.
    // Rank by how close to the viewer's place an edge is (leaf-level first,
    // then finer tiles), then by traffic - so the thing you opened gets its
    // ribbons before the world does.
    const rank = (id: string): number => {
      const u = this.unitById.get(id);
      if (!u) return 0;
      if (u.kind === 'leaf') return 10;
      if (id.endsWith('#rest')) return 5;
      return this.model!.groups.get(id)?.level ?? 0;
    };
    const ranked = [...this.views]
      .map((v) => ({ v, p: Math.max(rank(v.edge.from), rank(v.edge.to)) }))
      .sort((a, b) => b.p - a.p || b.v.edge.rps - a.v.edge.rps)
      .map((x) => x.v);
    // The ribbon budget scales with what is on the map: a dozen domains get
    // their dozen-odd strongest flows in full and the rest as hairlines, so
    // the overview is the major routes, not every road. Hover or focus a
    // unit and its own ribbons come up regardless.
    const budget = clamp(Math.round(this.units.length * 1.6), 14, FULL_EDGES);
    const full = new Set(ranked.slice(0, budget).map((v) => v.edge.id));
    for (const v of ranked.reverse()) {
      const e = v.edge;
      const involved = e.from === focusUnit || e.to === focusUnit || e.from === hoverUnit || e.to === hoverUnit || e.id === hoverEdge;
      const inEgo = this.ego ? this.touchesEgo(e) : true;
      const onTrail = this.trailIds ? e.leafEdges.some((le) => this.trailEdges.has(le.id)) : false;
      let alpha = 1;
      if (this.trailIds) alpha = onTrail ? 1 : 0.08;
      else if (this.ego) alpha = inEgo ? 1 : 0.1;
      else if (hoverUnit || hoverEdge) alpha = involved ? 1 : 0.35;
      const hair = !full.has(e.id) && !involved && !onTrail;
      this.drawEdge(v, alpha, hair, involved || onTrail);
    }
    for (const v of this.views) if (this.particles.has(v.edge.id)) this.drawParticles(v);
    for (const u of this.units) this.drawUnit(u, focusUnit, hoverUnit);
    ctx.restore();
    this.updateTooltip();
  }

  private drawColumns(): void {
    const { ctx, theme: t } = this;
    const L = this.layoutResult!;
    const s = this.camera.scale;
    if (L.metrics.colW * s < 30) return;
    ctx.save();
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1 / s;
    ctx.fillStyle = t.textMuted;
    ctx.font = `${11 / s}px ui-monospace, Menlo, monospace`;
    ctx.globalAlpha = 0.9;
    const top = this.camera.y;
    for (let d = 0; d <= this.model!.maxDepth; d++) {
      const x = L.colX(d) - L.metrics.bandPad - 4;
      ctx.beginPath();
      ctx.moveTo(x, L.world.y);
      ctx.lineTo(x, L.world.h);
      ctx.stroke();
      if (s > 0.35) ctx.fillText(d === 0 ? 'ingress' : `depth ${d}`, L.colX(d), top + 14 / s);
    }
    ctx.restore();
  }

  private drawBands(): void {
    const { ctx, theme: t } = this;
    const s = this.camera.scale;
    for (const b of this.layoutResult!.bands) {
      const r = this.shapes.get(b.id) ?? b;
      const g = this.model!.groups.get(b.id)!;
      const colour = this.colourOf(b.id);
      ctx.save();
      ctx.globalAlpha = b.level === 0 ? 0.55 : 0.5;
      ctx.fillStyle = b.level === 0 ? t.surface : t.grid;
      roundRect(ctx, r.x, r.y, r.w, r.h, 10);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = t.border;
      ctx.lineWidth = 1 / s;
      ctx.stroke();
      // Ownership stripe on the left edge.
      ctx.fillStyle = colour;
      ctx.globalAlpha = this.lens === 'ownership' ? 0.9 : 0.55;
      roundRect(ctx, r.x, r.y, 4, r.h, 2);
      ctx.fill();
      // Header: the crumb you click to collapse.
      if (r.h * s > 14) {
        ctx.globalAlpha = 1;
        const px = clamp(10.5 / s, 12, 16);
        ctx.font = `600 ${px}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = t.text;
        const label = `${g.label}`;
        ctx.fillText(label, r.x + 12, r.y + px + 4);
        const lw = ctx.measureText(label).width;
        ctx.font = `${px * 0.85}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = t.textMuted;
        const meta = `${this.model!.hierarchy[g.level] ?? 'group'} · ${g.all.length} · ${formatRps(g.rps)}`;
        ctx.fillText(meta, r.x + 12 + lw + 10, r.y + px + 4);
        // Collapse affordance.
        ctx.fillStyle = t.textMuted;
        ctx.fillText('−', r.x + r.w - 16, r.y + px + 4);
      }
      ctx.restore();
    }
  }

  private drawEdge(v: EdgeView, alpha: number, hair: boolean, emphasised: boolean): void {
    const { ctx, theme: t } = this;
    const e = v.edge;
    const s = this.camera.scale;
    const colour = this.edgeColour(e);
    const dead = this.health.dead.has(e.to) || this.health.dead.has(e.from) || e.leafEdges.some((le) => this.health.dead.has(le.to));
    ctx.save();
    ctx.globalAlpha = alpha * (hair ? 0.2 : 0.85);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(v.a.x, v.a.y);
    ctx.bezierCurveTo(v.c1.x, v.c1.y, v.c2.x, v.c2.y, v.b.x, v.b.y);
    const w = hair ? Math.max(0.5 / s, 0.5) : Math.max(v.width, 0.7 / s);
    if (this.lens === 'blast' && !dead) {
      // Rigid: solid double line. Breakaway: broken.
      if (e.rigid) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = w + 2;
        ctx.globalAlpha *= 0.35;
        ctx.stroke();
        ctx.globalAlpha = alpha;
      } else ctx.setLineDash([9, 7]);
    } else if (e.async) {
      // Packets: a moving dash. Sync flows are solid and carry particles.
      ctx.setLineDash([Math.max(4, w * 1.6), Math.max(6, w * 2.2)]);
      ctx.lineDashOffset = -this.dash;
    } else if (e.mixed) {
      ctx.setLineDash([14, 4]);
      ctx.lineDashOffset = -this.dash;
    }
    if (dead) {
      ctx.strokeStyle = t.error;
      ctx.setLineDash([3, 5]);
    } else ctx.strokeStyle = emphasised ? this.brighten(colour) : colour;
    ctx.lineWidth = w;
    ctx.stroke();
    // Under-glow so a heavy ribbon reads over the bands.
    if (!hair && w > 3 && !dead) {
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha * 0.12;
      ctx.lineWidth = w + 6;
      ctx.stroke();
    }
    // Consumer-group label on async edges at leaf level, when there is room.
    if (!hair && e.async && s > 0.8 && (this.lens === 'kafka' || emphasised) && e.leafEdges.length === 1) {
      const api = e.leafEdges[0]!.apis[0];
      if (api && /-cg$|group/i.test(api)) {
        const mid = bez(v, 0.5);
        ctx.setLineDash([]);
        ctx.globalAlpha = alpha;
        ctx.font = `${10 / s}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = t.textMuted;
        ctx.fillText(api, mid.x + 4 / s, mid.y - 4 / s);
      }
    }
    ctx.restore();
  }

  private drawParticles(v: EdgeView): void {
    const { ctx, theme: t } = this;
    const s = this.particles.get(v.edge.id);
    if (!s) return;
    const scale = this.camera.scale;
    const r = clamp(2.1 / Math.sqrt(scale), 1.2, 3.4);
    const colour = this.edgeColour(v.edge);
    ctx.save();
    for (const p of s.list) {
      const pt = bez(v, p.t);
      ctx.fillStyle = p.err ? t.error : colour;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (p.err) {
        ctx.strokeStyle = t.error;
        ctx.lineWidth = 1 / scale;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawUnit(u: Unit, focusUnit: string | null, hoverUnit: string | null): void {
    const { ctx, theme: t } = this;
    const r = this.shapes.get(u.id);
    if (!r) return;
    const s = this.camera.scale;
    const m = this.model!;
    const leaf = u.kind === 'leaf' ? m.leaves.get(u.id) : undefined;
    const group = u.kind === 'group' ? m.groups.get(u.id) : undefined;
    const isTopic = leaf?.kind === 'topic';
    const dead = u.members.every((id) => this.health.dead.has(id));
    const deadFrac = u.members.filter((id) => this.health.dead.has(id)).length / u.members.length;
    const degraded = !dead && u.members.some((id) => this.health.degraded.has(id));
    const inEgo = !this.ego || u.members.some((id) => this.ego!.has(id));
    const onTrail = this.trailIds ? u.members.some((id) => this.trailIds!.has(id)) : true;
    let alpha = 1;
    if (this.trailIds) alpha = onTrail ? 1 : 0.25;
    else if (this.ego) alpha = inEgo ? 1 : 0.35;
    const appear = this.appearing.has(u.id) && this.morphing ? ease(clamp((now() - this.morphStart) / MORPH_MS, 0, 1)) : 1;
    alpha *= 0.15 + appear * 0.85;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Error glow: absolute scale, same as the flat renderer.
    const err = this.errorOf(u);
    const heat = err > 0 ? logNorm(err, ERROR_FLOOR, ERROR_CEIL) : 0;
    if (heat > 0 && this.lens !== 'ownership') this.drawGlow(r, heat * (this.lens === 'reliability' ? 1 : 0.8), alpha);

    const fill = this.fillOf(u, leaf?.kind ?? 'group');
    if (isTopic) this.drawRail(r, leaf!, fill, alpha);
    else {
      ctx.fillStyle = fill;
      ctx.strokeStyle = u.id === focusUnit ? t.highlight : u.id === hoverUnit ? t.text : t.border;
      ctx.lineWidth = (u.id === focusUnit ? 2 : 1) / Math.max(0.5, Math.min(1, s));
      roundRect(ctx, r.x, r.y, r.w, r.h, u.kind === 'group' ? 8 : leaf?.kind === 'datastore' || leaf?.kind === 'cache' ? 14 : 6);
      ctx.fill();
      ctx.stroke();
      if (u.kind === 'group') {
        // A collapsed group: ownership stripe, member count, a small
        // "contains topics" pipe if it does.
        ctx.fillStyle = this.colourOf(u.id);
        ctx.globalAlpha = alpha * 0.9;
        roundRect(ctx, r.x, r.y, 5, r.h, 2);
        ctx.fill();
        ctx.globalAlpha = alpha;
      }
    }
    if (dead) this.hatch(r, alpha);
    else if (deadFrac > 0) {
      ctx.fillStyle = t.error;
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillRect(r.x + 6, r.y + r.h - 4, (r.w - 12) * deadFrac, 3);
      ctx.globalAlpha = alpha;
    }
    if (degraded) {
      ctx.strokeStyle = '#f59e0b';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5 / Math.max(0.5, s);
      roundRect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 9);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Labels, only when legible.
    if (r.h * s >= 7) {
      // Never smaller than ~10 screen px: a label you cannot read is noise.
      const px = clamp(10.5 / s, 12, r.h * 0.62);
      ctx.font = `${u.kind === 'group' ? 600 : 500} ${px}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = t.nodeText;
      ctx.textBaseline = 'middle';
      const label = u.kind === 'group' ? (group ? group.label : `${u.members.length} more`) : leaf!.label;
      const pad = u.kind === 'group' ? 12 : isTopic ? 10 : 8;
      const maxW = r.w - pad * 2 - (u.kind === 'group' ? 46 : 0);
      ctx.fillText(fitText(ctx, label, maxW), r.x + pad, r.y + r.h / 2);
      if (u.kind === 'group') {
        ctx.font = `${px * 0.85}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = t.textMuted;
        ctx.textAlign = 'right';
        const topics = u.members.filter((id) => m.leaves.get(id)?.kind === 'topic').length;
        if (group) ctx.fillText(`${u.members.length - topics}${topics ? ` ·${topics}⊟` : ''}`, r.x + r.w - 10, r.y + r.h / 2);
        ctx.textAlign = 'left';
      }
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  /** A Kafka topic: a pipe, partition ticks, lag filling it from the left. */
  private drawRail(r: Rect, leaf: { attrs: Record<string, number> }, fill: string, alpha: number): void {
    const { ctx, theme: t } = this;
    const s = this.camera.scale;
    const lag = leaf.attrs.lag ?? 0;
    const lagT = lag > 0 ? logNorm(lag, 100, 1e6) : 0;
    ctx.fillStyle = fill;
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1 / Math.max(0.5, Math.min(1, s));
    roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
    ctx.fill();
    ctx.stroke();
    // Partition ticks.
    const parts = Math.min(24, leaf.attrs.partitions ?? 6);
    ctx.strokeStyle = t.border;
    ctx.globalAlpha = alpha * 0.6;
    for (let i = 1; i < parts; i++) {
      const x = r.x + 10 + ((r.w - 20) * i) / parts;
      ctx.beginPath();
      ctx.moveTo(x, r.y + 3);
      ctx.lineTo(x, r.y + r.h - 3);
      ctx.stroke();
    }
    // Lag fill: amber to red as it grows.
    if (lagT > 0.05) {
      const w = (r.w - 8) * lagT;
      const col = lagT < 0.55 ? '#f59e0b' : t.error;
      ctx.fillStyle = col;
      ctx.globalAlpha = alpha * (0.35 + lagT * 0.4);
      roundRect(ctx, r.x + 4, r.y + 4, w, r.h - 8, (r.h - 8) / 2);
      ctx.fill();
      // The meniscus: a bright leading edge, so the level reads.
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillRect(r.x + 4 + w - 1.5, r.y + 4, 1.5, r.h - 8);
    }
    ctx.globalAlpha = alpha;
    // Pipe end caps.
    ctx.strokeStyle = t.textMuted;
    ctx.globalAlpha = alpha * 0.7;
    ctx.beginPath();
    ctx.moveTo(r.x + 6, r.y + 2);
    ctx.lineTo(r.x + 6, r.y + r.h - 2);
    ctx.moveTo(r.x + r.w - 6, r.y + 2);
    ctx.lineTo(r.x + r.w - 6, r.y + r.h - 2);
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }

  private drawGlow(r: Rect, t: number, alpha: number): void {
    const { ctx, theme } = this;
    const s = this.camera.scale;
    const breathe = t > 0.5 ? (0.5 + 0.5 * Math.sin(now() / 540 + r.x * 0.013 + r.y * 0.007)) * (t - 0.5) * 2 : 0;
    const spread = (3 + t * t * 26 + breathe * 5) / Math.max(0.6, Math.min(1, s));
    const strength = (0.18 + t * 0.62 + breathe * 0.12) * alpha;
    ctx.save();
    ctx.fillStyle = theme.error;
    for (const [k, a] of [[1, 0.22], [0.6, 0.3], [0.3, 0.42]] as const) {
      ctx.shadowColor = theme.error;
      ctx.shadowBlur = spread * k * 2.2 * s;
      ctx.globalAlpha = strength * a * (theme.name === 'dark' ? 1 : 0.8);
      const pad = spread * k * 0.5;
      roundRect(ctx, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 10 + pad);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = theme.error;
    ctx.lineWidth = (1 + t * t * 3.5) / Math.max(0.6, Math.min(1, s));
    ctx.globalAlpha = (0.4 + t * 0.55) * alpha;
    const rim = 2 + t * t * 5;
    roundRect(ctx, r.x - rim, r.y - rim, r.w + rim * 2, r.h + rim * 2, 10);
    ctx.stroke();
    ctx.restore();
  }

  private hatch(r: Rect, alpha: number): void {
    const { ctx, theme: t } = this;
    ctx.save();
    roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.clip();
    ctx.strokeStyle = t.error;
    ctx.globalAlpha = alpha * 0.55;
    ctx.lineWidth = 1.5;
    for (let x = r.x - r.h; x < r.x + r.w; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, r.y + r.h);
      ctx.lineTo(x + r.h, r.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- styling ------------------------------------------------------------------------

  private rootOf(id: string): string {
    const m = this.model!;
    id = baseOf(id);
    const leaf = m.leaves.get(id);
    if (leaf) return leaf.path[0] ?? id;
    let g = m.groups.get(id);
    while (g?.parent) g = m.groups.get(g.parent);
    return g?.id ?? id;
  }

  private colourOf(id: string): string {
    return this.groupColour.get(this.rootOf(id)) ?? this.theme.edge;
  }

  private fillOf(u: Unit, kind: string): string {
    const t = this.theme;
    if (this.lens === 'ownership') return mix(this.colourOf(u.id), t.name === 'dark' ? 0.72 : 0.84, t);
    if (u.kind === 'group') return u.id.endsWith('#rest') ? (t.name === 'dark' ? '#171d26' : '#f3f5f8') : t.name === 'dark' ? '#1d2531' : '#eef2f7';
    const k = kind as keyof Theme['node'];
    if (kind === 'topic') return t.name === 'dark' ? '#2a2f3d' : '#ecebf7';
    return t.node[k] ?? t.node.service;
  }

  private edgeColour(e: UnitEdge): string {
    const t = this.theme;
    switch (this.lens) {
      case 'ownership':
        return this.colourOf(e.from);
      case 'latency': {
        const h = logNorm(clamp(e.latencyMs, 2, 800), 2, 800);
        return heat(h, t.name === 'dark');
      }
      case 'reliability': {
        const h = e.errorRate > ERROR_FLOOR ? logNorm(e.errorRate, ERROR_FLOOR, ERROR_CEIL) : 0;
        return h > 0 ? mixHex(t.edge, t.error, 0.3 + h * 0.7) : t.edge;
      }
      case 'blast':
        return e.rigid ? (t.name === 'dark' ? '#8fa3c0' : '#4b5b73') : t.edgeMuted;
      default:
        return e.async ? t.flow.challenge : t.flow.request;
    }
  }

  private brighten(hex: string): string {
    return mixHex(hex, this.theme.name === 'dark' ? '#ffffff' : '#000000', 0.25);
  }

  private errorOf(u: Unit): number {
    const m = this.model!;
    if (u.kind === 'leaf') return m.leaves.get(u.id)!.errorRate;
    // A group's halo is its worst member, not its average: one burning box in
    // a team of forty is exactly the thing the map exists to show.
    let worst = 0;
    for (const id of u.members) worst = Math.max(worst, m.leaves.get(id)!.errorRate);
    return worst;
  }

  // --- interaction ------------------------------------------------------------------

  private hit(sx: number, sy: number): AtlasHover | null {
    if (!this.layoutResult) return null;
    const p = this.toWorld(sx, sy);
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i]!;
      const r = this.shapes.get(u.id);
      if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { kind: 'unit', id: u.id, x: sx, y: sy };
    }
    // Edges: nearest within a few screen pixels.
    const tol = 5 / this.camera.scale;
    let best: { id: string; d: number } | null = null;
    for (const v of this.views) {
      const bb = { x0: Math.min(v.a.x, v.b.x, v.c1.x, v.c2.x) - tol, x1: Math.max(v.a.x, v.b.x, v.c1.x, v.c2.x) + tol, y0: Math.min(v.a.y, v.b.y, v.c1.y, v.c2.y) - tol, y1: Math.max(v.a.y, v.b.y, v.c1.y, v.c2.y) + tol };
      if (p.x < bb.x0 || p.x > bb.x1 || p.y < bb.y0 || p.y > bb.y1) continue;
      for (let k = 0; k <= 24; k++) {
        const q = bez(v, k / 24);
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < tol + v.width / 2 && (!best || d < best.d)) best = { id: v.edge.id, d };
      }
    }
    if (best) return { kind: 'edge', id: best.id, x: sx, y: sy };
    // Band headers, innermost first.
    for (const b of [...this.layoutResult.bands].reverse()) {
      const r = this.shapes.get(b.id) ?? b;
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + Math.min(r.h, 26)) return { kind: 'band', id: b.id, x: sx, y: sy };
    }
    return null;
  }

  private onDown = (ev: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.drag = { x: ev.clientX - rect.left, y: ev.clientY - rect.top, cx: this.camera.x, cy: this.camera.y, moved: false };
    this.cameraTo = null;
    this.canvas.setPointerCapture(ev.pointerId);
    this.canvas.style.cursor = 'grabbing';
  };

  private onMove = (ev: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    this.pointer = { x, y };
    if (this.drag) {
      const dx = x - this.drag.x;
      const dy = y - this.drag.y;
      if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
      if (this.drag.moved) {
        this.camera.x = this.drag.cx - dx / this.camera.scale;
        this.camera.y = this.drag.cy - dy / this.camera.scale;
        this.opts.onCamera?.();
      }
      return;
    }
    const h = this.hit(x, y);
    const changed = h?.id !== this.hovered?.id || h?.kind !== this.hovered?.kind;
    this.hovered = h;
    this.canvas.style.cursor = h ? 'pointer' : 'grab';
    if (changed) this.opts.onHover?.(h);
  };

  private onUp = (ev: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    this.canvas.style.cursor = 'grab';
    if (!drag || drag.moved) return;
    const rect = this.canvas.getBoundingClientRect();
    const h = this.hit(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!h) {
      if (this.state.focus) this.focus(null);
      return;
    }
    if (h.kind === 'unit') {
      const u = this.unitById.get(h.id);
      if (u?.kind === 'group') this.expand(h.id);
      else this.focus(this.state.focus === h.id ? null : h.id);
    } else if (h.kind === 'band') this.collapse(h.id);
    else if (h.kind === 'edge') this.opts.onSelect?.(h.id);
  };

  private onLeave = (): void => {
    this.pointer = null;
    if (this.hovered) this.opts.onHover?.(null);
    this.hovered = null;
    this.tooltip.style.opacity = '0';
  };

  private onDbl = (ev: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const h = this.hit(ev.clientX - rect.left, ev.clientY - rect.top);
    if (h?.kind === 'unit') {
      const u = this.unitById.get(h.id);
      if (u?.kind === 'group') this.expand(h.id);
      else this.fit(h.id);
    } else if (h?.kind === 'band') this.collapse(h.id);
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) {
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022));
      this.zoomAt(sx, sy, factor);
    } else {
      this.panBy(ev.deltaX, 0);
    }
  };

  /** Zoom around a screen point, with semantic zoom at the ends of the range. */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.cameraTo = null;
    const before = this.toWorld(sx, sy);
    const minScale = this.fitScale * 0.55;
    const next = clamp(this.camera.scale * factor, minScale, 3);
    const t = now();
    if (factor > 1) {
      // Zooming in over a collapsed tile that is already large: open it.
      const h = this.hit(sx, sy);
      const u = h?.kind === 'unit' ? this.unitById.get(h.id) : undefined;
      if (u?.kind === 'group') {
        const r = this.shapes.get(u.id)!;
        if (r.w * next > 300 && t - this.lastSemantic > 700) {
          this.lastSemantic = t;
          this.expand(u.id);
          return;
        }
      }
    } else if (this.camera.scale <= this.fitScale * 0.9 && t - this.lastSemantic > 700) {
      // Zooming out when the map already fits: fold up the group under the cursor.
      const p = this.toWorld(sx, sy);
      const inner = [...this.layoutResult!.bands].reverse().find((b) => {
        const r = this.shapes.get(b.id) ?? b;
        return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
      });
      if (inner) {
        this.lastSemantic = t;
        this.collapse(inner.id);
        return;
      }
    }
    this.camera.scale = next;
    const after = this.toWorld(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.opts.onCamera?.();
  }

  private updateTooltip(): void {
    const h = this.hovered;
    if (!h || !this.pointer || !this.model || this.drag) {
      this.tooltip.style.opacity = '0';
      return;
    }
    const m = this.model;
    let text = '';
    if (h.kind === 'unit') {
      const u = this.unitById.get(h.id)!;
      if (u.kind === 'leaf') {
        const l = m.leaves.get(u.id)!;
        const bits = [l.id, `${l.kind} · ${l.path.join(' › ')}`, `in ${formatRps(l.inRps)}  out ${formatRps(l.outRps)}`];
        if (l.errorRate > 0) bits.push(`errors ${(l.errorRate * 100).toFixed(2)}%`);
        if (l.kind === 'topic') bits.push(`partitions ${l.attrs.partitions ?? '?'}  lag ${fmtInt(l.attrs.lag ?? 0)}`);
        if (l.attrs.instances) bits.push(`instances ${l.attrs.instances}`);
        if (this.health.dead.has(l.id)) bits.push('DEAD');
        else if (this.health.degraded.has(l.id)) bits.push('degraded (a fail-open dependency is dead)');
        text = bits.join('\n');
      } else if (!m.groups.has(u.id)) {
        text = `${u.members.length} more in ${m.groups.get(baseOf(u.id))?.label ?? 'this group'}\nnot in the focus's neighbourhood · click to open all`;
      } else {
        const g = m.groups.get(u.id)!;
        const topics = g.all.filter((id) => m.leaves.get(id)!.kind === 'topic').length;
        const dead = g.all.filter((id) => this.health.dead.has(id)).length;
        const bits = [g.label, `${m.hierarchy[g.level] ?? 'group'} · ${g.all.length - topics} services${topics ? `, ${topics} topics` : ''}`, `traffic ${formatRps(g.rps)}  internal ${formatRps(this.internal.get(g.id) ?? 0)}`];
        const worst = this.errorOf(u);
        if (worst > ERROR_FLOOR) bits.push(`worst error rate ${(worst * 100).toFixed(1)}%`);
        if (g.lag > 0) bits.push(`worst lag ${fmtInt(g.lag)}`);
        if (dead) bits.push(`${dead} dead`);
        bits.push('click to open');
        text = bits.join('\n');
      }
    } else if (h.kind === 'edge') {
      const e = this.edges.find((x) => x.id === h.id);
      if (e) {
        const bits = [`${e.from}  →  ${e.to}`, `${formatRps(e.rps)}  ${formatLatency(e.latencyMs)}  ${(e.errorRate * 100).toFixed(2)}% err`, e.async ? 'async (kafka)' : e.mixed ? 'sync + async' : 'sync', e.rigid ? 'fail-closed on every flow' : 'has fail-open flows'];
        if (e.leafEdges.length > 1) bits.push(`${e.leafEdges.length} flows between ${e.fromLeaves} and ${e.toLeaves} services`);
        else if (e.leafEdges[0]?.apis.length) bits.push(e.leafEdges[0].apis.slice(0, 6).join(', '));
        if (e.back) bits.push('against the grain (callback / cycle)');
        text = bits.join('\n');
      }
    } else {
      const g = m.groups.get(h.id)!;
      text = `${g.label}\nclick header to collapse`;
    }
    this.tooltip.textContent = text;
    this.tooltip.style.opacity = '1';
    const x = Math.min(this.pointer.x + 14, this.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(this.pointer.y + 14, this.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.transform = `translate(${x}px, ${y}px)`;
  }
}

// --- helpers ---------------------------------------------------------------------------

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function bez(v: EdgeView, t: number): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * v.a.x + 3 * mt * mt * t * v.c1.x + 3 * mt * t * t * v.c2.x + t * t * t * v.b.x,
    y: mt * mt * mt * v.a.y + 3 * mt * mt * t * v.c1.y + 3 * mt * t * t * v.c2.y + t * t * t * v.b.y,
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 2 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function fmtInt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number): string => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

function mix(hex: string, toward: number, theme: Theme): string {
  return mixHex(hex, theme.name === 'dark' ? '#0e1117' : '#ffffff', toward);
}

/** Cool to warm. */
function heat(t: number, dark: boolean): string {
  const stops = dark ? ['#4ad6b8', '#5aa9ff', '#c58bff', '#ffb54d', '#ff6b6b'] : ['#0d9488', '#1f6feb', '#8b5cf6', '#d97706', '#dc2626'];
  const i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  return mixHex(stops[i]!, stops[i + 1]!, t * (stops.length - 1) - i);
}
