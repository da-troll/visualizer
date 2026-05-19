// Web Audio engine: input routing, analysis, beat detection, BPM, spectral centroid.

export type InputSource = 'idle' | 'file' | 'mic';

export interface AudioFrame {
  freq: Uint8Array;         // 0-255 amplitude per bin
  time: Uint8Array;         // 0-255 waveform sample, 128 = silence
  timeFloat: Float32Array;  // -1..1 waveform sample
  sampleRate: number;
  fftSize: number;
  beat: boolean;
  bpm: number;
  centroidHz: number;
  bands: { sub: number; bass: number; mid: number; treble: number };
  rms: number;
  flux: number;
}

interface BeatState {
  prevSpectrum: Float32Array | null;
  fluxHistory: number[];
  beatTimes: number[];
  lastBeatAt: number;
  bpm: number;
}

const FFT_SIZE = 2048;
const FLUX_HISTORY_LEN = 43; // ~1 second at 44.1kHz / 1024 hop
const BEAT_HISTORY_LEN = 8;

export class AudioEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  gain: GainNode | null = null;
  source: AudioBufferSourceNode | MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null = null;
  audioEl: HTMLAudioElement | null = null;
  micStream: MediaStream | null = null;
  inputType: InputSource = 'idle';
  playing = false;
  micSensitivity = 0.5; // 0..1, maps to minDecibels
  smoothing = 0.78;
  freq = new Uint8Array(FFT_SIZE / 2);
  time = new Uint8Array(FFT_SIZE);
  timeFloat = new Float32Array(FFT_SIZE);
  freqFloat = new Float32Array(FFT_SIZE / 2);
  beatState: BeatState = { prevSpectrum: null, fluxHistory: [], beatTimes: [], lastBeatAt: 0, bpm: 0 };

  ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = this.smoothing;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -10;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
  }

  setSmoothing(v: number) {
    this.smoothing = v;
    if (this.analyser) this.analyser.smoothingTimeConstant = v;
  }

  setMicSensitivity(v: number) {
    this.micSensitivity = v;
    if (this.analyser && this.inputType === 'mic') {
      // higher sensitivity = wider dynamic range → lower minDecibels
      this.analyser.minDecibels = -90 + (1 - v) * 40; // -90 to -50
    }
  }

  async loadFile(file: File) {
    this.ensureContext();
    if (!this.ctx || !this.analyser || !this.gain) return;
    await this.stop();
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
    this.analyser.minDecibels = -90;
    await this.ctx.resume();
    await el.play();
    this.playing = true;
  }

  async startMic() {
    this.ensureContext();
    if (!this.ctx || !this.analyser || !this.gain) return;
    await this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.micStream = stream;
    const node = this.ctx.createMediaStreamSource(stream);
    // Don't connect mic to destination — feedback. Tap analyser directly.
    node.connect(this.analyser);
    this.source = node;
    this.inputType = 'mic';
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
    this.beatState = { prevSpectrum: null, fluxHistory: [], beatTimes: [], lastBeatAt: 0, bpm: 0 };
  }

  sample(now: number): AudioFrame | null {
    if (!this.analyser || !this.ctx) return null;
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);
    this.analyser.getFloatTimeDomainData(this.timeFloat);
    this.analyser.getFloatFrequencyData(this.freqFloat);

    const sampleRate = this.ctx.sampleRate;
    const bins = this.freq.length;
    const nyquist = sampleRate / 2;

    // RMS
    let rms = 0;
    for (let i = 0; i < this.timeFloat.length; i++) rms += this.timeFloat[i] * this.timeFloat[i];
    rms = Math.sqrt(rms / this.timeFloat.length);

    // Spectral flux (positive differences on linear magnitude)
    let flux = 0;
    const cur = this.freq;
    if (!this.beatState.prevSpectrum) this.beatState.prevSpectrum = new Float32Array(bins);
    const prev = this.beatState.prevSpectrum;
    for (let i = 0; i < bins; i++) {
      const diff = cur[i] - prev[i];
      if (diff > 0) flux += diff;
      prev[i] = cur[i];
    }
    flux = flux / bins;

    // Adaptive threshold via rolling average
    const hist = this.beatState.fluxHistory;
    hist.push(flux);
    if (hist.length > FLUX_HISTORY_LEN) hist.shift();
    let avg = 0;
    for (let i = 0; i < hist.length; i++) avg += hist[i];
    avg = avg / Math.max(1, hist.length);
    const threshold = avg * 1.55 + 0.5;

    let beat = false;
    if (flux > threshold && now - this.beatState.lastBeatAt > 220) {
      beat = true;
      this.beatState.lastBeatAt = now;
      this.beatState.beatTimes.push(now);
      if (this.beatState.beatTimes.length > BEAT_HISTORY_LEN + 1) this.beatState.beatTimes.shift();
      // BPM = median of intervals
      const times = this.beatState.beatTimes;
      if (times.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
        intervals.sort((a, b) => a - b);
        const median = intervals[Math.floor(intervals.length / 2)];
        if (median > 0) {
          let bpm = 60000 / median;
          while (bpm < 60) bpm *= 2;
          while (bpm > 200) bpm /= 2;
          // Light smoothing
          this.beatState.bpm = this.beatState.bpm ? this.beatState.bpm * 0.7 + bpm * 0.3 : bpm;
        }
      }
    }

    // Spectral centroid
    let weighted = 0, total = 0;
    for (let i = 0; i < bins; i++) {
      const mag = cur[i];
      const hz = (i / bins) * nyquist;
      weighted += hz * mag;
      total += mag;
    }
    const centroidHz = total > 0.0001 ? weighted / total : 0;

    // Band energies (normalized 0..1)
    const bandEnergy = (lo: number, hi: number) => {
      const loBin = Math.max(0, Math.floor((lo / nyquist) * bins));
      const hiBin = Math.min(bins, Math.ceil((hi / nyquist) * bins));
      let sum = 0;
      for (let i = loBin; i < hiBin; i++) sum += cur[i];
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

  /**
   * Returns an output node we can hand to MediaRecorder for capture.
   * Splits off the analyser output (audio is already routed to destination separately for file mode).
   */
  getCaptureStream(): MediaStream | null {
    if (!this.ctx) return null;
    const dest = this.ctx.createMediaStreamDestination();
    if (this.analyser) this.analyser.connect(dest);
    return dest.stream;
  }
}
