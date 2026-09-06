import { CHANNELS, type ChannelName } from './channels.js';
import { COMPONENTS } from './components.js';
import type { TableSchema } from './model.js';
import { isMeasure, type ChannelBinding, type ViewSpec } from './project.js';

/**
 * Composing the view with a model.
 *
 * The model never draws anything and never writes code. It selects from what is
 * already registered - node keys from the table's own dimensions, channels from
 * the registry, components from the component library - and emits a `ViewSpec`,
 * which is then validated field by field before it reaches the renderer. A
 * hallucinated channel or a dimension that does not exist is dropped, not
 * rendered. That containment is the whole reason this is safe to run every time
 * the user asks a question.
 *
 * **On model size.** Picking a node key and two or three channel bindings is
 * well within a small, fast model, and that is the common case. Composing a
 * whole world - tiers, per-engine components, what belongs on a gauge, what
 * clusters near what - is a design task, and small models are noticeably worse
 * at it: they bind high-cardinality dimensions to colour, put everything on one
 * tier, and ignore the ones that would have been informative. Pass a stronger
 * model for `world` composition and keep the small one for quick re-bindings.
 * `heuristicSpec` covers both with no model at all.
 */

export type Completion = (input: { system: string; user: string }) => Promise<string>;

export interface ProposeOptions {
  complete: Completion;
  schema: TableSchema;
  /** The spec being edited, so the model can make a small change rather than a new view. */
  current?: ViewSpec;
}

export interface ProposalResult {
  spec: ViewSpec;
  /** Everything that was corrected or dropped during validation. */
  issues: string[];
  source: 'model' | 'fallback';
  /** The raw model text, for debugging a bad proposal. */
  raw?: string;
}

/** Ask a model to compose the view, then validate whatever comes back. */
export async function proposeSpec(request: string, opts: ProposeOptions): Promise<ProposalResult> {
  const prompt = buildPrompt(request, opts.schema, opts.current);
  let raw: string;
  try {
    raw = await opts.complete(prompt);
  } catch (err) {
    return {
      spec: heuristicSpec(request, opts.schema, opts.current),
      issues: [`model call failed (${(err as Error).message}); used the built-in heuristic instead`],
      source: 'fallback',
    };
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return {
      spec: heuristicSpec(request, opts.schema, opts.current),
      issues: ['no JSON object found in the model response; used the built-in heuristic instead'],
      source: 'fallback',
      raw,
    };
  }

  const { spec, issues } = validateSpec(parsed, opts.schema);
  if (!spec.nodeKey.length) {
    const fallback = heuristicSpec(request, opts.schema, opts.current);
    return { spec: fallback, issues: [...issues, 'proposal had no usable node key'], source: 'fallback', raw };
  }
  return { spec, issues, source: 'model', raw };
}

