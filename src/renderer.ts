import {
  couplingFor,
  styleScene,
  type EdgeStyle,
  type Glyph,
  type LegendGroup,
  type NodeStyle,
  type StyledScene,
} from './channels.js';
import { emptyFailure, propagateFailure, type FailureResult, type NodeHealth } from './failure.js';
import {
  COMPONENTS,
  componentProps,
  defaultTier,
  gaugeSpace,
  pickComponent,
  TIER_LABELS,
  type ComponentProps,
} from './components.js';
import { distanceToPath, edgePath, type EdgePath } from './geometry.js';
import {
  defaultWorldLayout,
  fitCamera,
  layoutWorld,
  project3,
  worldExtent,
  type Camera,
  type WorldNode,
} from './layout3d.js';
import { defaultLayout, layoutGraph, type LayoutNode, type LayoutOptions } from './layout.js';
import { describeTable, type FlowTable, type TableSchema } from './model.js';
import { EdgeStream, mulberry32 } from './particles.js';
import { project, type ViewSpec } from './project.js';
import { sceneFromGraph, type Scene, type SceneEdge, type SceneNode } from './scene.js';
import {
  defaultEncoding,
  edgeWidth,
  formatBytes,
  formatLatency,
  formatRps,
  rpsDomain,
  type EncodingOptions,
} from './scales.js';
import { resolveTheme, type Theme } from './theme.js';
import type { Graph } from './types.js';

export interface HoverTarget {
  kind: 'node' | 'edge';
  node?: SceneNode;
  edge?: SceneEdge;
}

export interface TraceLightOptions {
  theme?: 'auto' | 'light' | 'dark' | Theme;
  encoding?: Partial<EncodingOptions>;
  layout?: Partial<LayoutOptions>;
  showEdgeLabels?: boolean;
  showLegend?: boolean;
  speed?: number;
  animate?: boolean;
  seed?: number;
  /** In world mode, let the camera drift slowly round the mesh when nobody is touching it. */
  orbit?: boolean;
  /** Milliseconds for a re-projection morph. 0 snaps. */
  morphMs?: number;
  /**
   * Space to keep clear at each edge, in pixels - for a page that floats its
   * own legend, readout or inspector over the canvas. The layout fits inside
   * the remaining box, so nothing lands under a panel.
   */
  insets?: { top?: number; right?: number; bottom?: number; left?: number };
  onHover?: (target: HoverTarget | null) => void;
  onSelect?: (target: HoverTarget | null) => void;
  /** Fires after every re-projection, with what the picture now encodes. */
  onView?: (info: ViewInfo) => void;
}

export interface ViewInfo {
  scene: Scene;
  spec: ViewSpec;
  legend: LegendGroup[];
  splitBy: string[];
  issues: string[];
  stats: Stats;
}

export interface Stats {
  totalRps: number;
  wastedRps: number;
  wastedFraction: number;
  nodes: number;
  edges: number;
  records: number;
  filtered: number;
  deadRps: number;
  degradedRps: number;
  deadNodes: number;
  degradedNodes: number;
}

interface EdgeView {
  edge: SceneEdge;
  style: EdgeStyle;
  stream: EdgeStream;
  path: EdgePath;
  offset: number;
  /** How far this lane's particles scatter across the conduit. */
  spread: number;
  width: number;
  labelT: number | null;
}

const WASTE_KINDS = new Set(['retry', 'challenge']);
const LEGEND_STRIP = 34;
/** Seconds the failure front takes to cross one hop. Slow enough to watch it arrive. */
const FRONT_HOP_SECONDS = 0.95;

export class TraceLight {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLDivElement;
  private opts: Required<Pick<TraceLightOptions, 'showEdgeLabels' | 'showLegend' | 'speed' | 'animate' | 'seed' | 'morphMs' | 'orbit'>> &
    Pick<TraceLightOptions, 'onHover' | 'onSelect' | 'onView'>;
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private theme: Theme;
  private themeSetting: TraceLightOptions['theme'];
  private encoding: EncodingOptions;
  private layoutOpts: Partial<LayoutOptions>;

  private table: FlowTable | null = null;
  private spec: ViewSpec = { nodeKey: [] };
  private scene: Scene = { nodes: [], edges: [], meta: {}, nodeKey: [] };
  private styles: StyledScene = { edges: new Map(), nodes: new Map(), clusterBy: null, legend: [], issues: [] };
  private failure: FailureResult = emptyFailure({ nodes: [], edges: [], meta: {}, nodeKey: [] });
  private splitBy: string[] = [];
  private matched = 0;
  private filtered = 0;

  private targets = new Map<string, LayoutNode>();
  private origins = new Map<string, { x: number; y: number; fade: number }>();
  private positions = new Map<string, LayoutNode>();
  private morphFrom = 0;
  private morphing = false;

  private views: EdgeView[] = [];
  private rand: () => number;
  private killedAt = 0;

  private world = new Map<string, WorldNode>();
  private camera: Camera | null = null;
  private yaw = 0.62;
  private yawVelocity = 0;
  private dragging: { x: number; yaw: number; lastX: number; lastT: number } | null = null;

  /** A persistent selection, distinct from the transient hover. */
  private selected: string | null = null;
  /** Isolate one value of one dimension: everything else dims. */
  private highlight: { field: string; value: string } | null = null;
  /** Shockwaves from recent kills, drawn as expanding rings. */
  private shocks: { id: string; at: number }[] = [];
  private sprites = new Map<string, HTMLCanvasElement>();

  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private lastFrame = 0;
  private running = false;
  private hovered: HoverTarget | null = null;
  private pointer: { x: number; y: number } | null = null;
  private resizeObserver?: ResizeObserver;
  private motionQuery?: MediaQueryList;
  private themeQuery?: MediaQueryList;

