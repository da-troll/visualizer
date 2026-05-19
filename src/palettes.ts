export type RGB = [number, number, number];

export interface Palette {
  id: string;
  name: string;
  bg: RGB;
  primary: RGB;
  secondary: RGB;
  accent: RGB;
  chromatic?: boolean;
}

export const PALETTES: Palette[] = [
  { id: 'trollspace', name: 'Trollspace', bg: [15, 17, 23], primary: [255, 171, 0], secondary: [255, 0, 170], accent: [255, 230, 120] },
  { id: 'synthwave',  name: 'Synthwave',  bg: [12, 8, 32],  primary: [255, 60, 200], secondary: [120, 60, 255], accent: [80, 230, 255] },
  { id: 'neon',       name: 'Neon',       bg: [4, 8, 14],   primary: [80, 220, 255], secondary: [120, 255, 60], accent: [255, 230, 60] },
  { id: 'forest',     name: 'Forest',     bg: [8, 14, 10],  primary: [120, 200, 80], secondary: [240, 180, 60], accent: [220, 240, 180] },
  { id: 'fire',       name: 'Fire',       bg: [16, 6, 4],   primary: [255, 80, 40],  secondary: [255, 180, 40], accent: [255, 240, 200] },
  { id: 'ocean',      name: 'Ocean',      bg: [4, 12, 22],  primary: [60, 160, 240], secondary: [80, 230, 220], accent: [220, 240, 255] },
  { id: 'monochrome', name: 'Monochrome', bg: [10, 10, 10], primary: [240, 240, 240], secondary: [160, 160, 160], accent: [255, 255, 255] },
  { id: 'chromatic',  name: 'Chromatic',  bg: [8, 8, 16],   primary: [255, 60, 60], secondary: [60, 60, 255], accent: [255, 255, 255], chromatic: true },
];

export const PALETTE_BY_ID = Object.fromEntries(PALETTES.map(p => [p.id, p])) as Record<string, Palette>;

export function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  return {
    id: b.id, name: b.name,
    bg: lerpRGB(a.bg, b.bg, t),
    primary: lerpRGB(a.primary, b.primary, t),
    secondary: lerpRGB(a.secondary, b.secondary, t),
    accent: lerpRGB(a.accent, b.accent, t),
    chromatic: b.chromatic,
  };
}

export function rgb(c: RGB, alpha = 1): string {
  return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${alpha})`;
}

export function hueFromHz(hz: number): number {
  // Map 20Hz - 20kHz log to 0-360
  const lo = Math.log2(20);
  const hi = Math.log2(20000);
  const t = Math.max(0, Math.min(1, (Math.log2(Math.max(20, hz)) - lo) / (hi - lo)));
  return t * 320; // stop short of red wraparound
}