export function buildPrompt(
  request: string,
  schema: TableSchema,
  current?: ViewSpec,
): { system: string; user: string } {
  const dims = schema.dimensions
    .map((d) => {
      const sample = d.values.slice(0, 6).join(', ');
      const where = [d.endpoint ? 'endpoint' : null, d.flow ? 'flow' : null].filter(Boolean).join('+');
      return `- ${d.name} (${d.cardinality} values, ${where}): ${sample}${d.truncated ? ', …' : ''}`;
    })
    .join('\n');

  const channels = (Object.keys(CHANNELS) as ChannelName[])
    .map((name) => {
      const c = CHANNELS[name];
      const cap = c.maxCardinality ? `, max ${c.maxCardinality} values` : '';
      return `- ${name} (${c.target}, takes a ${c.accepts}${cap}): ${c.summary}`;
    })
    .join('\n');

  const system = [
    'You configure a service-topology visualization by returning a JSON view spec.',
    'You never write code and never invent field names. Every field you use must appear in the schema below, and every channel must be one of the listed channels.',
    '',
    'Rules that matter:',
    '- nodeKey decides what a box is. Fewer dimensions means fewer, bigger boxes.',
    '- Binding a dimension to an edge channel splits edges by it, so only bind dimensions worth splitting on.',
    '- Never bind a high-cardinality dimension to hue, glyph, dash or lane; respect the stated maximums.',
    '- Prefer two or three channels. A picture encoding eight things communicates none of them.',
    '- Use mode "world" when the request is about seeing the system as a place, or mentions instances, capacity, CPU, memory, or shapes. Otherwise use "flat".',
    '- distance is a real channel: bind "share" (the fraction of a caller\'s traffic on an edge) so coupled services sit together, "rps" for raw volume, or a dimension so things sharing it cluster. Add "strength" (0-3) to dial it.',
    '- column arranges boxes left to right by a dimension; add "order" (a list of its values) to choose the sequence. halo can size by instances.',
    '',
    `Available world components: ${Object.keys(COMPONENTS).join(', ')}.`,
    '',
    'Reply with a single JSON object and nothing else.',
  ].join('\n');

  const user = [
    `Request: ${request}`,
    '',
    'Dimensions:',
    dims || '(none)',
    '',
    `Measures on flows: ${schema.measures.join(', ') || '(none)'}`,
    `Numeric attributes on things: ${schema.nodeAttrs.join(', ') || '(none)'}`,
    '',
    'Channels:',
    channels,
    '',
    current ? `Current spec (change as little as needed):\n${JSON.stringify(current, null, 2)}` : '',
    '',
    'Shape of the answer:',
    JSON.stringify(
      {
        nodeKey: ['service'],
        where: { env: ['prod'] },
        channels: { hue: { field: 'region' }, coupling: { field: 'failure' }, distance: { field: 'share' } },
        mode: 'world',
        world: { tierBy: 'kind', instances: 'instances', gauges: ['cpu', 'mem'] },
        title: 'one short sentence describing what this view shows',
      },
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/**
 * Validate a proposed spec against the table and the registry.
 *
 * Everything unrecognised is dropped with a reason rather than rejected whole:
 * a proposal that got four things right and one wrong is still worth rendering,
 * and the dropped item is reported so the user can see what happened.
 */
export function validateSpec(raw: unknown, schema: TableSchema): { spec: ViewSpec; issues: string[] } {
  const issues: string[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;
  const dimByName = new Map(schema.dimensions.map((d) => [d.name, d]));
  const known = (field: string): boolean =>
    dimByName.has(field) || schema.measures.includes(field) || schema.nodeAttrs.includes(field);

  const nodeKey: string[] = [];
  for (const k of asStringArray(input.nodeKey)) {
    const dim = dimByName.get(k);
    if (!dim) issues.push(`nodeKey: no dimension called "${k}"`);
    else if (!dim.endpoint) issues.push(`nodeKey: "${k}" is a flow dimension and cannot identify a node`);
    else nodeKey.push(k);
  }

  const where: Record<string, string[]> = {};
  for (const [field, values] of Object.entries(asRecord(input.where))) {
    const dim = dimByName.get(field);
    if (!dim) {
      issues.push(`where: no dimension called "${field}"`);
      continue;
    }
    const allowed = asStringArray(values).filter((v) => {
      const ok = !dim.truncated ? dim.values.includes(v) : true;
      if (!ok) issues.push(`where.${field}: "${v}" is not a value of that dimension`);
      return ok;
    });
    if (allowed.length) where[field] = allowed;
  }

  const channels: Record<string, ChannelBinding> = {};
  for (const [name, value] of Object.entries(asRecord(input.channels))) {
    const def = CHANNELS[name as ChannelName];
    if (!def) {
      issues.push(`channels: "${name}" is not a channel`);
      continue;
    }
    const binding = asRecord(value);
    const field = typeof binding.field === 'string' ? binding.field : typeof value === 'string' ? value : '';
    if (!field || !known(field)) {
      issues.push(`channels.${name}: no field called "${field || '(missing)'}"`);
      continue;
    }
    const measure = isMeasure(field) || schema.nodeAttrs.includes(field);
    if (def.accepts === 'measure' && !measure) {
      issues.push(`channels.${name}: needs a measure, but "${field}" is a dimension`);
      continue;
    }
    if (def.accepts === 'dimension' && measure) {
      issues.push(`channels.${name}: needs a dimension, but "${field}" is a measure`);
      continue;
    }
    const dim = dimByName.get(field);
    if (def.maxCardinality && dim && dim.cardinality > def.maxCardinality) {
      issues.push(
        `channels.${name}: "${field}" has ${dim.cardinality} values, more than ${name} can show (${def.maxCardinality})`,
      );
      continue;
    }
    const out: ChannelBinding = { field };
    if (binding.scale === 'log' || binding.scale === 'linear' || binding.scale === 'sqrt') out.scale = binding.scale;
    if (binding.invert === true) out.invert = true;
    if (typeof binding.strength === 'number' && Number.isFinite(binding.strength)) {
      out.strength = Math.max(0, Math.min(3, binding.strength));
    }
    const order = asStringArray(binding.order);
    if (order.length) out.order = order;
    const map = asRecord(binding.map);
    if (Object.keys(map).length) {
      out.map = Object.fromEntries(
        Object.entries(map).filter(([, v]) => typeof v === 'string') as [string, string][],
      );
    }
    channels[name] = out;
  }

  const spec: ViewSpec = { nodeKey };
  if (Object.keys(where).length) spec.where = where;
  if (Object.keys(channels).length) spec.channels = channels;
  if (input.mode === 'world' || input.mode === 'flat') spec.mode = input.mode;
  const layout = asRecord(input.layout);
  if (layout.rowSort === 'auto' || layout.rowSort === 'name' || layout.rowSort === 'traffic') spec.layout = { rowSort: layout.rowSort };
  if (typeof input.title === 'string') spec.title = input.title.slice(0, 160);
  if (input.dropSelfEdges === true) spec.dropSelfEdges = true;

  const killed = asStringArray(input.killed);
  if (killed.length) spec.killed = killed;

  const focus = asRecord(input.focus);
  const expandBy = asStringArray(focus.expandBy).filter((f) => dimByName.get(f)?.endpoint);
  const match = Object.fromEntries(
    Object.entries(asRecord(focus.match)).filter(([k, v]) => dimByName.has(k) && typeof v === 'string'),
  ) as Record<string, string>;
  if (expandBy.length && Object.keys(match).length) spec.focus = { match, expandBy };

  const world = asRecord(input.world);
  if (Object.keys(world).length) {
    const w: NonNullable<ViewSpec['world']> = {};
    if (typeof world.tierBy === 'string' && dimByName.has(world.tierBy)) w.tierBy = world.tierBy;
    else if (world.tierBy) issues.push(`world.tierBy: no dimension called "${String(world.tierBy)}"`);
    const tiers = asStringArray(world.tiers);
    if (tiers.length) w.tiers = tiers;
    if (typeof world.componentBy === 'string' && dimByName.has(world.componentBy)) w.componentBy = world.componentBy;
    const map = asRecord(world.componentMap);
    const componentMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'string' && COMPONENTS[v]) componentMap[k] = v;
      else issues.push(`world.componentMap.${k}: "${String(v)}" is not a registered component`);
    }
    if (Object.keys(componentMap).length) w.componentMap = componentMap;
    if (typeof world.instances === 'string' && schema.nodeAttrs.includes(world.instances)) w.instances = world.instances;
    const gauges = asStringArray(world.gauges).filter((g) => schema.nodeAttrs.includes(g));
    if (gauges.length) w.gauges = gauges.slice(0, 4);
    if (Object.keys(w).length) spec.world = w;
  }

  return { spec, issues };
}

/**
 * A deterministic reading of the request, used when no model is available and
 * as the floor under a bad proposal. Crude on purpose: it should never surprise
 * anyone, and it makes the tests reproducible.
 */
export function heuristicSpec(request: string, schema: TableSchema, current?: ViewSpec): ViewSpec {
  const q = request.toLowerCase();
  const has = (name: string): boolean => schema.dimensions.some((d) => d.name === name && d.endpoint);
  const dim = (name: string): boolean => schema.dimensions.some((d) => d.name === name);

  const nodeKey: string[] = [];
  if (has('region') && q.includes('region')) nodeKey.push('region');
  if (has('service')) nodeKey.push('service');
  if (has('api') && /\bapi|endpoint|route/.test(q)) nodeKey.push('api');
  if (!nodeKey.length) nodeKey.push(schema.dimensions.find((d) => d.endpoint)?.name ?? 'service');

  const channels: Record<string, ChannelBinding> = {};
  if (dim('failure') && /fail|blast|outage|kill|resilien|depend/.test(q)) channels.coupling = { field: 'failure' };
  if (dim('region') && !nodeKey.includes('region') && /region|geo|locality/.test(q)) channels.hue = { field: 'region' };
  else if (dim('env') && /env|prod|staging/.test(q)) channels.hue = { field: 'env' };
  if (/cluster|close|near|coupl|distance/.test(q)) {
    channels.distance = dim('team') && /team|owner/.test(q) ? { field: 'team' } : { field: /volume|rps|heavy/.test(q) ? 'rps' : 'share' };
  }
  if (/error|failing|5xx/.test(q)) channels.radius = { field: 'errorRate', scale: 'sqrt' };
  if (/slow|latency|p99/.test(q)) channels.speed = { field: 'latencyMs' };

  const spec: ViewSpec = { nodeKey };
  if (Object.keys(channels).length) spec.channels = channels;

  const wantsWorld = /world|3d|instance|capacity|cpu|memory|shape|machine|fleet/.test(q);
  if (wantsWorld) {
    spec.mode = 'world';
    spec.world = {
      ...(schema.nodeAttrs.includes('instances') ? { instances: 'instances' } : {}),
      gauges: ['cpu', 'mem'].filter((g) => schema.nodeAttrs.includes(g)),
    };
  } else if (current?.mode) {
    spec.mode = current.mode;
    if (current.world) spec.world = current.world;
  }

  const envDim = schema.dimensions.find((d) => d.name === 'env');
  if (envDim?.values.includes('prod') && /prod/.test(q)) spec.where = { env: ['prod'] };

  spec.title = request.slice(0, 160);
  return spec;
}

// --- parsing helpers -------------------------------------------------------

/** Pull the first balanced JSON object out of a model response, fences and all. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
