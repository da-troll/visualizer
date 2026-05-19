// Web Audio engine.
//
// Beat detection (post-Daniel-simplification): direct bass-bin onset detection
// on the display analyser. Same data that drives the leftmost bars also drives
// the flash — by construction the flash cannot trigger from hi-hats and is
// guaranteed in-sync with what's painted.

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

const FFT_SIZE = 2048;             // 21.5 Hz bins at 44.1 kHz
const DISPLAY_SMOOTHING = 0.8;
const DISPLAY_MIN_DB = -85;
const DISPLAY_MAX_DB = -25;
// Bass onset thresholds — bins 3..9 cover ~64–215 Hz at 44.1 kHz / fftSize 2048.
const BASS_BIN_LO = 3;
const BASS_BIN_HI = 10;
const BASS_ENERGY_TRIG = 0.55;
const BASS_RISE_TRIG = 0.12;
const REFRACTORY_MS = 250;

export class AudioEngine {
  ctx: AudioContext | null = null;
  displayAnalyser: AnalyserNode | null = null;
  gain: GainNode | null = null;
  hpf: BiquadFilterNode | null = null;
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

  // Bass-onset beat detector state
  private prevBassEnergy = 0;
  private refractoryUntil = 0;
  private bpmBeatTimes: number[] = [];
  private bpmEstimate = 0;

  ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;

      this.displayAnalyser = this.ctx.createAnalyser();
      this.displayAnalyser.fftSize = FFT_SIZE;
      this.displayAnalyser.smoothingTimeConstant = this.smoothing;
      this.displayAnalyser.minDecibels = DISPLAY_MIN_DB;
      this.displayAnalyser.maxDecibels = DISPLAY_MAX_DB;

      this.hpf = this.ctx.createBiquadFilter();
      this.hpf.type = 'highpass';
      this.hpf.frequency.value = 30;
      this.hpf.Q.value = 0.7;

      this.gain.connect(this.hpf);
      this.hpf.connect(this.displayAnalyser);
      this.displayAnalyser.connect(this.ctx.destination);
    }
  }

  setSmoothing(v: number) {
    this.smoothing = v;
    if (this.displayAnalyser) this.displayAnalyser.smoothingTimeConstant = v;
  }

  setMicSensitivity(v: number) {
    this.micSensitivity = v;
    if (this.inputType === 'mic' && this.displayAnalyser) {
      this.displayAnalyser.minDecibels = DISPLAY_MIN_DB + (1 - v) * 30;
    }
  }

  async loadFile(file: File) {
    this.ensureContext();
    if (!this.ctx || !this.gain) return;
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
    if (this.displayAnalyser) this.displayAnalyser.minDecibels = DISPLAY_MIN_DB;
    await this.ctx.resume();
    await el.play();
    this.playing = true;
  }

  async startMic() {
    this.ensureContext();
    if (!this.ctx || !this.gain || !this.displayAnalyser || !this.hpf) return;
    await this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.micStream = stream;
    const node = this.ctx.createMediaStreamSource(stream);
    // Mic mode bypasses gain → destination (avoids feedback) but still flows through HPF + analyser.
    node.connect(this.hpf);
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
    this.prevBassEnergy = 0;
    this.refractoryUntil = 0;
    this.bpmBeatTimes = [];
    this.bpmEstimate = 0;
  }

  sample(now: number): AudioFrame | null {
    if (!this.displayAnalyser || !this.ctx) return null;
    this.displayAnalyser.getByteFrequencyData(this.freq);
    this.displayAnalyser.getByteTimeDomainData(this.time);
    this.displayAnalyser.getFloatTimeDomainData(this.timeFloat);

    const sampleRate = this.ctx.sampleRate;
    const dispBins = this.freq.length;
    const nyquist = sampleRate / 2;

    let rms = 0;
    for (let i = 0; i < this.timeFloat.length; i++) rms += this.timeFloat[i] * this.timeFloat[i];
    rms = Math.sqrt(rms / this.timeFloat.length);

    // --- Bass-onset beat detection ---
    // Same bass bins that drive the leftmost bars; no separate analyser, no schedule.
    let bassMax = 0;
    for (let i = BASS_BIN_LO; i < BASS_BIN_HI; i++) {
      if (this.freq[i] > bassMax) bassMax = this.freq[i];
    }
    const bassEnergy = bassMax / 255;
    const bassRise = bassEnergy - this.prevBassEnergy;
    this.prevBassEnergy = bassEnergy;

    let beat = false;
    if (this.playing && bassEnergy > BASS_ENERGY_TRIG && bassRise > BASS_RISE_TRIG && now > this.refractoryUntil) {
      beat = true;
      this.refractoryUntil = now + REFRACTORY_MS;
      this.bpmBeatTimes.push(now);
      if (this.bpmBeatTimes.length > 9) this.bpmBeatTimes.shift();
      if (this.bpmBeatTimes.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < this.bpmBeatTimes.length; i++) intervals.push(this.bpmBeatTimes[i] - this.bpmBeatTimes[i - 1]);
        intervals.sort((a, b) => a - b);
        const median = intervals[Math.floor(intervals.length / 2)];
        if (median > 0) {
          let bpm = 60000 / median;
          while (bpm < 60) bpm *= 2;
          while (bpm > 200) bpm /= 2;
          this.bpmEstimate = this.bpmEstimate ? this.bpmEstimate * 0.7 + bpm * 0.3 : bpm;
        }
      }
    }

    // --- Spectral centroid ---
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
      bpm: this.bpmEstimate,
      centroidHz,
      bands: {
        sub: bandEnergy(20, 60),
        bass: bandEnergy(60, 250),
        mid: bandEnergy(250, 4000),
        treble: bandEnergy(4000, 16000),
      },
      rms,
      flux: bassRise,
    };
  }

  getCaptureStream(): MediaStream | null {
    if (!this.ctx) return null;
    const dest = this.ctx.createMediaStreamDestination();
    if (this.displayAnalyser) this.displayAnalyser.connect(dest);
    return dest.stream;
  }
}