  constructor(container: HTMLElement, options: TraceLightOptions = {}) {
    this.container = container;
    this.themeSetting = options.theme ?? 'auto';
    this.theme = resolveTheme(this.themeSetting);
    this.encoding = { ...defaultEncoding, ...options.encoding };
    this.layoutOpts = options.layout ?? {};
    this.rand = mulberry32(options.seed ?? 1);
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...options.insets };
    this.opts = {
      showEdgeLabels: options.showEdgeLabels ?? false,
      showLegend: options.showLegend ?? true,
      speed: options.speed ?? 1,
      animate: options.animate ?? !prefersReducedMotion(),
      seed: options.seed ?? 1,
      morphMs: options.morphMs ?? (prefersReducedMotion() ? 0 : 900),
      orbit: options.orbit ?? !prefersReducedMotion(),
      onHover: options.onHover,
      onSelect: options.onSelect,
      onView: options.onView,
    };

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('tracelight: 2d canvas context unavailable');
    this.ctx = ctx;

    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 90ms ease',
      font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      padding: '8px 10px',
      borderRadius: '7px',
      whiteSpace: 'pre',
      zIndex: '2',
      maxWidth: '320px',
      boxShadow: '0 6px 20px rgba(0,0,0,.28)',
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.tooltip);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('click', this.onClick);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    if (typeof matchMedia === 'function') {
      this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this.motionQuery.addEventListener?.('change', this.onMotionChange);
      this.themeQuery = matchMedia('(prefers-color-scheme: dark)');
      this.themeQuery.addEventListener?.('change', this.onThemeChange);
    }

    this.resize();
  }

  // --- public API ----------------------------------------------------------

  /** Draw a hand-written flat graph. The v0.1 path; still supported unchanged. */
  setGraph(graph: Graph): void {
    this.table = null;
    this.applyScene(sceneFromGraph(graph), this.spec, graph.edges.length, 0);
  }

  /** Draw a dimensional flow table under a view spec. */
  setTable(table: FlowTable, spec?: ViewSpec): void {
    this.table = table;
    this.spec = spec ?? this.spec;
    this.reproject();
  }

  /**
   * Change the knobs. With a table loaded this re-projects (and morphs); with a
   * flat graph it just restyles. Safe to call every frame.
   */
  setSpec(spec: ViewSpec): void {
    const killedChanged = JSON.stringify(spec.killed ?? []) !== JSON.stringify(this.spec.killed ?? []);
    this.spec = spec;
    if (killedChanged) this.killedAt = now();
    if (this.table) this.reproject();
    else this.applyScene(this.scene, spec, this.matched, this.filtered);
  }

  getSpec(): ViewSpec {
    return this.spec;
  }

  getScene(): Scene {
    return this.scene;
  }

  getLegend(): LegendGroup[] {
    return this.styles.legend;
  }

  /** What dimensions and measures the loaded table offers. */
  schema(): TableSchema | null {
    return this.table ? describeTable(this.table) : null;
  }

  /** Kill nodes and watch the front travel. Pass [] to bring everything back. */
  kill(ids: string[]): void {
    const before = new Set(this.spec.killed ?? []);
    for (const id of ids) if (!before.has(id)) this.shocks.push({ id, at: now() });
    this.setSpec({ ...this.spec, killed: ids });
  }

  /** Current health of a node under the active kills: ok, degraded or dead. */
  health(id: string): NodeHealth {
    return this.failure.health.get(id) ?? 'ok';
  }

  /** Mark one node as selected. It keeps its ring until you pass null. */
  select(id: string | null): void {
    this.selected = id;
    this.draw();
  }

  getSelected(): string | null {
    return this.selected;
  }

  /**
   * Isolate one value of a dimension - "show me only eu-west" - by dimming
   * every edge that does not carry it. Pass null to clear. Unlike a filter,
   * nothing is re-projected: the rest of the picture stays where it is, faded,
   * so you can see the isolated traffic *in context*.
   */
  setHighlight(highlight: { field: string; value: string } | null): void {
    this.highlight = highlight;
    this.draw();
  }

  /** Nudge the world camera. Yaw is in radians; the renderer eases toward it. */
  setYaw(yaw: number): void {
    this.yaw = yaw;
    if (this.isWorld()) this.recamera();
  }

  getYaw(): number {
    return this.yaw;
  }

  setOptions(options: Partial<TraceLightOptions>): void {
    if (options.theme !== undefined) {
      this.themeSetting = options.theme;
      this.theme = resolveTheme(options.theme);
    }
    if (options.encoding) this.encoding = { ...this.encoding, ...options.encoding };
    if (options.layout) this.layoutOpts = { ...this.layoutOpts, ...options.layout };
    if (options.showEdgeLabels !== undefined) this.opts.showEdgeLabels = options.showEdgeLabels;
    if (options.showLegend !== undefined) this.opts.showLegend = options.showLegend;
    if (options.speed !== undefined) this.opts.speed = options.speed;
    if (options.animate !== undefined) this.opts.animate = options.animate;
    if (options.morphMs !== undefined) this.opts.morphMs = options.morphMs;
    if (options.insets !== undefined) this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...options.insets };
    if (options.orbit !== undefined) this.opts.orbit = options.orbit;
    if (options.onHover !== undefined) this.opts.onHover = options.onHover;
    if (options.onSelect !== undefined) this.opts.onSelect = options.onSelect;
    if (options.onView !== undefined) this.opts.onView = options.onView;
    this.applyScene(this.scene, this.spec, this.matched, this.filtered);
  }

  stats(): Stats {
    let total = 0;
    let wasted = 0;
    for (const e of this.scene.edges) {
      total += e.metrics.rps;
      if (WASTE_KINDS.has(e.kind)) wasted += e.metrics.rps;
    }
    let dead = 0;
    let degraded = 0;
    for (const h of this.failure.health.values()) {
      if (h === 'dead') dead++;
      else if (h === 'degraded') degraded++;
    }
    return {
      totalRps: total,
      wastedRps: wasted,
      wastedFraction: total > 0 ? wasted / total : 0,
      nodes: this.scene.nodes.length,
      edges: this.scene.edges.length,
      records: this.matched,
      filtered: this.filtered,
      deadRps: this.failure.deadRps,
      degradedRps: this.failure.degradedRps,
      deadNodes: dead,
      degradedNodes: degraded,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  toDataURL(type = 'image/png'): string {
    return this.canvas.toDataURL(type);
  }

  destroy(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.motionQuery?.removeEventListener?.('change', this.onMotionChange);
    this.themeQuery?.removeEventListener?.('change', this.onThemeChange);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.remove();
    this.tooltip.remove();
  }

  // --- projection and morph ------------------------------------------------

  private reproject(): void {
    if (!this.table) return;
    const result = project(this.table, this.spec);
    this.splitBy = result.splitBy;
    this.applyScene(result.scene, this.spec, result.matched, result.filtered);
  }

  private applyScene(scene: Scene, spec: ViewSpec, matched: number, filtered: number): void {
    const previousScene = this.scene;
    const previousPositions = new Map(this.positions);
    const previousViews = this.views;

    this.scene = scene;
    this.spec = spec;
    this.matched = matched;
    this.filtered = filtered;

    this.styles = styleScene(scene, spec, this.theme, this.encoding);
    if (this.selected && !scene.nodes.some((n) => n.id === this.selected)) this.selected = null;

    // A column binding overrides inferred layering.
    for (const node of scene.nodes) {
      const col = this.styles.nodes.get(node.id)?.column;
      if (col !== null && col !== undefined) node.layer = col;
      else if (!scene.nodeKey.length) {
        /* keep whatever the flat graph declared */
      } else delete node.layer;
    }

    const couplingBound = Boolean(spec.channels?.coupling);
    this.failure = spec.killed?.length
      ? propagateFailure(scene, spec.killed, this.styles.edges, couplingBound)
      : emptyFailure(scene);

    this.layout(previousScene, previousPositions, previousViews);
    this.opts.onView?.({
      scene,
      spec,
      legend: this.styles.legend,
      splitBy: this.splitBy,
      issues: this.styles.issues,
      stats: this.stats(),
    });
  }

  private layout(
    previousScene: Scene,
    previousPositions: Map<string, LayoutNode>,
    previousViews: EdgeView[],
  ): void {
    if (!this.scene.nodes.length) {
      this.views = [];
      this.positions = new Map();
      this.targets = new Map();
      this.draw();
      return;
    }

    if (this.isWorld()) {
      const box = this.box();
      this.world = layoutWorld(this.scene, {
        tierOf: (n) => this.tierOf(n),
        attractionOf: (id) => this.styles.edges.get(id)?.attraction ?? 0.5,
        sizeOf: (n) => this.bodySize(n),
        viewport: { width: box.width, height: box.height, yaw: this.spec.world?.yaw ?? this.yaw },
        ...(this.styles.clusterBy
          ? { groupOf: (n: SceneNode) => nodeDimValue(n, this.styles.clusterBy!) }
          : {}),
        seed: this.opts.seed,
      });
      this.yaw = this.spec.world?.yaw ?? this.yaw;
      this.targets = this.projectWorld();
    } else {
      this.world = new Map();
      this.camera = null;
      const box = this.box();
      const laid = layoutGraph(this.scene, {
        ...defaultLayout,
        ...this.layoutOpts,
        width: box.width,
        height: box.height,
        weightOf: (id) => this.styles.edges.get(id)?.attraction ?? 0.5,
        ...(this.rowKey() ? { rowKey: this.rowKey()! } : {}),
      });
      this.targets = new Map();
      for (const [id, n] of laid) this.targets.set(id, { ...n, x: n.x + box.left, y: n.y + box.top });
    }

    // Where each node comes from, so a re-projection reads as one system being
    // re-viewed rather than four unrelated diagrams. A node that merged several
    // predecessors starts at their centroid; one that split starts at its
    // parent; one with no ancestor fades in where it lands.
    const ancestors = ancestorMap(previousScene, this.scene);
    this.origins = new Map();
    for (const node of this.scene.nodes) {
      const target = this.targets.get(node.id)!;
      const from = ancestors.get(node.id) ?? [];
      const points = from.map((id) => previousPositions.get(id)).filter(Boolean) as LayoutNode[];
      if (points.length) {
        this.origins.set(node.id, {
          x: points.reduce((a, p) => a + p.x, 0) / points.length,
          y: points.reduce((a, p) => a + p.y, 0) / points.length,
          fade: 1,
        });
      } else {
        this.origins.set(node.id, { x: target.x, y: target.y, fade: 0 });
      }
    }

    const shouldMorph =
      this.opts.morphMs > 0 && previousPositions.size > 0 && [...ancestors.values()].some((a) => a.length);
    this.morphing = shouldMorph;
    this.morphFrom = now();
    this.positions = shouldMorph ? interpolate(this.origins, this.targets, 0) : new Map(this.targets);

    this.buildViews(previousScene, previousViews);
    if (!shouldMorph) this.placeLabels();
    this.draw();
    if (!this.running) this.start();
  }

  private buildViews(previousScene: Scene, previousViews: EdgeView[]): void {
    const domain = rpsDomain(this.scene.edges.map((e) => e.metrics.rps));
    const offsets = laneOffsets(this.scene.edges, this.styles.edges);
    const adopted = adoptStreams(previousScene, this.scene, previousViews);

    this.views = this.scene.edges.map((edge) => {
      const style = this.styles.edges.get(edge.id)!;
      const stream = adopted.get(edge.id) ?? new EdgeStream(asMetricEdge(edge), this.rand);
      stream.configureDirect(style.density, style.speed, style.radius, edge.metrics.errorRate);
      const lane = offsets.get(edge.id) ?? { offset: 0, spread: 4.2, phase: 0 };
      stream.setLane(lane.spread, lane.phase);
      const offset = lane.offset;
      return {
        edge,
        style,
        stream,
        offset,
        spread: lane.spread,
        width: edgeWidth(edge.metrics.rps, domain, { curve: this.encoding.densityCurve }),
        path: this.pathFor(edge, offset),
        labelT: 0.5,
      };
    });
  }

  private isWorld(): boolean {
    return this.spec.mode === 'world';
  }

  /** Which plane a node sits on: an explicit binding, else its kind. */
  private tierOf(node: SceneNode): number {
    const by = this.spec.world?.tierBy;
    if (by) {
      const value = nodeDimValue(node, by);
      const order = this.spec.world?.tiers;
      if (value && order?.length) {
        const i = order.indexOf(value);
        if (i >= 0) return i;
      }
      if (value) {
        // Stable order for values the spec did not list.
        const all = [...new Set(this.scene.nodes.map((n) => nodeDimValue(n, by) ?? '∅'))].sort();
        return all.indexOf(value);
      }
    }
    return defaultTier(node);
  }

  /**
   * How big a body is drawn. Mass, not area: a fleet of 64 should read as
   * bigger than a single box without swallowing the plane, so it grows with the
   * logarithm of the instance count.
   */
  private bodySize(node: SceneNode): { w: number; h: number } {
    const field = this.spec.world?.instances ?? 'instances';
    const instances = Math.max(1, node.attrs[field] ?? 1);
    const base = defaultWorldLayout;
    const crowd = this.crowdScale();
    return {
      w: Math.min(base.nodeWidth * (1 + Math.log2(instances) * 0.09), base.nodeWidth * 1.45) * crowd,
      h: Math.min(base.nodeHeight * (1 + Math.log2(instances) * 0.04), base.nodeHeight * 1.3) * crowd,
    };
  }

  /**
   * Shrink every body when the projection puts more things on screen than the
   * canvas can hold at full size. Expanding a service into forty APIs should
   * give you smaller machines, not a pile of overlapping ones.
   */
  private crowdScale(): number {
    const count = this.scene.nodes.length;
    if (!count) return 1;
    const box = this.box();
    const usable = box.width * box.height * 0.5;
    const footprint = defaultWorldLayout.nodeWidth * (defaultWorldLayout.nodeHeight + defaultWorldLayout.labelSpace);
    return clamp(Math.sqrt(usable / (count * footprint)), 0.5, 1);
  }

  /** How rows are ordered inside a flat column, from the spec. */
  private rowKey(): ((id: string) => string | number) | null {
    const mode = this.spec.layout?.rowSort ?? 'auto';
    if (mode === 'auto') return null;
    const byId = new Map(this.scene.nodes.map((n) => [n.id, n]));
    if (mode === 'name') return (id) => byId.get(id)?.label ?? id;
    return (id) => {
      const n = byId.get(id);
      return n ? n.inboundRps + n.outboundRps : 0;
    };
  }

  /** The drawable box once insets and the legend strip are taken out. */
  private box(): { left: number; top: number; width: number; height: number } {
    const legend = this.opts.showLegend ? LEGEND_STRIP : 0;
    const { top, right, bottom, left } = this.insets;
    return {
      left,
      top,
      width: Math.max(this.width - left - right, 200),
      height: Math.max(this.height - top - bottom - legend, 160),
    };
  }

  /** Re-project after a camera change, keeping everything else in place. */
  private recamera(): void {
    this.targets = this.projectWorld();
    this.positions = new Map(this.targets);
    for (const v of this.views) v.path = this.pathFor(v.edge, v.offset);
  }

  /** Flatten the world onto the screen for this frame's camera. */
  private projectWorld(): Map<string, LayoutNode> {
    const box = this.box();
    const camera = fitCamera(this.world, box.width, box.height, this.yaw, undefined, undefined, worldExtent(this.world));
    camera.cx += box.left;
    camera.cy += box.top;
    this.camera = camera;
    const out = new Map<string, LayoutNode>();
    for (const [id, node] of this.world) {
      const p = project3(node, camera);
      out.set(id, { id, layer: node.tier, x: p.x, y: p.y, width: node.w, height: node.h });
    }
    return out;
  }

  private pathFor(edge: SceneEdge, offset: number): EdgePath {
    const from = this.positions.get(edge.from) ?? this.targets.get(edge.from)!;
    const to = this.positions.get(edge.to) ?? this.targets.get(edge.to)!;
    return edgePath(from, to, offset);
  }

  // --- lifecycle -----------------------------------------------------------

  private onMotionChange = (): void => {
    this.opts.animate = !prefersReducedMotion();
    this.opts.morphMs = prefersReducedMotion() ? 0 : this.opts.morphMs;
    this.draw();
  };

  private onThemeChange = (): void => {
    if (this.themeSetting === 'auto') {
      this.theme = resolveTheme('auto');
      this.applyScene(this.scene, this.spec, this.matched, this.filtered);
    }
  };

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(rect.width || this.container.clientWidth || 800, 200);
    this.height = Math.max(rect.height || this.container.clientHeight || 500, 160);
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    const keep = this.opts.morphMs;
    this.opts.morphMs = 0;
    this.applyScene(this.scene, this.spec, this.matched, this.filtered);
    this.opts.morphMs = keep;
  }

  private frame = (): void => {
    if (!this.running) return;
    const t = now();
    const dt = Math.min((t - this.lastFrame) / 1000, 0.1);
    this.lastFrame = t;

    if (this.morphing) {
      const p = Math.min(1, (t - this.morphFrom) / this.opts.morphMs);
      this.positions = interpolate(this.origins, this.targets, easeOutCubic(p));
      for (const v of this.views) v.path = this.pathFor(v.edge, v.offset);
      if (p >= 1) {
        this.morphing = false;
        this.positions = new Map(this.targets);
        for (const v of this.views) v.path = this.pathFor(v.edge, v.offset);
        this.placeLabels();
      }
    }

    // Let a released drag coast to a stop. A hard stop reads as a glitch; a
    // fast spin makes the mesh unreadable. Heavy damping gives a short glide.
    if (!this.dragging && Math.abs(this.yawVelocity) > 0.00015 && this.isWorld()) {
      this.yaw += this.yawVelocity * dt * 60;
      this.yawVelocity *= Math.pow(0.86, dt * 60);
      this.recamera();
    } else if (
      this.isWorld() &&
      this.opts.orbit &&
      this.opts.animate &&
      !this.dragging &&
      !this.hovered &&
      !this.morphing
    ) {
      // A slow orbit - a full turn takes about two minutes - so the depth of
      // the mesh keeps revealing itself without anyone having to drag. It
      // pauses under the pointer, because a moving target cannot be read.
      this.yaw += 0.05 * dt * this.opts.speed;
      this.recamera();
    }
    this.shocks = this.shocks.filter((sh) => t - sh.at < 1600);

    if (this.opts.animate && this.opts.speed > 0) {
      const frontAge = (t - this.killedAt) / 1000;
      for (const v of this.views) {
        // A severed edge stops emitting once the front has passed through it.
        const severed = this.failure.edgeHealth.get(v.edge.id) === 'severed';
        const cut = severed && frontAge >= this.frontArrival(v.edge);
        if (cut) v.stream.stopEmitting();
        v.stream.step(dt, v.path, this.encoding, this.opts.speed);
      }
    }
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Seconds after the kill at which the front reaches this edge. */
  private frontArrival(edge: SceneEdge): number {
    const hop = Math.min(this.failure.hop.get(edge.to) ?? 0, this.failure.hop.get(edge.from) ?? 99);
    return hop * FRONT_HOP_SECONDS;
  }

  // --- drawing -------------------------------------------------------------

  private draw(): void {
    const { ctx, theme } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);

    const focusNode = this.hovered?.kind === 'node' ? this.hovered.node!.id : (this.selected ?? undefined);
    const highlightId = focusNode;
    const hoveredEdgeId = this.hovered?.kind === 'edge' ? this.hovered.edge!.id : undefined;
    const frontAge = (now() - this.killedAt) / 1000;

    if (this.isWorld()) this.drawTiers();
    else this.drawGroups();

    for (const v of this.views) {
      this.drawEdge(v, this.isDimmed(v, focusNode, hoveredEdgeId), frontAge);
    }
    for (const v of this.views) this.drawParticles(v, this.isDimmed(v, focusNode, hoveredEdgeId));
    if (this.opts.showEdgeLabels && !this.morphing) for (const v of this.views) this.drawEdgeLabel(v);

    if (this.isWorld()) {
      // Painter's algorithm: far things first, so a rotated world stacks right.
      const depth = new Map<string, number>();
      for (const [id, n] of this.world) depth.set(id, this.camera ? project3(n, this.camera).depth : n.z);
      const order = [...this.scene.nodes].sort(
        (a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0),
      );
      for (const node of order) this.drawWorldNode(node, highlightId, frontAge);
    } else {
      for (const node of this.scene.nodes) this.drawNode(node, highlightId, frontAge);
    }
    if (this.opts.showLegend) this.drawLegend();

    ctx.restore();
  }

  /** Is this edge pushed into the background by the current hover, selection or isolation? */
  private isDimmed(v: EdgeView, focusNode: string | undefined, hoveredEdgeId: string | undefined): boolean {
    if (hoveredEdgeId !== undefined) return v.edge.id !== hoveredEdgeId;
    if (focusNode !== undefined && v.edge.from !== focusNode && v.edge.to !== focusNode) return true;
    if (this.highlight) {
      const value = v.edge.dims[this.highlight.field] ?? v.edge.spans[this.highlight.field]?.[0];
      const spans = v.edge.spans[this.highlight.field];
      const carries = value === this.highlight.value || (spans?.includes(this.highlight.value) ?? false);
      if (!carries) return true;
    }
    return false;
  }

  private drawEdge(v: EdgeView, dim: boolean, frontAge: number): void {
    const { ctx, theme } = this;
    const health = this.failure.edgeHealth.get(v.edge.id) ?? 'flowing';
    const arrival = this.frontArrival(v.edge);
    const cutProgress =
      health === 'severed' ? clamp01((frontAge - arrival) / FRONT_HOP_SECONDS) : 0;
    const waste = WASTE_KINDS.has(v.edge.kind);

    ctx.save();
    ctx.globalAlpha = dim ? 0.2 : health === 'severed' ? 0.85 - cutProgress * 0.45 : 1;

    const stroke =
      health === 'severed' ? theme.error : health === 'strained' ? theme.flow.retry : waste ? theme.edgeMuted : theme.edge;
    ctx.strokeStyle = stroke;
    // With the numbers off, throughput has to come through twice: as particle
    // density, and as the thickness of the conduit carrying them.
    ctx.lineWidth = v.width;

    // Depth without a 3D engine: a wide, faint under-stroke in the flow's own
    // hue sits beneath a crisp line, so the path reads as a lit conduit rather
    // than a hairline lost against the ground. Heavier flows glow more.
    if (!dim && health === 'flowing') {
      ctx.save();
      ctx.strokeStyle = v.style.hue;
      ctx.lineWidth = v.width + 6;
      ctx.globalAlpha = 0.07 + Math.min(v.width / 9, 1) * 0.13;
      ctx.beginPath();
      ctx.moveTo(v.path.a.x, v.path.a.y);
      ctx.quadraticCurveTo(v.path.ctrl.x, v.path.ctrl.y, v.path.b.x, v.path.b.y);
      ctx.stroke();
      ctx.restore();
    }

    if (v.style.coupling === 'rigid') this.strokeRigid(v, stroke);
    else {
      ctx.setLineDash(v.style.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(v.path.a.x, v.path.a.y);
      ctx.quadraticCurveTo(v.path.ctrl.x, v.path.ctrl.y, v.path.b.x, v.path.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (v.style.coupling === 'breakaway') this.drawBreakaway(v, health, cutProgress);
    if (v.style.coupling === 'rigid' && cutProgress > 0) this.drawFracture(v, cutProgress);

    // Arrowhead
    const tip = v.path.pointAt(0.985);
    const dir = v.path.tangentAt(0.985);
    const size = 6.5;
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - dir.x * size - dir.y * size * 0.5, tip.y - dir.y * size + dir.x * size * 0.5);
    ctx.lineTo(tip.x - dir.x * size + dir.y * size * 0.5, tip.y - dir.y * size - dir.x * size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * A rigid (fail-closed) coupling is drawn as a mechanical conduit: two
   * parallel rails with cross-ties. It looks like something that transmits
   * force, because that is exactly what it does - death travels along it.
   */
  private strokeRigid(v: EdgeView, stroke: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.1;
    for (const side of [-1.9, 1.9]) {
      ctx.beginPath();
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const p = v.path.pointAt(t);
        const tan = v.path.tangentAt(t);
        const x = p.x - tan.y * side;
        const y = p.y + tan.x * side;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Cross-ties: the visual signature of a hard coupling.
    for (const t of [0.24, 0.5, 0.76]) {
      const p = v.path.pointAt(t);
      const tan = v.path.tangentAt(t);
      ctx.beginPath();
      ctx.moveTo(p.x - tan.y * 3.4, p.y + tan.x * 3.4);
      ctx.lineTo(p.x + tan.y * 3.4, p.y - tan.x * 3.4);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * A breakaway (fail-open) coupling has a deliberate parting line: a gap with
   * two facing chevrons. When the far side dies it opens, and an amber shield
   * arc marks where the front stopped. A fail-open dependency is a firebreak
   * and the picture should say so.
   */
  private drawBreakaway(v: EdgeView, health: string, cut: number): void {
    const { ctx, theme } = this;
    const open = health === 'severed' ? cut : 0;
    const gap = 5 + open * 9;
    const mid = v.path.pointAt(0.5);
    const tan = v.path.tangentAt(0.5);
    const nx = -tan.y;
    const ny = tan.x;

    ctx.save();
    ctx.strokeStyle = open > 0 ? theme.flow.retry : theme.edge;
    ctx.lineWidth = 1.6;
    for (const dir of [-1, 1]) {
      const cx = mid.x + tan.x * gap * dir;
      const cy = mid.y + tan.y * gap * dir;
      ctx.beginPath();
      ctx.moveTo(cx + nx * 4.2 - tan.x * 3 * dir, cy + ny * 4.2 - tan.y * 3 * dir);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - nx * 4.2 - tan.x * 3 * dir, cy - ny * 4.2 - tan.y * 3 * dir);
      ctx.stroke();
    }
    if (open > 0.15) {
      // Shield arc on the surviving (caller) side.
      const at = v.path.pointAt(0.34);
      ctx.strokeStyle = theme.flow.retry;
      ctx.lineWidth = 2;
      ctx.globalAlpha = Math.min(1, (open - 0.15) * 2.4);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 9, Math.atan2(ny, nx) - 1.05, Math.atan2(ny, nx) + 1.05);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Where a rigid coupling gives way, it fractures rather than fading. */
  private drawFracture(v: EdgeView, progress: number): void {
    const { ctx, theme } = this;
    const at = v.path.pointAt(0.5);
    const tan = v.path.tangentAt(0.5);
    const nx = -tan.y;
    const ny = tan.x;
    const size = 4 + progress * 7;
    ctx.save();
    ctx.strokeStyle = theme.error;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(at.x + nx * size, at.y + ny * size);
    ctx.lineTo(at.x + tan.x * size * 0.5 - nx * size * 0.25, at.y + tan.y * size * 0.5 - ny * size * 0.25);
    ctx.lineTo(at.x - tan.x * size * 0.5 + nx * size * 0.25, at.y - tan.y * size * 0.5 + ny * size * 0.25);
    ctx.lineTo(at.x - nx * size, at.y - ny * size);
    ctx.stroke();
    ctx.restore();
  }

  private drawParticles(v: EdgeView, dim = false): void {
    if (!this.opts.animate) return;
    const { ctx, theme } = this;
    const health = this.failure.edgeHealth.get(v.edge.id) ?? 'flowing';
    const base = health === 'strained' ? theme.flow.retry : v.style.hue;
    const glow = v.style.glyph === 'dot' ? this.sprite(base) : null;
    ctx.save();
    for (const p of v.stream.particles) {
      if (p.t < 0) continue;
      const pt = v.path.pointAt(p.t);
      const tan = v.path.tangentAt(p.t);
      const x = pt.x - tan.y * p.wobble;
      const y = pt.y + tan.x * p.wobble;
      const fade = Math.min(1, p.t * 14, (1 - p.t) * 14) * (dim ? 0.18 : 1);
      if (p.error) {
        ctx.globalAlpha = fade;
        ctx.strokeStyle = theme.error;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(x, y, p.radius + 1.1, 0, Math.PI * 2);
        ctx.stroke();
      } else if (glow) {
        // A soft-edged sprite with a short tail behind it along the path. The
        // tail is what makes these read as things in motion rather than dots
        // that happen to be somewhere else next frame; its length is the
        // particle's own speed, so a fast hop streaks and a slow one crawls.
        const size = p.radius * 2.9;
        const stepT = (p.speed * 0.04) / v.path.length;
        for (let k = 3; k >= 1; k--) {
          const tt = p.t - stepT * k;
          if (tt <= 0) continue;
          const q = v.path.pointAt(tt);
          const tq = v.path.tangentAt(tt);
          const s = size * (1 - k * 0.2);
          ctx.globalAlpha = fade * (v.spread > 6 ? 0.9 : 1) * (0.5 - k * 0.13);
          ctx.drawImage(glow, q.x - tq.y * p.wobble - s / 2, q.y + tq.x * p.wobble - s / 2, s, s);
        }
        ctx.globalAlpha = fade * (v.spread > 6 ? 0.9 : 1);
        ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      } else {
        ctx.globalAlpha = fade * (v.spread > 6 ? 0.82 : 0.92);
        drawGlyph(ctx, v.style.glyph, x, y, p.radius, base, tan);
      }
    }
    ctx.restore();
  }

  /** A cached radial sprite per colour: bright core, soft halo. */
  private sprite(color: string): HTMLCanvasElement {
    let c = this.sprites.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    const S = 32;
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    // A solid core with a short anti-aliased edge - a point of light, not a
    // smear. The earlier wide bloom read as out of focus.
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.62, color);
    grad.addColorStop(0.8, withAlpha(color, 0.35));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this.sprites.set(color, c);
    return c;
  }

  private drawEdgeLabel(v: EdgeView): void {
    if (v.labelT === null) return;
    const { ctx, theme } = this;
    const text = edgeLabelText(v.edge);
    const at = v.path.pointAt(v.labelT);
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 8;
    ctx.globalAlpha = 0.94;
    ctx.fillStyle = theme.background;
    roundRect(ctx, at.x - w / 2, at.y - 8, w, 16, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = WASTE_KINDS.has(v.edge.kind) ? theme.flow.retry : theme.textMuted;
    ctx.fillText(text, at.x, at.y);
    ctx.restore();
  }

  private drawNode(node: SceneNode, highlightId: string | undefined, frontAge: number): void {
    const pos = this.positions.get(node.id);
    if (!pos) return;
    const { ctx, theme } = this;
    const style: NodeStyle =
      this.styles.nodes.get(node.id) ?? { fill: theme.node[node.kind], halo: 0, haloDanger: false, column: null, group: null };
    const health: NodeHealth = this.failure.health.get(node.id) ?? 'ok';
    const arrival = (this.failure.hop.get(node.id) ?? 0) * FRONT_HOP_SECONDS;
    const struck = health !== 'ok' ? clamp01((frontAge - arrival) / FRONT_HOP_SECONDS) : 0;
    const fade = this.origins.get(node.id)?.fade ?? 1;
    const morphFade = this.morphing && fade === 0 ? clamp01((now() - this.morphFrom) / this.opts.morphMs) : 1;

    const x = pos.x - pos.width / 2;
    const y = pos.y - pos.height / 2;
    ctx.save();
    ctx.globalAlpha = (highlightId && highlightId !== node.id ? 0.55 : 1) * morphFade;

    if (style.halo > 0) {
      // Keep the ring inside the row gap on a crowded column, or halos merge
      // into one outline around the whole column and say nothing. A halo that
      // encodes errors is drawn in the danger colour: a failing box should be
      // the one you spot from across the room.
      const halo = Math.min(style.halo, Math.max(2, pos.height * 0.28));
      ctx.strokeStyle = style.haloDanger ? theme.error : theme.border;
      ctx.lineWidth = 1 + (style.halo / 16) * (style.haloDanger ? 2.4 : 1.5);
      ctx.globalAlpha *= style.haloDanger ? 0.35 + (style.halo / 16) * 0.6 : 0.55;
      roundRect(ctx, x - halo, y - halo, pos.width + halo * 2, pos.height + halo * 2, 12);
      ctx.stroke();
      ctx.globalAlpha = (highlightId && highlightId !== node.id ? 0.55 : 1) * morphFade;
    }

    ctx.fillStyle = style.fill;
    ctx.strokeStyle = highlightId === node.id ? theme.highlight : theme.border;
    ctx.lineWidth = highlightId === node.id ? 1.8 : 1;
    roundRect(ctx, x, y, pos.width, pos.height, 8);
    ctx.fill();
    ctx.stroke();

    this.drawSelectionRing(node.id, pos.x, pos.y, pos.width + 10, pos.height + 10, 12);
    this.drawShock(node.id, pos.x, pos.y);

    if (health === 'dead' && struck > 0) {
      // Hatch a dead node rather than just greying it: the texture survives a
      // screenshot pasted into a chat, where a colour shift does not.
      ctx.save();
      roundRect(ctx, x, y, pos.width, pos.height, 8);
      ctx.clip();
      ctx.globalAlpha = struck * 0.9;
      ctx.fillStyle = theme.background;
      ctx.fillRect(x, y, pos.width, pos.height);
      ctx.strokeStyle = theme.error;
      ctx.lineWidth = 1;
      ctx.globalAlpha = struck * 0.55;
      for (let i = -pos.height; i < pos.width; i += 6) {
        ctx.beginPath();
        ctx.moveTo(x + i, y + pos.height);
        ctx.lineTo(x + i + pos.height, y);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = theme.error;
      ctx.lineWidth = 1.6;
      roundRect(ctx, x, y, pos.width, pos.height, 8);
      ctx.stroke();
    } else if (health === 'degraded' && struck > 0) {
      ctx.save();
      ctx.strokeStyle = theme.flow.retry;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = struck * (0.6 + 0.4 * Math.sin(frontAge * 4));
      roundRect(ctx, x - 4, y - 4, pos.width + 8, pos.height + 8, 11);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = health === 'dead' ? theme.textMuted : theme.nodeText;
    ctx.font = LABEL_FONT(12);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // A dense projection makes the boxes narrow, and the name is the one thing
    // on a box that cannot be inferred from anything else - not from the fill,
    // not from the shape. So it never gets truncated to "inven…": it breaks at
    // a separator if there is one, otherwise it shrinks. Breaking mid-word is
    // the one outcome worse than either.
    const room = pos.width - 12;
    const short = pos.height < 36;
    if (short) {
      // A compact bar: name only, centred. Everything else is on hover.
      ctx.font = LABEL_FONT(pos.height < 28 ? 10 : 11);
      ctx.fillText(ellipsis(ctx, node.label, room), pos.x, pos.y);
      ctx.restore();
      return;
    }
    const lines = fitLabel(ctx, node.label, room);
    if (lines.text.length > 1) {
      ctx.fillText(lines.text[0]!, pos.x, pos.y - 8);
      ctx.fillText(lines.text[1]!, pos.x, pos.y + 5);
    } else {
      ctx.fillText(lines.text[0]!, pos.x, pos.y - 5);
      ctx.fillStyle = theme.textMuted;
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(ellipsis(ctx, node.sublabel ?? node.kind, room), pos.x, pos.y + 10);
    }
    ctx.restore();
  }

  /**
   * A neighbourhood per group. When boxes are arranged by a dimension (a team,
   * a tier), the boxes sharing a value get a soft region behind them with the
   * value written at the top, so "these live together" is drawn, not inferred
   * from alignment.
   */
  private drawGroups(): void {
    const { ctx, theme } = this;
    const groups = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (const node of this.scene.nodes) {
      const g = this.styles.nodes.get(node.id)?.group;
      const p = this.positions.get(node.id);
      if (!g || !p) continue;
      const b = groups.get(g) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      b.minX = Math.min(b.minX, p.x - p.width / 2);
      b.maxX = Math.max(b.maxX, p.x + p.width / 2);
      b.minY = Math.min(b.minY, p.y - p.height / 2);
      b.maxY = Math.max(b.maxY, p.y + p.height / 2);
      groups.set(g, b);
    }
    if (groups.size < 2) return;
    ctx.save();
    for (const [name, b] of groups) {
      const pad = 14;
      const x = b.minX - pad;
      const y = b.minY - pad - 16;
      const w = b.maxX - b.minX + pad * 2;
      const h = b.maxY - b.minY + pad * 2 + 16;
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.grid;
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, h, 14);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme.textMuted;
      ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(name.toUpperCase(), x + 12, y + 6);
    }
    ctx.restore();
  }

  /**
   * The planes themselves. Drawing the ground a tier sits on is what turns a
   * scatter of boxes into somewhere - and it makes "the data tier" a place you
   * can point at rather than a convention you have to remember.
   */
  private drawTiers(): void {
    if (!this.camera) return;
    const { ctx, theme } = this;
    const tiers = new Map<number, number>();
    for (const n of this.world.values()) tiers.set(n.tier, n.y);
    const ordered = [...tiers.entries()].sort((a, b) => a[1] - b[1]);

    ctx.save();
    for (const [tier, y] of ordered) {
      const e = worldExtent(this.world);
      const corners = [
        { x: -e, y, z: -e },
        { x: e, y, z: -e },
        { x: e, y, z: e },
        { x: -e, y, z: e },
      ].map((c) => project3(c, this.camera!));
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      for (const c of corners.slice(1)) ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = theme.grid;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.textMuted;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = this.tierLabel(tier);
      const anchor = corners[3]!;
      ctx.fillText(label, anchor.x + 6, anchor.y - 8);
    }
    ctx.restore();
  }

  private tierLabel(tier: number): string {
    const by = this.spec.world?.tierBy;
    if (by) {
      const order =
        this.spec.world?.tiers ??
        [...new Set(this.scene.nodes.map((n) => nodeDimValue(n, by) ?? '∅'))].sort();
      return order[tier] ?? `${by} ${tier}`;
    }
    return TIER_LABELS[tier] ?? `tier ${tier}`;
  }

  private drawWorldNode(node: SceneNode, highlightId: string | undefined, frontAge: number): void {
    const pos = this.positions.get(node.id);
    if (!pos) return;
    const { ctx, theme } = this;
    const style: NodeStyle =
      this.styles.nodes.get(node.id) ?? { fill: theme.node[node.kind], halo: 0, haloDanger: false, column: null, group: null };
    const health: NodeHealth = this.failure.health.get(node.id) ?? 'ok';
    const arrival = (this.failure.hop.get(node.id) ?? 0) * FRONT_HOP_SECONDS;
    const struck = health !== 'ok' ? clamp01((frontAge - arrival) / FRONT_HOP_SECONDS) : 0;

    const gaugeFields = this.spec.world?.gauges ?? ['cpu', 'mem'];
    const instanceField = this.spec.world?.instances ?? 'instances';
    const props: ComponentProps = {
      ...componentProps(theme),
      instances: Math.max(1, node.attrs[instanceField] ?? 1),
      gauges: gaugeFields
        .filter((f) => node.attrs[f] !== undefined)
        .map((f) => ({ label: f, value: node.attrs[f]! })),
      fill: style.fill,
      health,
      struck,
    };

    const component = COMPONENTS[pickComponent(node, this.componentHint(node))] ?? COMPONENTS['service-rack']!;
    const box = { cx: pos.x, top: pos.y - pos.height / 2, w: pos.width, h: pos.height };

    ctx.save();
    ctx.globalAlpha = highlightId && highlightId !== node.id ? 0.45 : 1;

    // Contact shadow: without it the bodies float off their plane.
    ctx.globalAlpha *= 0.5;
    ctx.fillStyle = theme.background;
    ctx.beginPath();
    ctx.ellipse(pos.x, box.top + box.h + 2, pos.width * 0.42, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = highlightId && highlightId !== node.id ? 0.45 : 1;

    component.draw(ctx, box, props);
    this.drawSelectionRing(node.id, pos.x, box.top + box.h * 0.5, pos.width + 16, box.h + 16, 14);
    this.drawShock(node.id, pos.x, box.top + box.h * 0.6);

    if (health === 'dead' && struck > 0) {
      ctx.save();
      ctx.globalAlpha = struck * 0.6;
      ctx.strokeStyle = theme.error;
      ctx.lineWidth = 1.4;
      for (let i = -pos.height; i < pos.width; i += 6) {
        ctx.beginPath();
        ctx.moveTo(pos.x - pos.width / 2 + i, box.top + box.h);
        ctx.lineTo(pos.x - pos.width / 2 + i + box.h, box.top);
        ctx.stroke();
      }
      ctx.restore();
    } else if (health === 'degraded' && struck > 0) {
      ctx.save();
      ctx.globalAlpha = struck * (0.55 + 0.45 * Math.sin(frontAge * 3));
      ctx.strokeStyle = theme.flow.retry;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.ellipse(pos.x, box.top + box.h * 0.55, pos.width * 0.62, box.h * 0.66, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = highlightId && highlightId !== node.id ? 0.45 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = health === 'dead' ? theme.textMuted : theme.nodeText;
    ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(ellipsis(ctx, node.label, pos.width * 1.55), pos.x, box.top + box.h + 6);
    if (node.sublabel || props.instances > 1) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      const sub = [node.sublabel, props.instances > 1 ? `×${Math.round(props.instances)}` : null]
        .filter(Boolean)
        .join(' · ');
      ctx.fillText(ellipsis(ctx, sub, pos.width * 1.55), pos.x, box.top + box.h + 18);
    }
    ctx.restore();
    void gaugeSpace;
  }

  private componentHint(node: SceneNode): string | undefined {
    const by = this.spec.world?.componentBy;
    if (node.component) return node.component;
    if (!by) return undefined;
    const value = nodeDimValue(node, by);
    if (!value) return undefined;
    return this.spec.world?.componentMap?.[value] ?? value;
  }

  /** A steady ring around the selected thing, with a slow breathing halo. */
  private drawSelectionRing(id: string, cx: number, cy: number, w: number, h: number, r: number): void {
    if (this.selected !== id) return;
    const { ctx, theme } = this;
    const breathe = 0.5 + 0.5 * Math.sin(now() / 700);
    ctx.save();
    ctx.strokeStyle = theme.highlight;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, r);
    ctx.stroke();
    ctx.globalAlpha = 0.18 + breathe * 0.14;
    ctx.lineWidth = 6;
    roundRect(ctx, cx - w / 2 - 3, cy - h / 2 - 3, w + 6, h + 6, r + 3);
    ctx.stroke();
    ctx.restore();
  }

  /** The moment of a kill: one expanding ring, gone in a second and a half. */
  private drawShock(id: string, cx: number, cy: number): void {
    const { ctx, theme } = this;
    for (const sh of this.shocks) {
      if (sh.id !== id) continue;
      const t = (now() - sh.at) / 1600;
      const r = 12 + t * 150;
      ctx.save();
      ctx.strokeStyle = theme.error;
      ctx.lineWidth = 2.2 * (1 - t);
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * (this.isWorld() ? 0.42 : 1), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawLegend(): void {
    const { ctx, theme } = this;
    const parts = this.styles.legend.length
      ? this.styles.legend.map((l) => `${l.channel} = ${l.field}`)
      : ['density = rps (log)', 'speed = 1 / latency', 'ring = error'];
    const text = parts.join('   ·   ');
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const w = Math.min(ctx.measureText(text).width + 20, this.width - 20);
    const h = 22;
    const x = Math.max(10, (this.width - w) / 2);
    const y = this.height - h - 9;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = theme.surface;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 11);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsis(ctx, text, w - 16), x + w / 2, y + h / 2);
    ctx.restore();
  }

  private placeLabels(): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const p of this.positions.values()) {
      placed.push({ x: p.x - p.width / 2 - 3, y: p.y - p.height / 2 - 3, w: p.width + 6, h: p.height + 6 });
    }
    const candidates = [0.5, 0.4, 0.6, 0.32, 0.68, 0.24, 0.76, 0.18, 0.82];
    const order = [...this.views].sort((a, b) => b.edge.metrics.rps - a.edge.metrics.rps);
    for (const v of order) {
      const text = edgeLabelText(v.edge);
      const w = ctx.measureText(text).width + 10;
      const h = 17;
      let chosen: number | null = null;
      for (const t of candidates) {
        const p = v.path.pointAt(t);
        const rect = { x: p.x - w / 2, y: p.y - h / 2, w, h };
        if (!placed.some((o) => overlaps(o, rect))) {
          chosen = t;
          placed.push(rect);
          break;
        }
      }
      v.labelT = chosen;
    }
    ctx.restore();
  }

  // --- interaction ---------------------------------------------------------

  private hitTest(x: number, y: number): HoverTarget | null {
    for (const node of this.scene.nodes) {
      const p = this.positions.get(node.id);
      if (!p) continue;
      if (
        x >= p.x - p.width / 2 &&
        x <= p.x + p.width / 2 &&
        y >= p.y - p.height / 2 &&
        y <= p.y + p.height / 2
      ) {
        return { kind: 'node', node };
      }
    }
    let best: { v: EdgeView; d: number } | null = null;
    for (const v of this.views) {
      const d = distanceToPath(v.path, { x, y });
      if (d < 9 && (!best || d < best.d)) best = { v, d };
    }
    return best ? { kind: 'edge', edge: best.v.edge } : null;
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!this.isWorld()) return;
    this.dragging = { x: ev.clientX, yaw: this.yaw, lastX: ev.clientX, lastT: now() };
    this.yawVelocity = 0;
    this.canvas.setPointerCapture?.(ev.pointerId);
  };

  private onPointerUp = (ev: PointerEvent): void => {
    this.dragging = null;
    this.canvas.releasePointerCapture?.(ev.pointerId);
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    this.pointer = { x, y };

    if (this.dragging) {
      // Slow on purpose: a fast spin makes the mesh unreadable, and the point
      // of turning it is to see round a cluster, not to whirl it.
      this.yaw = this.dragging.yaw + (ev.clientX - this.dragging.x) * 0.005;
      const t = now();
      const dtMs = Math.max(t - this.dragging.lastT, 1);
      this.yawVelocity = ((ev.clientX - this.dragging.lastX) * 0.005) / (dtMs / 16.7);
      this.dragging.lastX = ev.clientX;
      this.dragging.lastT = t;
      this.recamera();
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const hit = this.hitTest(x, y);
    const changed = targetId(hit) !== targetId(this.hovered);
    this.hovered = hit;
    this.canvas.style.cursor = hit ? 'pointer' : this.isWorld() ? 'grab' : 'default';
    this.updateTooltip();
    if (changed) this.opts.onHover?.(hit);
  };

  private onPointerLeave = (): void => {
    this.pointer = null;
    if (this.hovered) this.opts.onHover?.(null);
    this.hovered = null;
    this.canvas.style.cursor = 'default';
    this.updateTooltip();
  };

  private onClick = (): void => {
    this.opts.onSelect?.(this.hovered);
  };

  private updateTooltip(): void {
    const t = this.hovered;
    if (!t || !this.pointer) {
      this.tooltip.style.opacity = '0';
      return;
    }
    this.tooltip.style.background = this.theme.tooltipBg;
    this.tooltip.style.color = this.theme.tooltipText;
    this.tooltip.textContent =
      t.kind === 'node'
        ? nodeTooltip(t.node!, this.failure.health.get(t.node!.id) ?? 'ok')
        : edgeTooltip(t.edge!, this.styles.edges.get(t.edge!.id));
    this.tooltip.style.opacity = '1';
    const left = Math.min(this.pointer.x + 14, this.width - this.tooltip.offsetWidth - 8);
    const top = Math.min(this.pointer.y + 14, this.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.left = `${Math.max(8, left)}px`;
    this.tooltip.style.top = `${Math.max(8, top)}px`;
  }
}

// --- helpers ---------------------------------------------------------------

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Glyph,
  x: number,
  y: number,
  r: number,
  color: string,
  tan: { x: number; y: number },
): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (glyph) {
    case 'ring':
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(x, y, r + 0.6, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case 'square':
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      return;
    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(x + tan.x * r * 1.5, y + tan.y * r * 1.5);
      ctx.lineTo(x - tan.x * r - tan.y * r, y - tan.y * r + tan.x * r);
      ctx.lineTo(x - tan.x * r + tan.y * r, y - tan.y * r - tan.x * r);
      ctx.closePath();
      ctx.fill();
      return;
    case 'bar':
      ctx.lineWidth = r * 1.6;
      ctx.beginPath();
      ctx.moveTo(x - tan.x * r * 1.4, y - tan.y * r * 1.4);
      ctx.lineTo(x + tan.x * r * 1.4, y + tan.y * r * 1.4);
      ctx.stroke();
      return;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(x, y - r * 1.35);
      ctx.lineTo(x + r * 1.35, y);
      ctx.lineTo(x, y + r * 1.35);
      ctx.lineTo(x - r * 1.35, y);
      ctx.closePath();
      ctx.fill();
      return;
    default:
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
  }
}

/**
 * Which previous nodes each new node came from. Two nodes are related when they
 * agree on every dimension their keys share - so `orders` and
 * `orders / POST /orders` are the same thing at two resolutions, and a merge or
 * a split is just that relation read in one direction or the other.
 */
function ancestorMap(previous: Scene, next: Scene): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!previous.nodes.length) return out;
  const shared = previous.nodeKey.filter((k) => next.nodeKey.includes(k));

  for (const node of next.nodes) {
    if (previous.nodes.some((p) => p.id === node.id)) {
      out.set(node.id, [node.id]);
      continue;
    }
    if (!shared.length) continue;
    const matches = previous.nodes
      .filter((p) => shared.every((k) => p.key[k] === node.key[k]))
      .map((p) => p.id);
    if (matches.length) out.set(node.id, matches);
  }
  return out;
}

/**
 * Carry particle streams across a re-projection so the flows do not blink out.
 * An edge inherits the stream of the old edge between its ancestors.
 */
function adoptStreams(previous: Scene, next: Scene, views: EdgeView[]): Map<string, EdgeStream> {
  const out = new Map<string, EdgeStream>();
  if (!views.length) return out;
  const byId = new Map(views.map((v) => [v.edge.id, v.stream]));
  const shared = previous.nodeKey.filter((k) => next.nodeKey.includes(k));

  const nodeMap = new Map<string, string>();
  for (const p of previous.nodes) {
    const target = next.nodes.find(
      (n) => n.id === p.id || (shared.length > 0 && shared.every((k) => n.key[k] === p.key[k])),
    );
    if (target) nodeMap.set(p.id, target.id);
  }

  const taken = new Set<string>();
  for (const edge of next.edges) {
    if (byId.has(edge.id) && !taken.has(edge.id)) {
      out.set(edge.id, byId.get(edge.id)!);
      taken.add(edge.id);
      continue;
    }
    const donor = previous.edges.find(
      (p) =>
        !taken.has(p.id) &&
        nodeMap.get(p.from) === edge.from &&
        nodeMap.get(p.to) === edge.to &&
        byId.has(p.id),
    );
    if (donor) {
      out.set(edge.id, byId.get(donor.id)!);
      taken.add(donor.id);
    }
  }
  return out;
}

function interpolate(
  origins: Map<string, { x: number; y: number; fade: number }>,
  targets: Map<string, LayoutNode>,
  t: number,
): Map<string, LayoutNode> {
  const out = new Map<string, LayoutNode>();
  for (const [id, target] of targets) {
    const from = origins.get(id);
    if (!from) {
      out.set(id, target);
      continue;
    }
    out.set(id, {
      ...target,
      x: from.x + (target.x - from.x) * t,
      y: from.y + (target.y - from.y) * t,
    });
  }
  return out;
}

/** Minimal shim so EdgeStream keeps its v0.1 constructor shape. */
function asMetricEdge(edge: SceneEdge): { id: string; metrics: SceneEdge['metrics'] } {
  return { id: edge.id, metrics: edge.metrics };
}

function edgeLabelText(edge: SceneEdge): string {
  return `${formatRps(edge.metrics.rps)}/s · ${formatLatency(edge.metrics.latencyMs)}`;
}

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A dimension value a node carries, whether it is part of its key or just constant across it. */
function nodeDimValue(node: SceneNode, field: string): string | undefined {
  return node.key[field] ?? (node.spans[field]?.length === 1 ? node.spans[field]![0] : undefined);
}

function targetId(t: HoverTarget | null): string | null {
  if (!t) return null;
  return t.kind === 'node' ? `n:${t.node!.id}` : `e:${t.edge!.id}`;
}

function nodeTooltip(node: SceneNode, health: NodeHealth): string {
  const lines = [node.sublabel ? `${node.sublabel} · ${node.label}` : node.label];
  for (const [k, v] of Object.entries(node.key)) lines.push(`${pad(k)}${v}`);
  lines.push(`${pad('inbound')}${formatRps(node.inboundRps)}/s`);
  lines.push(`${pad('outbound')}${formatRps(node.outboundRps)}/s`);
  if (health !== 'ok') lines.push(`${pad('state')}${health.toUpperCase()}`);
  const spans = Object.entries(node.spans).filter(([, v]) => v.length && v.length <= 6);
  for (const [k, v] of spans.slice(0, 4)) lines.push(`${pad(k)}${v.join(', ')}`);
  if (node.records > 1) lines.push(`${pad('records')}${node.records}`);
  return lines.join('\n');
}

function edgeTooltip(edge: SceneEdge, style: EdgeStyle | undefined): string {
  const m = edge.metrics;
  const lines = [`${edge.from} → ${edge.to}`];
  if (edge.label) lines.push(edge.label);
  for (const [k, v] of Object.entries(edge.dims)) lines.push(`${pad(k)}${v}`);
  lines.push(`${pad('rps')}${formatRps(m.rps)}/s`);
  lines.push(`${pad('latency')}${formatLatency(m.latencyMs)}`);
  lines.push(`${pad('errors')}${(m.errorRate * 100).toFixed(m.errorRate < 0.01 ? 2 : 1)}%`);
  lines.push(`${pad('payload')}${formatBytes(m.bytes)}`);
  if (style && style.coupling !== 'plain') lines.push(`${pad('coupling')}${style.coupling}`);
  const spans = Object.entries(edge.spans).filter(([, v]) => v.length > 1 && v.length <= 6);
  for (const [k, v] of spans.slice(0, 3)) lines.push(`${pad(k)}${v.join(', ')}`);
  if (edge.records > 1) lines.push(`${pad('records')}${edge.records}`);
  return lines.join('\n');
}

function pad(label: string): string {
  return `${label.padEnd(10)}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

const LABEL_FONT = (size: number): string =>
  `600 ${size}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;

/**
 * Get a name into the width available: break at a separator, then shrink, then
 * as a last resort trim. Leaves `ctx.font` set to whatever size it settled on.
 */
function fitLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): { text: string[] } {
  if (ctx.measureText(text).width <= maxWidth) return { text: [text] };

  // A separator break, if one leaves both halves fitting.
  const separators = [...text.matchAll(/[-_/. ]/g)].map((m) => m.index ?? 0);
  const middle = text.length / 2;
  for (const at of separators.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))) {
    const head = text.slice(0, at + 1);
    const tail = text.slice(at + 1);
    if (ctx.measureText(head).width <= maxWidth && ctx.measureText(tail).width <= maxWidth) {
      return { text: [head, tail] };
    }
  }

  for (const size of [11, 10, 9, 8]) {
    ctx.font = LABEL_FONT(size);
    if (ctx.measureText(text).width <= maxWidth) return { text: [text] };
  }
  return { text: [ellipsis(ctx, text, maxWidth)] };
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

/** How many lanes still read as one mixed stream rather than needing their own track. */
const OVERLAY_LANES = 3;

interface Lane {
  offset: number;
  spread: number;
  phase: number;
}

/**
 * Decide how the lanes on one edge share the space between two boxes.
 *
 * Reciprocal edges always separate - a response must not hide under the request
 * it answers. What varies is how a *split* is drawn, and the right answer
 * depends on how many values the split produced:
 *
 * - **Two or three** (a region pair, three environments): draw them nearly on
 *   top of each other, scattered wide across the conduit and emitting out of
 *   phase, so the colours mix in one pipe. That overlap is the information -
 *   you see at a glance that this dependency carries both regions, and roughly
 *   in what ratio, which two tidy parallel lanes actively hide.
 * - **Four or more**: separate tracks. Past a handful of colours, a mixed
 *   stream is just noise, and you need to be able to follow one.
 */
function laneOffsets(edges: SceneEdge[], styles: Map<string, EdgeStyle>): Map<string, Lane> {
  const groups = new Map<string, SceneEdge[][]>();
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const dir = e.from < e.to ? 0 : 1;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = [[], []]));
    g[dir]!.push(e);
  }

  const out = new Map<string, Lane>();
  for (const [, dirs] of groups) {
    const bidirectional = dirs[0]!.length > 0 && dirs[1]!.length > 0;
    for (const list of dirs) {
      const sorted = [...list].sort((a, b) => (styles.get(a.id)?.lane ?? 0) - (styles.get(b.id)?.lane ?? 0));
      const n = sorted.length;
      const overlay = n > 1 && n <= OVERLAY_LANES;
      const step = overlay ? 3.2 : 19;
      const spread = overlay ? 11 : 4.2;
      sorted.forEach((e, i) => {
        const within = (i - (n - 1) / 2) * step;
        out.set(e.id, {
          offset: bidirectional ? 12 + Math.abs(within) + (overlay ? 0 : i * 4) : within,
          spread,
          // Stagger the emission so the lanes interleave instead of pulsing together.
          phase: n > 1 ? i / n : 0,
        });
      });
    }
  }
  return out;
}

/** "#3b82f6" or "rgb(...)" -> rgba with the given alpha. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const h = color.slice(1);
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const v = Number.parseInt(n, 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1]!.split(',').map((x) => x.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export { couplingFor };
