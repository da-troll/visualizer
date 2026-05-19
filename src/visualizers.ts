import type { AudioFrame } from './audio';
import { hueFromHz, rgb, type Palette } from './palettes';

export type ModeId = 'bars' | 'wave' | 'spectrogram' | 'radial' | 'lissajous' | 'constellation' | 'particles';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  palette: Palette;
  frame: AudioFrame;
  now: number;
  beatFlash: number; // 0..1
  bandScale: { sub: number; bass: number; mid: number; treble: number }; // 0..2 multipliers
  scratch: ScratchState;
}

export interface ScratchState {
  spectrogram?: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; x: number; w: number; h: number };
  constellation?: { stars: { angle: number; r: number; bin: number }[]; bursts: { x: number; y: number; vx: number; vy: number; life: number }[] };
  particles?: { items: { x: number; y: number; vx: number; vy: number; life: number; hue: number; size: number }[] };
  radial?: { rotation: number };
  lissajous?: { trail: { x: number; y: number }[] };
}

const TWO_PI = Math.PI * 2;

function bandMultiplier(hz: number, bs: RenderContext['bandScale']): number {
  if (hz < 60) return bs.sub;
  if (hz < 250) return bs.bass;
  if (hz < 4000) return bs.mid;
  return bs.treble;
}


export function clearStage(rc: RenderContext) {
  const { ctx, w, h, palette, beatFlash } = rc;
  ctx.fillStyle = rgb(palette.bg, 1);
  ctx.fillRect(0, 0, w, h);
  if (beatFlash > 0) {
    ctx.fillStyle = rgb(palette.primary, Math.min(0.3, beatFlash * 0.3));
    ctx.fillRect(0, 0, w, h);
  }
}

