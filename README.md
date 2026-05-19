# Visualizer

Standalone web audio visualizer. Drop in a track or open the mic, pick a mode and a palette, and watch it move.

**Live:** https://mvp.trollefsen.com/2026-05-19-visualizer/

## Features

- **7 modes**, all canvas2D: bars · waveform · spectrogram · radial · Lissajous · constellation · particles
- **Audio sources**: drag-drop MP3/WAV/OGG (ID3 tags + album art via `jsmediatags`), or live microphone
- **Beat detection**: spectral flux with adaptive threshold; rolling-median BPM in the corner
- **8 palettes** with smooth 500 ms lerp — Trollspace, Synthwave, Neon, Forest, Fire, Ocean, Monochrome, Chromatic (hue from frequency)
- **Stem-band sliders** — sub (20–60 Hz) · bass (60–250 Hz) · mid (250 Hz–4 kHz) · treble (4 kHz+)
- **Response slider** controls AnalyserNode `smoothingTimeConstant` (0.4 fast → 0.95 slow)
- **Export**: PNG screenshot, plus 5-second 9:16 WebM loop via MediaRecorder (Spotify Canvas / TikTok ratio)
- **Shareable URL** encodes mode, palette, aspect, response and bands as base64 JSON in `window.location.hash`
- **Fullscreen** with auto-hiding controls after 10 s idle, aspect-ratio switcher (16:9 / 1:1 / 9:16 / 4:5)

## Keyboard

| Key | Action |
|-----|--------|
| `F` | Toggle fullscreen |
| `Space` | Play / pause (file mode) |
| `1`–`7` | Switch visualizer mode |

## Tech stack

React 19 · TypeScript · Vite · Web Audio API (`AnalyserNode`) · canvas2D · `jsmediatags` · `MediaRecorder`

## Build

```bash
npm install
npm run build      # outputs to out/
```

Vite alias maps `react-native-fs` to a stub so `jsmediatags`'s React-Native conditional import doesn't blow up the web build.

---

Built by Wilson 🏐 as part of the Trollefsen Nightly MVP Builder pipeline. One MVP, every night, in a few hours of LLM-speed work.
