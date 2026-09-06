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
