// Web Audio engine.
//
// Design notes (post-Daniel-feedback):
//   • Two AnalyserNodes share the same source — `displayAnalyser` (smoothing 0.8)
//     for visually pleasing bars/waves, `beatAnalyser` (smoothing 0.08) for snappy
//     transient detection.
//   • fftSize 512 → ~11.6 ms FFT-window lag at 44.1 kHz (was 46 ms at 2048).
//   • File playback: pre-analyse the AudioBuffer with web-audio-beat-detector
//     `guess()` to recover {bpm, offset}. During playback, schedule beat flashes
//     against the audio element's currentTime (compensated for outputLatency).
//   • Mic input: no pre-buffer available — fall back to bass-band spectral flux.

import { guess } from 'web-audio-beat-detector';

export type InputSource = 'idle' | 'file' | 'mic';

export interface AudioFrame {
  freq: Uint8Array;
  time: Uint8Array;
  timeFloat: Float32Array;
  sampleRate: number;
  fftSize: number;
  beat: boolean;
  bpm: number;
  centroidHz: number;
  bands: { sub: number; bass: number; mid: number; treble: number };
  rms: number;
  flux: number;
}

const FFT_SIZE = 512;
const BEAT_FFT_SIZE = 512;
const DISPLAY_SMOOTHING = 0.8;
const BEAT_SMOOTHING = 0.08;
const FLUX_HISTORY_LEN = 50;
const BEAT_REFRACTORY_MS = 250;
const BEAT_BAND_LO_HZ = 30;
const BEAT_BAND_HI_HZ = 200;

interface BeatState {
  // real-time (mic) path
  prevSpectrum: Float32Array | null;
  fluxHistory: number[];
  lastBeatAt: number;
  // file (scheduled) path
  scheduled: { bpm: number; offset: number; lastIdx: number } | null;
  // shared
  bpm: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  displayAnalyser: AnalyserNode | null = null;
  beatAnalyser: AnalyserNode | null = null;
  gain: GainNode | null = null;
  source: AudioBufferSourceNode | MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null = null;
  audioEl: HTMLAudioElement | null = null;
  micStream: MediaStream | null = null;
  inputType: InputSource = 'idle';
  playing = false;
  micSensitivity = 0.5;
  smoothing = DISPLAY_SMOOTHING;
  freq = new Uint8Array(FFT_SIZE / 2);
  time = new Uint8Array(FFT_SIZE);
  timeFloat = new Float32Array(FFT_SIZE);
  beatFreq = new Uint8Array(BEAT_FFT_SIZE / 2);
  onAnalysisProgress: ((stage: 'decoding' | 'analyzing' | 'done' | 'failed') => void) | null = null;
  beatState: BeatState = { prevSpectrum: null, fluxHistory: [], lastBeatAt: 0, scheduled: null, bpm: 0 };

  ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;

      this.displayAnalyser = this.ctx.createAnalyser();
      this.displayAnalyser.fftSize = FFT_SIZE;
      this.displayAnalyser.smoothingTimeConstant = this.smoothing;
      this.displayAnalyser.minDecibels = -90;
      this.displayAnalyser.maxDecibels = -10;

      this.beatAnalyser = this.ctx.createAnalyser();
      this.beatAnalyser.fftSize = BEAT_FFT_SIZE;
      this.beatAnalyser.smoothingTimeConstant = BEAT_SMOOTHING;
      this.beatAnalyser.minDecibels = -90;
      this.beatAnalyser.maxDecibels = -10;

