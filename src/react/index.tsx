import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { TraceLight, type HoverTarget, type TraceLightOptions } from '../renderer.js';
import type { GraphSource } from '../adapters/index.js';
import type { Graph } from '../types.js';

export interface TraceLightViewProps extends TraceLightOptions {
  /** A graph you already have. Ignored when `source` is given. */
  graph?: Graph;
  /** A source to load from, and subscribe to if it supports pushing. */
  source?: GraphSource;
  className?: string;
  style?: CSSProperties;
  onError?: (err: Error) => void;
}

/**
 * Thin React wrapper over {@link TraceLight}. The renderer owns the canvas and
 * the animation loop; React only owns the container, so re-renders never
 * restart the particle streams.
 */
export function TraceLightView({
  graph,
  source,
  className,
  style,
  onError,
  ...options
}: TraceLightViewProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<TraceLight | null>(null);
  const [current, setCurrent] = useState<Graph | undefined>(graph);

  // Create once.
  useEffect(() => {
    if (!ref.current) return;
    const tl = new TraceLight(ref.current, options);
    instance.current = tl;
    return () => {
      tl.destroy();
      instance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push option changes through without recreating.
  useEffect(() => {
    instance.current?.setOptions(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    options.theme,
    options.speed,
    options.animate,
    options.showEdgeLabels,
    options.showLegend,
  ]);

  useEffect(() => {
    if (graph) setCurrent(graph);
  }, [graph]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    source
      .load()
      .then((g) => !cancelled && setCurrent(g))
      .catch((err: Error) => onError?.(err));
    const unsubscribe = source.subscribe?.(
      (g) => !cancelled && setCurrent(g),
      (err) => onError?.(err),
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (!current || !instance.current) return;
    try {
      instance.current.setGraph(current);
    } catch (err) {
      onError?.(err as Error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ width: '100%', height: '100%', minHeight: 320, ...style }}
    />
  );
}

export type { HoverTarget, TraceLightOptions };
export { TraceLight };

// --- Atlas ---------------------------------------------------------------------

import { Atlas, type AtlasOptions, type LensName } from '../atlas/atlas.js';
import type { AtlasState } from '../atlas/model.js';
import type { FlowTable } from '../model.js';

export interface AtlasViewProps extends Omit<AtlasOptions, 'lens'> {
  /** The flow table. A new object updates in place: the view keeps its expansion, focus and camera. */
  table: FlowTable;
  lens?: LensName;
  /** Initial view state; later changes are applied with `setState`. */
  state?: Partial<AtlasState>;
  /** Access to the instance for imperative calls (goTo, walk, setTrail, ...). */
  onReady?: (atlas: Atlas) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * React wrapper over {@link Atlas}. Same contract as {@link TraceLightView}:
 * the renderer owns the canvas and the loop; React owns the container.
 */
export function AtlasView({ table, lens, state, onReady, className, style, ...options }: AtlasViewProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<Atlas | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (!ref.current) return;
    const atlas = new Atlas(ref.current, { ...options, ...(lens ? { lens } : {}) });
    instance.current = atlas;
    atlas.setTable(table);
    if (state) atlas.setState(state, state.focus ? `ego:${state.focus}` : undefined);
    onReady?.(atlas);
    first.current = false;
    return () => {
      atlas.destroy();
      instance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (first.current) return;
    instance.current?.update(table);
  }, [table]);

  useEffect(() => {
    if (lens) instance.current?.setLens(lens);
  }, [lens]);

  useEffect(() => {
    if (first.current || !state) return;
    instance.current?.setState(state);
  }, [state]);

  useEffect(() => {
    if (options.theme) instance.current?.setTheme(options.theme);
  }, [options.theme]);

  return <div ref={ref} className={className} style={{ width: '100%', height: '100%', minHeight: 320, ...style }} />;
}

export type { AtlasOptions, AtlasState, LensName };
export { Atlas };