export function drawBars(rc: RenderContext) {
  const { ctx, w, h, palette, frame } = rc;
  const bins = frame.freq;
  const nyquist = frame.sampleRate / 2;
  const binHz = nyquist / bins.length;
  const numBars = 64;
  const F_LO = 30;
  const F_HI = Math.min(16000, nyquist);
  const ratio = F_HI / F_LO;
  const barWPad = w * 0.05;
  const usableW = w - barWPad * 2;
  const barW = usableW / numBars * 0.78;
  const gap = usableW / numBars * 0.22;

  for (let i = 0; i < numBars; i++) {
    // Log-spaced frequency grouping — each bar covers a constant ratio of the spectrum.
    const hz0 = F_LO * Math.pow(ratio, i / numBars);
    const hz1 = F_LO * Math.pow(ratio, (i + 1) / numBars);
    const hzMid = Math.sqrt(hz0 * hz1); // geometric mean — log-space centre
    const bin0 = Math.max(1, Math.floor(hz0 / binHz));
    const bin1 = Math.min(bins.length, Math.ceil(hz1 / binHz));
    // If the bar spans 2+ bins, take MAX (preserves transients in wide treble bars).
    // If it spans <=1 bin, INTERPOLATE between adjacent bins at the bar's centre freq
    // — fixes the low-end staircase where many bars share the same bin.
    let amp: number;
    if (bin1 - bin0 >= 2) {
      let max = 0;
      for (let b = bin0; b < bin1; b++) if (bins[b] > max) max = bins[b];
      amp = max / 255;
    } else {
      const fbin = hzMid / binHz;
      const lo = Math.max(1, Math.min(bins.length - 1, Math.floor(fbin)));
      const hi = Math.min(bins.length - 1, lo + 1);
      const t = Math.max(0, Math.min(1, fbin - lo));
      amp = (bins[lo] * (1 - t) + bins[hi] * t) / 255;
    }
    const mul = bandMultiplier((hz0 + hz1) / 2, rc.bandScale);
    const hh = Math.pow(amp, 0.9) * mul * h * 0.78;

    const x = barWPad + i * (barW + gap);
    const y = h - hh;

    if (palette.chromatic) {
      const hue = hueFromHz((hz0 + hz1) / 2);
      ctx.fillStyle = `hsl(${hue}, 90%, ${40 + amp * 30}%)`;
      ctx.shadowColor = `hsla(${hue}, 95%, 60%, 0.7)`;
    } else {
      const t = i / numBars;
      const r = palette.primary[0] * (1 - t) + palette.secondary[0] * t;
      const g = palette.primary[1] * (1 - t) + palette.secondary[1] * t;
      const b = palette.primary[2] * (1 - t) + palette.secondary[2] * t;
      ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
      ctx.shadowColor = rgb([r, g, b], 0.7);
    }
    ctx.shadowBlur = 16 + amp * 24;
    const radius = Math.min(barW / 2, 6);
    roundedRect(ctx, x, y, barW, hh, radius);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (h < 2) { ctx.beginPath(); ctx.rect(x, y, w, Math.max(1, h)); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function drawWave(rc: RenderContext) {
  const { ctx, w, h, palette, frame } = rc;
  const time = frame.timeFloat;
  ctx.lineWidth = 3;
  ctx.strokeStyle = rgb(palette.primary, 1);
  ctx.shadowColor = rgb(palette.primary, 0.8);
  ctx.shadowBlur = 22;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(time.length / w));
  for (let i = 0, x = 0; i < time.length; i += step, x = (i / time.length) * w) {
    const y = h / 2 + time[i] * h * 0.4;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Inner highlight
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgb(palette.accent, 0.8);
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

export function drawSpectrogram(rc: RenderContext) {
  const { ctx, w, h, palette, frame, scratch } = rc;
  if (!scratch.spectrogram || scratch.spectrogram.w !== w || scratch.spectrogram.h !== h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cctx = c.getContext('2d')!;
    cctx.fillStyle = rgb(palette.bg, 1);
    cctx.fillRect(0, 0, w, h);
    scratch.spectrogram = { canvas: c, ctx: cctx, x: 0, w, h };
  }
  const sp = scratch.spectrogram;
  // Scroll existing pixels left by 1
  sp.ctx.drawImage(sp.canvas, -1, 0);
  // Draw new column on the right
  const colX = w - 1;
  sp.ctx.fillStyle = rgb(palette.bg, 1);
  sp.ctx.fillRect(colX, 0, 1, h);
  const bins = frame.freq;
  // Display log-frequency, low freq at bottom
  const nyquist = frame.sampleRate / 2;
  for (let y = 0; y < h; y++) {
    const t = 1 - y / h; // 0 at bottom → 1 at top
    const hz = 20 * Math.pow(nyquist / 20, t);
    const bin = Math.min(bins.length - 1, Math.floor((hz / nyquist) * bins.length));
    const amp = bins[bin] / 255;
    if (amp < 0.04) continue;
    const lightness = Math.min(70, 8 + amp * 75);
    if (palette.chromatic) {
      sp.ctx.fillStyle = `hsl(${hueFromHz(hz)}, 95%, ${lightness}%)`;
    } else {
      const hue = palette.primary[0] === 240 ? 0 : Math.atan2(palette.secondary[1] - palette.primary[1], palette.secondary[0] - palette.primary[0]) * 180 / Math.PI;
      // Just use a fixed hue derived from accent for non-chromatic palettes
      const r = palette.primary[0] * amp + palette.bg[0] * (1 - amp);
      const g = palette.primary[1] * amp + palette.bg[1] * (1 - amp);
      const b = palette.primary[2] * amp + palette.bg[2] * (1 - amp);
      // Mix with secondary at high amp
      if (amp > 0.6) {
        const k = (amp - 0.6) / 0.4;
        sp.ctx.fillStyle = `rgb(${(r + (palette.secondary[0] - r) * k) | 0}, ${(g + (palette.secondary[1] - g) * k) | 0}, ${(b + (palette.secondary[2] - b) * k) | 0})`;
      } else {
        sp.ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      }
      void hue;
    }
    sp.ctx.fillRect(colX, y, 1, 1);
  }
  ctx.drawImage(sp.canvas, 0, 0);
}

export function drawRadial(rc: RenderContext) {
  const { ctx, w, h, palette, frame, scratch } = rc;
  const time = frame.timeFloat;
  if (!scratch.radial) scratch.radial = { rotation: 0 };
  scratch.radial.rotation += 0.0015 + frame.rms * 0.01;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(scratch.radial.rotation);
  const baseR = Math.min(w, h) * 0.22;
  const reach = Math.min(w, h) * 0.32;
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgb(palette.primary, 1);
  ctx.shadowColor = rgb(palette.primary, 0.7);
  ctx.shadowBlur = 18;
  ctx.beginPath();
  const N = Math.min(720, time.length);
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const angle = t * TWO_PI;
    const amp = time[Math.floor(t * time.length)];
    const r = baseR + amp * reach;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  // Inner ring
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgb(palette.accent, 0.4);
  ctx.beginPath();
  ctx.arc(0, 0, baseR, 0, TWO_PI);
  ctx.stroke();
  ctx.restore();
  ctx.shadowBlur = 0;
}

export function drawLissajous(rc: RenderContext) {
  const { ctx, w, h, palette, frame, scratch } = rc;
  if (!scratch.lissajous) scratch.lissajous = { trail: [] };
  const time = frame.timeFloat;
  const freq = frame.freq;
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * 0.4;
  // Use first half for X, second half for Y (mono-derived stereo)
  const trail = scratch.lissajous.trail;
  const samples = Math.min(700, time.length / 2);
  for (let i = 0; i < samples; i++) {
    const x = cx + time[i] * R;
    const y = cy + time[Math.floor(time.length / 2) + i] * R;
    trail.push({ x, y });
  }
  while (trail.length > 1400) trail.shift();
  ctx.lineWidth = 1.4;
  ctx.shadowBlur = 12;
  ctx.shadowColor = rgb(palette.primary, 0.8);
  ctx.beginPath();
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = palette.chromatic
    ? `hsl(${hueFromHz(frame.centroidHz)}, 90%, 60%)`
    : rgb(palette.primary, 0.85);
  ctx.stroke();
  ctx.shadowBlur = 0;
  void freq;
}

export function drawConstellation(rc: RenderContext) {
  const { ctx, w, h, palette, frame, scratch, beatFlash } = rc;
  if (!scratch.constellation) {
    const stars: { angle: number; r: number; bin: number }[] = [];
    const N = 256;
    for (let i = 0; i < N; i++) {
      // Pseudo-random fixed layout
      const a = (i * 137.508) % 360;
      const angle = (a / 360) * TWO_PI;
      const r = 0.18 + ((i * 33) % 100) / 100 * 0.58;
      stars.push({ angle, r, bin: Math.floor((i / N) * (frame.freq.length / 2)) });
    }
    scratch.constellation = { stars, bursts: [] };
  }
  const c = scratch.constellation;
  const cx = w / 2, cy = h / 2;
  const baseR = Math.min(w, h) * 0.5;
  for (const s of c.stars) {
    const amp = frame.freq[s.bin] / 255;
    const x = cx + Math.cos(s.angle) * s.r * baseR;
    const y = cy + Math.sin(s.angle) * s.r * baseR;
    const size = 0.8 + amp * 3.5;
    const alpha = 0.25 + amp * 0.75;
    ctx.fillStyle = palette.chromatic
      ? `hsla(${hueFromHz((s.bin / frame.freq.length) * frame.sampleRate / 2)}, 95%, 70%, ${alpha})`
      : rgb(palette.primary, alpha);
    ctx.shadowColor = ctx.fillStyle as string;
    ctx.shadowBlur = 4 + amp * 8;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, TWO_PI);
    ctx.fill();
  }
  // On beat, spawn bursts
  if (frame.beat) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TWO_PI;
      c.bursts.push({ x: cx, y: cy, vx: Math.cos(a) * (3 + Math.random() * 5), vy: Math.sin(a) * (3 + Math.random() * 5), life: 1 });
    }
  }
  // Draw + update bursts
  for (let i = c.bursts.length - 1; i >= 0; i--) {
    const b = c.bursts[i];
    b.x += b.vx; b.y += b.vy; b.life -= 0.025;
    if (b.life <= 0) { c.bursts.splice(i, 1); continue; }
    ctx.strokeStyle = rgb(palette.secondary, b.life);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(b.x - b.vx, b.y - b.vy);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  void beatFlash;
}

export function drawParticles(rc: RenderContext) {
  const { ctx, w, h, palette, frame, scratch } = rc;
  if (!scratch.particles) scratch.particles = { items: [] };
  const items = scratch.particles.items;

  // Spawn on transients (beat or strong flux)
  const spawn = frame.beat ? 60 : (frame.flux > 5 ? 12 : 2);
  for (let i = 0; i < spawn; i++) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
    const speed = 2 + Math.random() * 5 + frame.rms * 12;
    items.push({
      x: w * (0.1 + Math.random() * 0.8),
      y: h,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      life: 1,
      hue: palette.chromatic ? hueFromHz(frame.centroidHz) : -1,
      size: 1.5 + Math.random() * 2.5,
    });
  }
  while (items.length > 600) items.shift();

  for (let i = items.length - 1; i >= 0; i--) {
    const p = items[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.05; // mild gravity
    p.vx *= 0.99;
    p.life -= 0.012;
    if (p.life <= 0 || p.y > h + 20 || p.x < -20 || p.x > w + 20) { items.splice(i, 1); continue; }
    const a = Math.max(0, Math.min(1, p.life));
    if (p.hue >= 0) ctx.fillStyle = `hsla(${p.hue}, 95%, 65%, ${a})`;
    else ctx.fillStyle = rgb(palette.primary, a * 0.9);
    ctx.shadowColor = ctx.fillStyle as string;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TWO_PI);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

export const MODE_LIST: { id: ModeId; label: string }[] = [
  { id: 'bars', label: 'Bars' },
  { id: 'wave', label: 'Wave' },
  { id: 'spectrogram', label: 'Spectrogram' },
  { id: 'radial', label: 'Radial' },
  { id: 'lissajous', label: 'Lissajous' },
  { id: 'constellation', label: 'Constellation' },
  { id: 'particles', label: 'Particles' },
];

export function renderMode(mode: ModeId, rc: RenderContext) {
  if (mode !== 'spectrogram') clearStage(rc);
  // spectrogram clears its own pixels by scrolling
  switch (mode) {
    case 'bars': return drawBars(rc);
    case 'wave': return drawWave(rc);
    case 'spectrogram': return drawSpectrogram(rc);
    case 'radial': return drawRadial(rc);
    case 'lissajous': return drawLissajous(rc);
    case 'constellation': return drawConstellation(rc);
    case 'particles': return drawParticles(rc);
  }
}