      this.gain.connect(this.displayAnalyser);
      this.gain.connect(this.beatAnalyser);
      this.displayAnalyser.connect(this.ctx.destination);
    }
  }

  setSmoothing(v: number) {
    this.smoothing = v;
    if (this.displayAnalyser) this.displayAnalyser.smoothingTimeConstant = v;
  }

  setMicSensitivity(v: number) {
    this.micSensitivity = v;
    if (this.inputType === 'mic') {
      const min = -90 + (1 - v) * 40;
      if (this.displayAnalyser) this.displayAnalyser.minDecibels = min;
      if (this.beatAnalyser) this.beatAnalyser.minDecibels = min;
    }
  }

  async loadFile(file: File) {
    this.ensureContext();
    if (!this.ctx || !this.gain) return;
    await this.stop();

    this.beatState = { prevSpectrum: null, fluxHistory: [], lastBeatAt: 0, scheduled: null, bpm: 0 };

    // Decode buffer for pre-analysis BEFORE attaching MediaElementSource.
    // (decodeAudioData consumes a fresh ArrayBuffer copy — does not interfere with the <audio> element.)
    this.onAnalysisProgress?.('decoding');
    let buffer: AudioBuffer | null = null;
    try {
      const arr = await file.arrayBuffer();
      buffer = await this.ctx.decodeAudioData(arr.slice(0));
    } catch (e) {
      console.warn('decodeAudioData failed:', e);
    }

    const url = URL.createObjectURL(file);
    const el = new Audio();
    el.src = url;
    el.crossOrigin = 'anonymous';
    el.loop = true;
    this.audioEl = el;
    const node = this.ctx.createMediaElementSource(el);
    node.connect(this.gain);
    this.source = node;
    this.inputType = 'file';
    if (this.displayAnalyser) this.displayAnalyser.minDecibels = -90;
    if (this.beatAnalyser) this.beatAnalyser.minDecibels = -90;
    await this.ctx.resume();
    await el.play();
    this.playing = true;

    if (buffer) {
      this.onAnalysisProgress?.('analyzing');
      try {
        const { bpm, offset } = await guess(buffer);
        this.beatState.scheduled = { bpm, offset, lastIdx: -1 };
        this.beatState.bpm = bpm;
        console.info('[visualizer] beat schedule ready bpm=%s offset=%s period=%sms',
          bpm.toFixed(2), offset.toFixed(3), (60000 / bpm).toFixed(1));
        this.onAnalysisProgress?.('done');
      } catch (e) {
        console.warn('[visualizer] beat analysis failed:', e);
        this.onAnalysisProgress?.('failed');
      }
    } else {
      console.warn('[visualizer] no AudioBuffer — beat schedule unavailable, flash disabled for file mode');
      this.onAnalysisProgress?.('failed');
    }
  }

  async startMic() {
    this.ensureContext();
    if (!this.ctx || !this.gain || !this.displayAnalyser || !this.beatAnalyser) return;
    await this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.micStream = stream;
    const node = this.ctx.createMediaStreamSource(stream);
    // Don't route mic to destination — would create feedback.
    node.connect(this.displayAnalyser);
    node.connect(this.beatAnalyser);
    this.source = node;
    this.inputType = 'mic';
    this.beatState.scheduled = null;
    this.setMicSensitivity(this.micSensitivity);
    await this.ctx.resume();
    this.playing = true;
  }

  async togglePlay() {
    if (this.inputType === 'file' && this.audioEl) {
      if (this.audioEl.paused) { await this.audioEl.play(); this.playing = true; }
      else { this.audioEl.pause(); this.playing = false; }
    }
  }

  async stop() {
    if (this.audioEl) { try { this.audioEl.pause(); } catch {} this.audioEl = null; }
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
    this.inputType = 'idle';
    this.playing = false;
    this.beatState = { prevSpectrum: null, fluxHistory: [], lastBeatAt: 0, scheduled: null, bpm: 0 };
  }

  sample(now: number): AudioFrame | null {
    if (!this.displayAnalyser || !this.beatAnalyser || !this.ctx) return null;
    this.displayAnalyser.getByteFrequencyData(this.freq);
    this.displayAnalyser.getByteTimeDomainData(this.time);
    this.displayAnalyser.getFloatTimeDomainData(this.timeFloat);
    this.beatAnalyser.getByteFrequencyData(this.beatFreq);

    const sampleRate = this.ctx.sampleRate;
    const dispBins = this.freq.length;
    const beatBins = this.beatFreq.length;
    const nyquist = sampleRate / 2;

    let rms = 0;
    for (let i = 0; i < this.timeFloat.length; i++) rms += this.timeFloat[i] * this.timeFloat[i];
    rms = Math.sqrt(rms / this.timeFloat.length);

    // --- Beat detection ---
    // Hard split by input type. File mode ONLY uses the pre-computed schedule;
    // it never runs realtime flux, even if analysis failed (flash stays dark instead
    // of false-triggering on hi-hats / vocals). Mic mode is the only flux path.
    let beat = false;
    let flux = 0;
    const scheduled = this.beatState.scheduled;
    if (this.inputType === 'file') {
      if (scheduled && this.audioEl && this.playing) {
        // Sign convention (per Daniel): trigger flash slightly AHEAD of the scheduled audio
        // position so the user sees the flash at the same wall-clock instant they hear the beat.
        const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
        const t = this.audioEl.currentTime + latency;
        const period = 60 / scheduled.bpm;
        const elapsed = t - scheduled.offset;
        if (elapsed >= 0) {
          const idx = Math.floor(elapsed / period);
          if (idx > scheduled.lastIdx) {
            scheduled.lastIdx = idx;
            beat = true;
            if ((idx & 7) === 0) {
              console.debug('[visualizer] beat idx=%d audioT=%s nextAt=%s latency=%sms',
                idx, this.audioEl.currentTime.toFixed(3),
                (scheduled.offset + (idx + 1) * period).toFixed(3),
                (latency * 1000).toFixed(1));
            }
          }
        } else if (elapsed < -0.2) {
          // looped — reset
          scheduled.lastIdx = -1;
        }
      }
      // else: schedule not ready / unavailable → no flash this frame. Bars still animate.
    } else if (this.inputType === 'mic') {
      // Mic (realtime) path: bass-banded spectral flux on the snappy beatAnalyser.
      if (!this.beatState.prevSpectrum) this.beatState.prevSpectrum = new Float32Array(beatBins);
      const prev = this.beatState.prevSpectrum;
      const loBin = Math.max(1, Math.floor((BEAT_BAND_LO_HZ / nyquist) * beatBins));
      const hiBin = Math.min(beatBins, Math.ceil((BEAT_BAND_HI_HZ / nyquist) * beatBins));
      for (let i = 0; i < beatBins; i++) {
        if (i >= loBin && i < hiBin) {
          const diff = this.beatFreq[i] - prev[i];
          if (diff > 0) flux += diff;
        }
        prev[i] = this.beatFreq[i];
      }
      flux = flux / Math.max(1, hiBin - loBin);

      const hist = this.beatState.fluxHistory;
      hist.push(flux);
      if (hist.length > FLUX_HISTORY_LEN) hist.shift();
      let avg = 0;
      for (let i = 0; i < hist.length; i++) avg += hist[i];
      avg = avg / Math.max(1, hist.length);
      const threshold = avg * 1.55 + 1.2;

      if (flux > threshold && now - this.beatState.lastBeatAt > BEAT_REFRACTORY_MS) {
        beat = true;
        this.beatState.lastBeatAt = now;
      }
    }

    // --- Spectral centroid (display analyser) ---
    let weighted = 0, total = 0;
    for (let i = 0; i < dispBins; i++) {
      const mag = this.freq[i];
      const hz = (i / dispBins) * nyquist;
      weighted += hz * mag;
      total += mag;
    }
    const centroidHz = total > 0.0001 ? weighted / total : 0;

    const bandEnergy = (lo: number, hi: number) => {
      const loBin = Math.max(0, Math.floor((lo / nyquist) * dispBins));
      const hiBin = Math.min(dispBins, Math.ceil((hi / nyquist) * dispBins));
      let sum = 0;
      for (let i = loBin; i < hiBin; i++) sum += this.freq[i];
      return sum / Math.max(1, hiBin - loBin) / 255;
    };

    return {
      freq: this.freq,
      time: this.time,
      timeFloat: this.timeFloat,
      sampleRate,
      fftSize: FFT_SIZE,
      beat,
      bpm: this.beatState.bpm,
      centroidHz,
      bands: {
        sub: bandEnergy(20, 60),
        bass: bandEnergy(60, 250),
        mid: bandEnergy(250, 4000),
        treble: bandEnergy(4000, 16000),
      },
      rms,
      flux,
    };
  }

  getCaptureStream(): MediaStream | null {
    if (!this.ctx) return null;
    const dest = this.ctx.createMediaStreamDestination();
    if (this.displayAnalyser) this.displayAnalyser.connect(dest);
    return dest.stream;
  }
}
