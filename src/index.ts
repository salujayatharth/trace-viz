/**
 * tracelight - visualize service topologies as animated particle flows.
 *
 * @example
 * ```ts
 * import { TraceLight, authChallengeScenario } from 'tracelight';
 *
 * const tl = new TraceLight(document.querySelector('#map')!, { theme: 'auto' });
 * tl.setGraph(authChallengeScenario(5000));
 * ```
 */
export { TraceLight } from './renderer.js';
export type { HoverTarget, TraceLightOptions, ViewInfo, Stats } from './renderer.js';

// --- the dimensional framework --------------------------------------------
export { describeTable, endpointDims, fieldValue } from './model.js';
export type { FlowTable, FlowRecord, FlowMeasures, NodeFact, DimValues, DimensionMeta, TableSchema } from './model.js';
export { project, nodeIdFor, isMeasure } from './project.js';
export type { ViewSpec, WorldSpec, ChannelBinding, ProjectionResult } from './project.js';
export { sceneFromGraph } from './scene.js';
export type { Scene, SceneNode, SceneEdge } from './scene.js';
export { CHANNELS, styleScene, couplingFor, CATEGORICAL, ERROR_FLOOR, ERROR_CEIL } from './channels.js';
export type { ChannelName, ChannelDef, EdgeStyle, NodeStyle, Glyph, Coupling, LegendGroup, StyledScene } from './channels.js';
export { COMPONENTS, pickComponent, defaultTier, TIER_LABELS } from './components.js';
export type { WorldComponent, ComponentProps, ComponentBox } from './components.js';
export { layoutWorld, fitCamera, project3, worldExtent, defaultWorldLayout } from './layout3d.js';
export type { WorldNode, Camera, WorldLayoutOptions } from './layout3d.js';
export { propagateFailure, emptyFailure } from './failure.js';
export type { FailureResult, NodeHealth, EdgeHealth } from './failure.js';
export { proposeSpec, validateSpec, heuristicSpec, buildPrompt, extractJson } from './agent.js';
export type { Completion, ProposeOptions, ProposalResult } from './agent.js';
export { generateMesh } from './mesh.js';
export { generateEstate } from './estate.js';
export type { EstateOptions } from './estate.js';
export type { MeshOptions } from './mesh.js';

export { resolveGraph, safeResolveGraph, GraphValidationError } from './schema.js';
export { layoutGraph, defaultLayout } from './layout.js';
export type { LayoutNode, LayoutOptions, LayoutInput, Point } from './layout.js';
export { EdgeStream, mulberry32 } from './particles.js';
export type { Particle } from './particles.js';
export { edgePath, borderPoint, distanceToPath } from './geometry.js';
export type { EdgePath } from './geometry.js';

export {
  defaultEncoding,
  emissionRate,
  particleSpeed,
  particleRadius,
  edgeWidth,
  logNorm,
  rpsDomain,
  clamp,
  formatRps,
  formatLatency,
  formatBytes,
} from './scales.js';
export type { EncodingOptions } from './scales.js';

export { themes, lightTheme, darkTheme, resolveTheme } from './theme.js';
export type { Theme } from './theme.js';

export { generateSeedGraph, authChallengeScenario, tokenAuthScenario } from './seed.js';
export type { SeedOptions } from './seed.js';

export { fromObject, fromUrl, fromEventSource, pollSource } from './adapters/index.js';
export type { GraphSource } from './adapters/index.js';

export type {
  Graph,
  GraphEdge,
  GraphNode,
  GraphMeta,
  EdgeMetrics,
  EdgeKind,
  NodeKind,
  ResolvedGraph,
  ResolvedEdge,
  ResolvedNode,
} from './types.js';

// Atlas: the map-style navigator for large estates.
export * from './atlas/index.js';
