import type { EdgeKind, NodeKind } from './types.js';

export interface Theme {
  name: string;
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  grid: string;
  /** Colour of a healthy particle, per edge kind. */
  flow: Record<EdgeKind, string>;
  /** Node fill, per node kind. */
  node: Record<NodeKind, string>;
  nodeText: string;
  edge: string;
  edgeMuted: string;
  error: string;
  highlight: string;
  tooltipBg: string;
  tooltipText: string;
}

/**
 * Two palettes, same semantics. Hues are kept distinguishable under the common
 * forms of colour-vision deficiency: the request/retry split leans on
 * blue-vs-amber rather than red-vs-green, and errors carry a shape cue (a
 * hollow ring) in addition to colour.
 */
export const darkTheme: Theme = {
  name: 'dark',
  background: '#0e1117',
  surface: '#161b23',
  border: '#2a323d',
  text: '#e6edf3',
  textMuted: '#8b98a8',
  grid: '#1b222c',
  flow: {
    request: '#5aa9ff',
    response: '#4ad6b8',
    retry: '#ffb54d',
    challenge: '#c58bff',
    async: '#7f8fa6',
  },
  node: {
    client: '#2d3b52',
    gateway: '#3a3350',
    service: '#233145',
    datastore: '#1f3d3a',
    cache: '#40352a',
    queue: '#33304a',
    external: '#2b2f36',
  },
  nodeText: '#e6edf3',
  edge: '#55637a',
  edgeMuted: '#2c3541',
  error: '#ff6b6b',
  highlight: '#ffffff',
  tooltipBg: '#1c232d',
  tooltipText: '#e6edf3',
};

export const lightTheme: Theme = {
  name: 'light',
  background: '#fbfbfd',
  surface: '#ffffff',
  border: '#dfe3ea',
  text: '#1a1f27',
  textMuted: '#616c7d',
  grid: '#eef1f5',
  flow: {
    request: '#1f6feb',
    response: '#0d9488',
    retry: '#d97706',
    challenge: '#8b5cf6',
    async: '#64748b',
  },
  node: {
    client: '#e7edf9',
    gateway: '#eee9fb',
    service: '#eaf1fb',
    datastore: '#e4f4f0',
    cache: '#fcf1e2',
    queue: '#eeecfa',
    external: '#eef0f3',
  },
  nodeText: '#1a1f27',
  edge: '#9aa8ba',
  edgeMuted: '#d5dce6',
  error: '#dc2626',
  highlight: '#0b1220',
  tooltipBg: '#1c232d',
  tooltipText: '#f5f7fa',
};

export const themes = { dark: darkTheme, light: lightTheme } as const;

export function resolveTheme(t: 'auto' | 'light' | 'dark' | Theme | undefined): Theme {
  if (t && typeof t === 'object') return t;
  if (t === 'light') return lightTheme;
  if (t === 'dark') return darkTheme;
  const prefersDark =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? darkTheme : lightTheme;
}
