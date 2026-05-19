import type { ModeId } from './visualizers';

export interface PermalinkState {
  mode: ModeId;
  palette: string;
  aspect: string;
  response: number;
  sub: number; bass: number; mid: number; treble: number;
}

export function encodeHash(s: PermalinkState): string {
  const json = JSON.stringify(s);
  return '#v=' + btoa(json).replace(/=+$/, '');
}

export function decodeHash(hash: string): PermalinkState | null {
  if (!hash || !hash.startsWith('#v=')) return null;
  try {
    const b64 = hash.slice(3);
    const json = atob(b64 + '==='.slice((b64.length + 3) % 4));
    return JSON.parse(json);
  } catch {
    return null;
  }
}
