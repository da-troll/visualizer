import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine, type AudioFrame } from './audio';
import { MODE_LIST, type ModeId, renderMode, type ScratchState, type RenderContext } from './visualizers';
import { PALETTES, PALETTE_BY_ID, lerpPalette, rgb, type Palette } from './palettes';
import { encodeHash, decodeHash } from './permalink';

type Aspect = '16:9' | '1:1' | '9:16' | '4:5';
const ASPECTS: Aspect[] = ['16:9', '1:1', '9:16', '4:5'];
const ASPECT_RATIO: Record<Aspect, number> = { '16:9': 16 / 9, '1:1': 1, '9:16': 9 / 16, '4:5': 4 / 5 };

interface TrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
}

const DEFAULT_BAND_SCALE = { sub: 1, bass: 1, mid: 1, treble: 1 };

function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const scratchRef = useRef<ScratchState>({});
  const rafRef = useRef<number | null>(null);
  const lastBeatRef = useRef<number>(0);
  const paletteCurrentRef = useRef<Palette>(PALETTES[0]);
  const paletteTargetRef = useRef<Palette>(PALETTES[0]);
  const paletteLerpRef = useRef<number>(1);
  const idleTimerRef = useRef<number | null>(null);

  const [mode, setMode] = useState<ModeId>('bars');
  const [paletteId, setPaletteId] = useState<string>('trollspace');
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [response, setResponse] = useState(0.78); // smoothingTimeConstant
  const [bandScale, setBandScale] = useState({ ...DEFAULT_BAND_SCALE });
  const [bandsOpen, setBandsOpen] = useState(false);
  const [meta, setMeta] = useState<TrackMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [inputType, setInputType] = useState<'idle' | 'file' | 'mic'>('idle');
  const [micSens, setMicSens] = useState(0.6);
  const [bpm, setBpm] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [recordingProgress, setRecordingProgress] = useState<number | null>(null);
  const [frameDims, setFrameDims] = useState<{ w: number; h: number }>({ w: 800, h: 450 });

  // Restore from URL hash on mount
  useEffect(() => {
    const s = decodeHash(window.location.hash);
    if (s) {
      if (s.mode) setMode(s.mode);
      if (s.palette && PALETTE_BY_ID[s.palette]) setPaletteId(s.palette);
      if (s.aspect && ASPECTS.includes(s.aspect as Aspect)) setAspect(s.aspect as Aspect);
      if (typeof s.response === 'number') setResponse(s.response);
      if (s.sub != null) setBandScale({ sub: s.sub, bass: s.bass, mid: s.mid, treble: s.treble });
      paletteCurrentRef.current = PALETTE_BY_ID[s.palette] || PALETTES[0];
      paletteTargetRef.current = paletteCurrentRef.current;
    }
  }, []);

  useEffect(() => { engine.setSmoothing(response); }, [response, engine]);
  useEffect(() => { engine.setMicSensitivity(micSens); }, [micSens, engine]);

  // Resize handling for canvas aspect ratio
  useEffect(() => {
    const fit = () => {
      const stage = frameRef.current?.parentElement;
      if (!stage) return;
      const pad = 32;
      const availW = stage.clientWidth - pad;
      const availH = stage.clientHeight - pad;
      const target = ASPECT_RATIO[aspect];
      let w = availW;
      let h = w / target;
      if (h > availH) { h = availH; w = h * target; }
      w = Math.max(120, Math.floor(w));
      h = Math.max(120, Math.floor(h));
      setFrameDims({ w, h });
      scratchRef.current = {}; // reset scratch so spectrogram regenerates at new size
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (frameRef.current?.parentElement) ro.observe(frameRef.current.parentElement);
    window.addEventListener('resize', fit);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [aspect]);

  // Update URL hash when state changes
  useEffect(() => {
    const s = { mode, palette: paletteId, aspect, response, ...bandScale };
    const h = encodeHash(s);
    if (window.location.hash !== h) {
      history.replaceState(null, '', window.location.pathname + window.location.search + h);
    }
  }, [mode, paletteId, aspect, response, bandScale]);

  // Palette transition
  useEffect(() => {
    paletteTargetRef.current = PALETTE_BY_ID[paletteId];
    paletteLerpRef.current = 0;
  }, [paletteId]);

  // Render loop
  useEffect(() => {
    let last = performance.now();
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dt = now - last;
      last = now;

      // Palette lerp at ~500ms
      if (paletteLerpRef.current < 1) {
        paletteLerpRef.current = Math.min(1, paletteLerpRef.current + dt / 500);
        const cur = paletteCurrentRef.current;
        const tgt = paletteTargetRef.current;
        paletteCurrentRef.current = lerpPalette(cur, tgt, paletteLerpRef.current === 1 ? 1 : 0.2);
        if (paletteLerpRef.current >= 1) paletteCurrentRef.current = tgt;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = frameDims.w;
      const cssH = frameDims.h;
      const targetW = cssW * dpr;
      const targetH = cssH * dpr;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        scratchRef.current = {};
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const frame: AudioFrame | null = engine.sample(now);
      if (!frame) {
        ctx.fillStyle = rgb(paletteCurrentRef.current.bg, 1);
        ctx.fillRect(0, 0, cssW, cssH);
        return;
      }
      if (frame.beat) lastBeatRef.current = now;
      const beatFlash = Math.max(0, 1 - (now - lastBeatRef.current) / 80);
      if (frame.bpm !== bpm) setBpm(frame.bpm);

      const rc: RenderContext = {
        ctx,
        w: cssW,
        h: cssH,
        palette: paletteCurrentRef.current,
        frame,
        now,
        beatFlash,
        bandScale,
        scratch: scratchRef.current,
      };
      renderMode(mode, rc);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [mode, frameDims, bandScale, engine, bpm]);

  // File drop handler
  useEffect(() => {
    const stage = frameRef.current?.parentElement;
    if (!stage) return;
    const onDragOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
    const onDragLeave = () => setDragOver(false);
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFile(f);
    };
    stage.addEventListener('dragover', onDragOver);
    stage.addEventListener('dragleave', onDragLeave);
    stage.addEventListener('drop', onDrop);
    return () => {
      stage.removeEventListener('dragover', onDragOver);
      stage.removeEventListener('dragleave', onDragLeave);
      stage.removeEventListener('drop', onDrop);
    };
  }, []);

  const loadFile = useCallback(async (file: File) => {
    try {
      await engine.loadFile(file);
      setPlaying(true);
      setInputType('file');
      // Extract ID3 with jsmediatags
      try {
        const jsmediatags = (await import('jsmediatags')).default;
        jsmediatags.read(file, {
          onSuccess: (r) => {
            const t = r.tags;
            let cover: string | undefined;
            if (t.picture) {
              const { data, format } = t.picture;
              const bytes = new Uint8Array(data);
              const blob = new Blob([bytes], { type: format });
              cover = URL.createObjectURL(blob);
            }
            setMeta({
              title: t.title || file.name.replace(/\.[^.]+$/, ''),
              artist: t.artist || 'Unknown artist',
              album: t.album,
              cover,
            });
          },
          onError: () => {
            setMeta({ title: file.name.replace(/\.[^.]+$/, ''), artist: 'Unknown artist' });
          },
        });
      } catch {
        setMeta({ title: file.name.replace(/\.[^.]+$/, ''), artist: 'Unknown artist' });
      }
    } catch (e) {
      showToast('Could not load audio: ' + (e as Error).message);
    }
  }, [engine]);

  const onFileInput: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
    e.target.value = '';
  };

  const toggleMic = useCallback(async () => {
    if (inputType === 'mic') {
      await engine.stop();
      setInputType('idle');
      setPlaying(false);
      setMeta(null);
      return;
    }
    try {
      await engine.startMic();
      setInputType('mic');
      setPlaying(true);
      setMeta({ title: 'Microphone', artist: 'Live input' });
    } catch (e) {
      showToast('Microphone access denied');
    }
  }, [inputType, engine]);

  const togglePlay = useCallback(async () => {
    if (inputType === 'file') {
      await engine.togglePlay();
      setPlaying(engine.playing);
    }
  }, [inputType, engine]);

  // Fullscreen
  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Idle controls
  useEffect(() => {
    const onMove = () => {
      setIdle(false);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setIdle(true), 10000);
    };
    onMove();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchstart', onMove);
    window.addEventListener('keydown', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchstart', onMove);
      window.removeEventListener('keydown', onMove);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key >= '1' && e.key <= '7') {
        const idx = parseInt(e.key, 10) - 1;
        if (MODE_LIST[idx]) setMode(MODE_LIST[idx].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen, togglePlay]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }

  const downloadPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `visualizer-${ts}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }, []);

  const recordLoop = useCallback(async () => {
    if (recordingProgress !== null) return;
    if (inputType === 'idle') { showToast('Load audio or enable mic first'); return; }

    // Offscreen 9:16 canvas
    const ow = 1080;
    const oh = 1920;
    const off = document.createElement('canvas');
    off.width = ow; off.height = oh;
    const offCtx = off.getContext('2d')!;

    const audioStream = engine.getCaptureStream();
    const videoStream = off.captureStream(60);
    if (audioStream) {
      audioStream.getAudioTracks().forEach(t => videoStream.addTrack(t));
    }

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    const rec = new MediaRecorder(videoStream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const localScratch: ScratchState = {};
    let stopAt = 0;
    const start = performance.now();
    const tick = () => {
      const now = performance.now();
      const t = (now - start) / 5000;
      setRecordingProgress(Math.min(1, t));
      if (t >= 1) {
        rec.stop();
        return;
      }
      const frame = engine.sample(now);
      if (frame) {
        const rc: RenderContext = {
          ctx: offCtx,
          w: ow, h: oh,
          palette: paletteCurrentRef.current,
          frame,
          now,
          beatFlash: frame.beat ? 1 : Math.max(0, 1 - (now - lastBeatRef.current) / 80),
          bandScale,
          scratch: localScratch,
        };
        renderMode(mode, rc);
      }
      stopAt = requestAnimationFrame(tick);
    };

    rec.onstop = () => {
      cancelAnimationFrame(stopAt);
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = url;
      a.download = `visualizer-loop-${ts}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setRecordingProgress(null);
      showToast('Loop exported');
    };

    rec.start();
    requestAnimationFrame(tick);
  }, [bandScale, engine, inputType, mode, recordingProgress]);

  const copyShareLink = useCallback(() => {
    const url = window.location.href;
    navigator.clipboard?.writeText(url).then(
      () => showToast('Link copied'),
      () => showToast('Copy failed'),
    );
  }, []);

  const palettePreview = (p: Palette) => ({
    background: `conic-gradient(${rgb(p.primary)} 0deg 120deg, ${rgb(p.secondary)} 120deg 240deg, ${rgb(p.accent)} 240deg 360deg)`,
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className={`app ${isFullscreen ? 'fullscreen' : ''} ${idle && isFullscreen ? 'idle' : ''} ${dragOver ? 'drag-over' : ''}`}>
      <div className="stage">
        <div
          ref={frameRef}
          className="stage-frame"
          style={{ width: frameDims.w, height: frameDims.h }}
          onClick={() => inputType === 'file' && togglePlay()}
        >
          <canvas ref={canvasRef} />
          {inputType !== 'idle' && meta && (
            <div className="track-card">
              {meta.cover ? <img src={meta.cover} alt="" /> : <div style={{ width: 44, height: 44, borderRadius: 6, background: 'rgba(255,255,255,0.08)' }} />}
              <div className="meta">
                <div className="title">{meta.title || 'Untitled'}</div>
                <div className="artist">{meta.artist || 'Unknown'}</div>
              </div>
            </div>
          )}
          {inputType !== 'idle' && (
            <div className="bpm-badge">
              <div className="big">{bpm > 0 ? bpm.toFixed(0) : '—'}</div>
              <div className="label">BPM</div>
            </div>
          )}
          {inputType === 'idle' && (
            <div className="dropzone-hint">
              <h1>Visualizer</h1>
              <p>Drag an audio file anywhere · or <span className="accent">click ↓ Load</span></p>
              <p style={{ marginTop: 8, fontSize: 11 }}>or use the microphone</p>
            </div>
          )}
          {recordingProgress !== null && (
            <div className="recording-bar"><div style={{ transform: `scaleX(${recordingProgress})` }} /></div>
          )}
        </div>
      </div>

      <div className="controls">
        <div className="row">
          <div className="mode-strip">
            {MODE_LIST.map(m => (
              <button key={m.id} data-active={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
          <div className="sep" />
          <div className="palette-strip">
            {PALETTES.map(p => (
              <button
                key={p.id}
                className="palette-chip"
                title={p.name}
                data-active={paletteId === p.id}
                style={palettePreview(p)}
                onClick={() => setPaletteId(p.id)}
              />
            ))}
          </div>
          <div className="sep" />
          <div className="row" style={{ gap: 4 }}>
            {ASPECTS.map(a => (
              <button key={a} data-active={aspect === a} onClick={() => setAspect(a)} style={{ fontSize: 11, padding: '4px 7px' }}>{a}</button>
            ))}
          </div>
          <div className="grow" />
          <button onClick={toggleFullscreen} title="Toggle fullscreen (F)" className="icon-btn">⛶ {isFullscreen ? 'Exit' : 'Fullscreen'}</button>
        </div>

        <div className="row">
          <input ref={fileInputRef} type="file" accept="audio/*" onChange={onFileInput} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current?.click()} className="icon-btn">↓ Load audio</button>
          {inputType === 'file' && (
            <button onClick={togglePlay} className="icon-btn">{playing ? '⏸ Pause' : '▶ Play'}</button>
          )}
          <button onClick={toggleMic} data-active={inputType === 'mic'} className="icon-btn">🎙 {inputType === 'mic' ? 'Stop mic' : 'Mic'}</button>
          {inputType === 'mic' && (
            <div className="slider-cell" style={{ minWidth: 140 }}>
              <label>Sensitivity <span className="val">{Math.round(micSens * 100)}%</span></label>
              <input type="range" min={0} max={1} step={0.01} value={micSens} onChange={e => setMicSens(parseFloat(e.target.value))} />
            </div>
          )}
          <div className="sep" />
          <div className="slider-cell">
            <label>Response <span className="val">{response.toFixed(2)}</span></label>
            <input type="range" min={0.4} max={0.95} step={0.01} value={response} onChange={e => setResponse(parseFloat(e.target.value))} />
          </div>
          <div className="grow" />
          <button onClick={downloadPng} className="icon-btn" title="Save PNG screenshot">🖼 PNG</button>
          <button onClick={recordLoop} className="icon-btn" disabled={recordingProgress !== null || inputType === 'idle'} title="Record 5s WebM 9:16 loop">
            {recordingProgress !== null ? `Recording ${Math.round(recordingProgress * 100)}%` : '⏺ Loop 9:16'}
          </button>
          <button onClick={copyShareLink} className="icon-btn" title="Copy shareable link">🔗 Copy link</button>
          <button className="collapse-toggle" onClick={() => setBandsOpen(o => !o)}>{bandsOpen ? '▾ Bands' : '▸ Bands'}</button>
        </div>

        {bandsOpen && (
          <div className="bands">
            <BandSlider label="Sub 20–60 Hz" value={bandScale.sub} onChange={v => setBandScale(s => ({ ...s, sub: v }))} />
            <BandSlider label="Bass 60–250 Hz" value={bandScale.bass} onChange={v => setBandScale(s => ({ ...s, bass: v }))} />
            <BandSlider label="Mid 250 Hz–4 kHz" value={bandScale.mid} onChange={v => setBandScale(s => ({ ...s, mid: v }))} />
            <BandSlider label="Treble 4 kHz+" value={bandScale.treble} onChange={v => setBandScale(s => ({ ...s, treble: v }))} />
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function BandSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="slider-cell">
      <label>{label} <span className="val">{value.toFixed(2)}×</span></label>
      <input type="range" min={0} max={2} step={0.01} value={value} onChange={e => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

export default App;
