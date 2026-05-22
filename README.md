<div align="center">

<pre>
██╗░░░██╗██╗███████╗██╗░░░██╗░█████╗░██╗░░░░░░░░░███████╗██╗░░░░░██╗░░░██╗██╗░░██╗
██║░░░██║██║██╔════╝██║░░░██║██╔══██╗██║░░░░░░░░░██╔════╝██║░░░░░██║░░░██║╚██╗██╔╝
██║░░░██║██║███████╗██║░░░██║███████║██║░░░░░░░░░█████╗░░██║░░░░░██║░░░██║░╚███╔╝░
╚██╗░██╔╝██║╚════██║██║░░░██║██╔══██║██║░░░░░░░░░██╔══╝░░██║░░░░░██║░░░██║░██╔██╗░
░╚████╔╝░██║███████║╚██████╔╝██║░░██║███████╗░░░░██║░░░░░███████╗╚██████╔╝██╔╝░██╗
░░╚═══╝░░╚═╝╚══════╝░╚═════╝░╚═╝░░╚═╝╚══════╝░░░░╚═╝░░░░░╚══════╝░╚═════╝░╚═╝░░╚═╝
</pre>

**S E E &nbsp; T H E &nbsp; S O U N D**

</div>

A standalone web audio visualizer. Drop in a track or open the mic, pick a mode and a palette, watch it move. Seven canvas2D modes, eight palettes, spectral-flux beat detection with rolling-median BPM, and one-click 9:16 WebM loop export for Spotify Canvas / TikTok. No backend, no install — runs entirely in the browser.

**Live:** <https://mvp.trollefsen.com/2026-05-19-visualizer/>

## Project structure

```
.
├── index.html                            # Vite entry — sets <title>, mounts #root
├── package.json
├── vite.config.ts                        # base + react-native-fs alias for jsmediatags's RN conditional
├── public/
│   ├── favicon.svg
│   └── icons.svg                         # Inline-SVG sprite sheet used by the controls
└── src/
    ├── main.tsx                          # React entry — bootstraps <App>
    ├── App.tsx                           # Render loop, controls, export pipeline, fullscreen wiring
    ├── audio.ts                          # AudioContext + AnalyserNode graph; mic vs file source
    ├── visualizers.ts                    # 7 render modes — bars, waveform, spectrogram, radial, Lissajous, constellation, particles
    ├── palettes.ts                       # 8 palettes + chromatic hue-from-frequency mode
    ├── permalink.ts                      # Encode/decode mode+palette+aspect+bands into a base64 URL hash
    ├── index.css                         # Global resets
    ├── jsmediatags.d.ts                  # Ambient types for jsmediatags (no upstream types)
    └── stubs/
        └── empty.ts                      # Vite alias stub so jsmediatags's react-native-fs import builds for web
```

## Features

- **7 modes**, all canvas2D — bars · waveform · spectrogram · radial · Lissajous · constellation · particles
- **Audio sources** — drag-drop MP3/WAV/OGG (ID3 tags + album art via `jsmediatags`), or live microphone
- **Beat detection** — spectral flux with adaptive threshold; rolling-median BPM in the corner
- **8 palettes** with smooth 500 ms lerp — Trollspace, Synthwave, Neon, Forest, Fire, Ocean, Monochrome, Chromatic (hue from frequency)
- **Stem-band sliders** — sub (20–60 Hz) · bass (60–250 Hz) · mid (250 Hz–4 kHz) · treble (4 kHz+)
- **Response slider** — controls AnalyserNode `smoothingTimeConstant` (0.4 fast → 0.95 slow)
- **Export** — PNG screenshot + 5-second 9:16 WebM loop via MediaRecorder (Spotify Canvas / TikTok ratio)
- **Shareable URL** — mode, palette, aspect, response, and bands encoded as base64 JSON in `window.location.hash`
- **Fullscreen** with auto-hiding controls after 10 s idle, aspect-ratio switcher (16:9 / 1:1 / 9:16 / 4:5)

## Keyboard

| Key | Action |
|-----|--------|
| `F` | Toggle fullscreen |
| `Space` | Play / pause (file mode) |
| `1`–`7` | Switch visualizer mode |

## Build

```bash
npm install
npm run dev        # local dev server with HMR
npm run build      # outputs to out/
```

The Vite alias maps `react-native-fs` to a no-op stub so `jsmediatags`'s React-Native conditional import doesn't blow up the web build.

## Tech stack

React 19 · TypeScript · Vite · Web Audio API (`AnalyserNode`) · canvas2D · `jsmediatags` · `MediaRecorder`

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
