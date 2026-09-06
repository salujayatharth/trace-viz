import type { Graph } from '../types.js';

/**
 * A source of graphs.
 *
 * `load()` is the only required method, which is what makes today's static
 * JSON and tomorrow's live feed the same thing to the renderer. A source that
 * can push updates implements `subscribe`; one that cannot is polled by
 * {@link pollSource}. Nothing in the renderer knows the difference.
 */
export interface GraphSource {
  readonly name: string;
  load(): Promise<Graph>;
  /** Push updates. Return an unsubscribe function. */
  subscribe?(onGraph: (graph: Graph) => void, onError?: (err: Error) => void): () => void;
  close?(): void;
}

/** A graph you already have in memory. */
export function fromObject(graph: Graph, name = 'inline'): GraphSource {
  return { name, load: async () => graph };
}

/** Fetch a JSON document. Add `pollMs` and it becomes a (crude) live source. */
export function fromUrl(
  url: string,
  { pollMs, fetchOptions }: { pollMs?: number; fetchOptions?: RequestInit } = {},
): GraphSource {
  const load = async (): Promise<Graph> => {
    const res = await fetch(url, fetchOptions);
    if (!res.ok) throw new Error(`tracelight: ${url} responded ${res.status}`);
    return (await res.json()) as Graph;
  };
  const source: GraphSource = { name: url, load };
  if (pollMs && pollMs > 0) {
    source.subscribe = (onGraph, onError) => pollSource(source, pollMs, onGraph, onError);
  }
  return source;
}

/**
 * Server-sent events carrying one JSON graph per message. This is the intended
 * shape of the live mode: the server decides the aggregation window, the client
 * just redraws.
 */
export function fromEventSource(url: string): GraphSource {
  let es: EventSource | undefined;
  return {
    name: url,
    load: () =>
      new Promise<Graph>((resolve, reject) => {
        const once = new EventSource(url);
        once.onmessage = (ev) => {
          once.close();
          try {
            resolve(JSON.parse(ev.data) as Graph);
          } catch (err) {
            reject(err as Error);
          }
        };
        once.onerror = () => {
          once.close();
          reject(new Error(`tracelight: event source ${url} failed`));
        };
      }),
    subscribe(onGraph, onError) {
      es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          onGraph(JSON.parse(ev.data) as Graph);
        } catch (err) {
          onError?.(err as Error);
        }
      };
      es.onerror = () => onError?.(new Error(`tracelight: event source ${url} failed`));
      return () => es?.close();
    },
    close: () => es?.close(),
  };
}

/** Turn any `load()`-only source into a pushing one. */
export function pollSource(
  source: GraphSource,
  intervalMs: number,
  onGraph: (graph: Graph) => void,
  onError?: (err: Error) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async (): Promise<void> => {
    try {
      const g = await source.load();
      if (!stopped) onGraph(g);
    } catch (err) {
      if (!stopped) onError?.(err as Error);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
