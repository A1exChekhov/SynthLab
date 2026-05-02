"use client";

let ctx: AudioContext | null = null;
let activeOscillators: OscillatorNode[] = [];
let activeGains: GainNode[] = [];
let activeNodes: AudioNode[] = [];
let activeStopTimer: ReturnType<typeof setTimeout> | null = null;

// Global Reverb Bus
let globalReverbInMix: GainNode | null = null;
let globalReverbWetGain: GainNode | null = null;
let globalReverbDryGain: GainNode | null = null;
let currentReverbConfigString: string = "";

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function isAudioSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.AudioContext || (window as any).webkitAudioContext);
}

// ── Types ─────────────────────────────────────────────────────────

export type Harmonic = {
  multiple: number;
  gainRatio: number;
  waveform?: OscillatorType;
  attackSec?: number;
  decaySec?: number;      // New: for bell-like hits
  sustainRatio?: number;  // New: 0 to 1
  releaseSec?: number;
  wobbleHz?: number;          // LFO Rate: 0 = off, 0.01–8 Hz
  wobbleDepthCents?: number;  // LFO Depth in cents (pitch modulation)
  detuneCentsRange?: number;
  absoluteHz?: number;
  pan?: number;
};

export type NoiseBurst = {
  type: "white" | "pink";
  attackSec: number;
  decaySec: number;
  bandpassHz?: number;
  gain: number;
};

export type ReverbConfig = {
  wet: number;
  decaySec: number;
  preDelayMs: number;
};

export type RepeatConfig = {
  enabled: boolean;
  intervalSec: number;
  count?: number;
  timingJitterSec?: number;
  gainJitter?: number;
  alternatePan?: boolean;
  doubleStrike?: {
    enabled: boolean;
    delaySec: number;
    gain: number;
  };
};

export type SynthPreset = {
  name?: string;
  baseHz?: number;
  masterVolume?: number;
  waveform: OscillatorType;
  harmonics: Harmonic[];
  auxTones?: Harmonic[];
  attackSec: number;
  decaySec?: number;
  sustainRatio?: number;
  releaseSec: number;
  lowpassHz?: number;
  highpassHz?: number;
  stereoSpread?: number;
  noiseBurst?: NoiseBurst;
  reverb?: ReverbConfig;
  repeat?: RepeatConfig;
  sampleUrl?: string;
  sampleHz?: number;
  sampleLoop?: boolean;
};

// ── Preset Library ────────────────────────────────────────────────

export const PRESETS: Record<string, SynthPreset> = {
  crystal_bowl: {
    name: "Crystal Bowl",
    baseHz: 126.22,
    waveform: "sine",
    harmonics: [
      { multiple: 1.000, gainRatio: 1.00, detuneCentsRange: 3, decaySec: 10.0, sustainRatio: 0 },
      { multiple: 2.003, gainRatio: 0.30, detuneCentsRange: 5, wobbleHz: 0.04, wobbleDepthCents: 3, decaySec: 7.0, sustainRatio: 0 },
      { multiple: 3.012, gainRatio: 0.12, detuneCentsRange: 5, wobbleHz: 0.03, wobbleDepthCents: 2, decaySec: 4.0, sustainRatio: 0 },
      { multiple: 4.023, gainRatio: 0.05, detuneCentsRange: 5, decaySec: 2.0, sustainRatio: 0 },
    ],
    attackSec: 0.7,
    decaySec: 10.0,
    sustainRatio: 0,
    releaseSec: 2.0,
    stereoSpread: 0.2,
    lowpassHz: 6000,
    reverb: { wet: 0.3, decaySec: 5.0, preDelayMs: 18 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08, alternatePan: true, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  tibetan_bowl: {
    name: "Tibetan Singing Bowl",
    baseHz: 210.42,
    waveform: "sine",
    harmonics: [
      { multiple: 1.000, gainRatio: 1.00, detuneCentsRange: 4, wobbleHz: 0.05, wobbleDepthCents: 4, decaySec: 8.0, sustainRatio: 0 },
      { multiple: 2.020, gainRatio: 0.55, detuneCentsRange: 6, wobbleHz: 0.04, wobbleDepthCents: 3, decaySec: 5.0, sustainRatio: 0 },
      { multiple: 3.011, gainRatio: 0.30, detuneCentsRange: 6, wobbleHz: 0.03, wobbleDepthCents: 2, decaySec: 3.0, sustainRatio: 0 },
      { multiple: 4.045, gainRatio: 0.18, detuneCentsRange: 6, wobbleHz: 0.04, wobbleDepthCents: 2, decaySec: 1.5, sustainRatio: 0 },
    ],
    attackSec: 0.8,
    decaySec: 8.0,
    sustainRatio: 0,
    releaseSec: 3.0,
    lowpassHz: 5000,
    stereoSpread: 0.3,
    reverb: { wet: 0.28, decaySec: 4.5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 7, timingJitterSec: 0.5, gainJitter: 0.1, alternatePan: false, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  bells: {
    name: "Bells",
    baseHz: 141.27,
    waveform: "sine",
    harmonics: [
      { multiple: 8.72, gainRatio: 0.22, attackSec: 0.001, decaySec: 4.8, sustainRatio: 0, detuneCentsRange: -2, pan: -0.35 },
      { multiple: 11.93, gainRatio: 0.17, attackSec: 0.001, decaySec: 5.6, sustainRatio: 0, detuneCentsRange: 3, pan: 0.30 },
      { multiple: 15.84, gainRatio: 0.12, attackSec: 0.001, decaySec: 3.8, sustainRatio: 0, detuneCentsRange: -4, pan: -0.15 },
      { multiple: 21.70, gainRatio: 0.075, attackSec: 0.001, decaySec: 2.6, sustainRatio: 0, detuneCentsRange: 5, pan: 0.40 },
      { multiple: 29.60, gainRatio: 0.045, attackSec: 0.001, decaySec: 1.6, sustainRatio: 0, detuneCentsRange: -6, pan: -0.45 },
      { multiple: 41.20, gainRatio: 0.026, attackSec: 0.001, decaySec: 0.9, sustainRatio: 0, detuneCentsRange: 4, pan: 0.50 },
      { multiple: 56.80, gainRatio: 0.014, attackSec: 0.001, decaySec: 0.45, sustainRatio: 0, detuneCentsRange: -5, pan: -0.55 },
    ],
    attackSec: 0.001,
    decaySec: 2.8,
    sustainRatio: 0,
    releaseSec: 0.15,
    highpassHz: 850,
    lowpassHz: 14000,
    stereoSpread: 0.55,
    masterVolume: 1.0,
    noiseBurst: { type: "pink", attackSec: 0.001, decaySec: 0.035, bandpassHz: 5200, gain: 0.035 },
    reverb: { wet: 0.38, decaySec: 5.5, preDelayMs: 22 },
    repeat: { enabled: true, intervalSec: 5.5, timingJitterSec: 0.35, gainJitter: 0.1, alternatePan: true, doubleStrike: { enabled: true, delaySec: 0.13, gain: 0.5 } },
  },
  dramyen: {
    name: "Dramyen (Dra-nyen)",
    baseHz: 221.23,
    waveform: "triangle",
    harmonics: [
      { multiple: 1.0, gainRatio: 1.00, detuneCentsRange: 3, decaySec: 3.5, sustainRatio: 0 },
      { multiple: 2.0, gainRatio: 0.45, detuneCentsRange: 4, decaySec: 2.0, sustainRatio: 0 },
      { multiple: 3.0, gainRatio: 0.22, detuneCentsRange: 5, decaySec: 1.0, sustainRatio: 0 },
      { multiple: 4.0, gainRatio: 0.10, detuneCentsRange: 5, decaySec: 0.5, sustainRatio: 0 },
      { multiple: 5.0, gainRatio: 0.05, detuneCentsRange: 5, decaySec: 0.3, sustainRatio: 0 },
    ],
    attackSec: 0.02,
    decaySec: 3.5,
    sustainRatio: 0,
    releaseSec: 1.2,
    lowpassHz: 6000,
    stereoSpread: 0.3,
    noiseBurst: { type: "pink", attackSec: 0.005, decaySec: 0.04, bandpassHz: 3000, gain: 0.02 },
    reverb: { wet: 0.22, decaySec: 3.5, preDelayMs: 15 },
    repeat: { enabled: true, intervalSec: 4, timingJitterSec: 0.6, gainJitter: 0.12, alternatePan: true, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  drum: {
    name: "Drum",
    baseHz: 144.72,
    waveform: "sine",
    harmonics: [
      { multiple: 1.00, gainRatio: 1.00, decaySec: 0.9, sustainRatio: 0 },
      { multiple: 1.59, gainRatio: 0.50, decaySec: 0.45, sustainRatio: 0 },
      { multiple: 2.14, gainRatio: 0.30, decaySec: 0.22, sustainRatio: 0 },
    ],
    attackSec: 0.005,
    decaySec: 0.9,
    sustainRatio: 0,
    releaseSec: 0.4,
    lowpassHz: 900,
    noiseBurst: { type: "white", attackSec: 0.001, decaySec: 0.06, bandpassHz: 800, gain: 0.07 },
    repeat: { enabled: true, intervalSec: 3, timingJitterSec: 0.25, gainJitter: 0.15, alternatePan: true, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  monastery: {
    name: "Monastery Orchestra",
    baseHz: 183.58,
    waveform: "sine",
    harmonics: [
      { multiple: 1.000, gainRatio: 0.90, detuneCentsRange: 8, wobbleHz: 0.05, wobbleDepthCents: 5, decaySec: 10.0, sustainRatio: 0 },
      { multiple: 1.340, gainRatio: 0.65, detuneCentsRange: 8, wobbleHz: 0.04, wobbleDepthCents: 4, decaySec: 8.0, sustainRatio: 0 },
      { multiple: 2.130, gainRatio: 0.45, detuneCentsRange: 10, wobbleHz: 0.03, wobbleDepthCents: 3, decaySec: 5.0, sustainRatio: 0 },
      { multiple: 3.180, gainRatio: 0.30, detuneCentsRange: 10, decaySec: 3.0, sustainRatio: 0 },
      { multiple: 4.50, gainRatio: 0.15, detuneCentsRange: 12, decaySec: 1.5, sustainRatio: 0 },
    ],
    attackSec: 0.3,
    decaySec: 10.0,
    sustainRatio: 0,
    releaseSec: 3.5,
    stereoSpread: 0.5,
    lowpassHz: 4000,
    reverb: { wet: 0.42, decaySec: 7.0, preDelayMs: 30 },
    noiseBurst: { type: "pink", attackSec: 0.02, decaySec: 0.15, bandpassHz: 900, gain: 0.04 },
    repeat: { enabled: true, intervalSec: 9, timingJitterSec: 0.8, gainJitter: 0.1, alternatePan: false, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  dungchen: {
    name: "Dungchen",
    baseHz: 147.85,
    waveform: "sawtooth",
    harmonics: [
      { multiple: 1.0, gainRatio: 1.00, detuneCentsRange: 6, wobbleHz: 0.04, wobbleDepthCents: 4, decaySec: 6.0, sustainRatio: 0 },
      { multiple: 2.0, gainRatio: 0.55, detuneCentsRange: 8, wobbleHz: 0.03, wobbleDepthCents: 3, decaySec: 5.0, sustainRatio: 0 },
      { multiple: 3.0, gainRatio: 0.30, detuneCentsRange: 8, decaySec: 3.0, sustainRatio: 0 },
      { multiple: 4.0, gainRatio: 0.15, detuneCentsRange: 10, decaySec: 1.5, sustainRatio: 0 },
    ],
    attackSec: 0.5,
    decaySec: 6.0,
    sustainRatio: 0,
    releaseSec: 2.0,
    lowpassHz: 3500,
    stereoSpread: 0.35,
    reverb: { wet: 0.32, decaySec: 5.0, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 10, timingJitterSec: 1.0, gainJitter: 0.08, alternatePan: false, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  synthesizer: {
    name: "Synthesizer",
    baseHz: 207.36,
    waveform: "sine",
    harmonics: [
      { multiple: 1.0, gainRatio: 1.00, detuneCentsRange: 2, decaySec: 5.0, sustainRatio: 0 },
      { multiple: 2.0, gainRatio: 0.35, detuneCentsRange: 3, decaySec: 3.5, sustainRatio: 0 },
      { multiple: 3.0, gainRatio: 0.18, detuneCentsRange: 4, decaySec: 2.0, sustainRatio: 0 },
      { multiple: 4.5, gainRatio: 0.08, detuneCentsRange: 5, decaySec: 1.0, sustainRatio: 0 },
    ],
    attackSec: 0.1,
    decaySec: 5.0,
    sustainRatio: 0,
    releaseSec: 1.5,
    lowpassHz: 8000,
    highpassHz: 80,
    stereoSpread: 0.4,
    reverb: { wet: 0.25, decaySec: 4.0, preDelayMs: 15 },
    repeat: { enabled: true, intervalSec: 6, timingJitterSec: 0.5, gainJitter: 0.1, alternatePan: true, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  lingm: {
    name: "Lingm (Glingbu)",
    baseHz: 211.44,
    waveform: "sine",
    harmonics: [
      { multiple: 1.0, gainRatio: 1.00, detuneCentsRange: 2, decaySec: 3.0, sustainRatio: 0 },
      { multiple: 2.0, gainRatio: 0.40, detuneCentsRange: 3, decaySec: 2.0, sustainRatio: 0 },
      { multiple: 3.0, gainRatio: 0.20, detuneCentsRange: 4, decaySec: 1.0, sustainRatio: 0 },
      { multiple: 4.0, gainRatio: 0.08, detuneCentsRange: 5, decaySec: 0.5, sustainRatio: 0 },
    ],
    attackSec: 0.08,
    decaySec: 3.0,
    sustainRatio: 0,
    releaseSec: 1.0,
    lowpassHz: 7000,
    highpassHz: 200,
    stereoSpread: 0.25,
    noiseBurst: { type: "white", attackSec: 0.01, decaySec: 0.03, bandpassHz: 5000, gain: 0.025 },
    reverb: { wet: 0.2, decaySec: 3.0, preDelayMs: 10 },
    repeat: { enabled: true, intervalSec: 5, timingJitterSec: 0.4, gainJitter: 0.1, alternatePan: true, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  gong: {
    name: "Gong",
    baseHz: 140.64,
    waveform: "sine",
    harmonics: [
      { multiple: 1.00, gainRatio: 0.85, detuneCentsRange: 8, decaySec: 12.0, sustainRatio: 0 },
      { multiple: 1.34, gainRatio: 0.65, detuneCentsRange: 8, wobbleHz: 0.04, wobbleDepthCents: 3, decaySec: 9.0, sustainRatio: 0 },
      { multiple: 2.13, gainRatio: 0.50, detuneCentsRange: 10, wobbleHz: 0.03, wobbleDepthCents: 2, decaySec: 6.0, sustainRatio: 0 },
      { multiple: 2.97, gainRatio: 0.40, detuneCentsRange: 10, decaySec: 4.0, sustainRatio: 0 },
      { multiple: 4.21, gainRatio: 0.30, detuneCentsRange: 12, decaySec: 2.0, sustainRatio: 0 },
    ],
    attackSec: 0.05,
    decaySec: 12.0,
    sustainRatio: 0,
    releaseSec: 4.5,
    lowpassHz: 3500,
    stereoSpread: 0.5,
    reverb: { wet: 0.35, decaySec: 6.0, preDelayMs: 25 },
    noiseBurst: { type: "white", attackSec: 0.01, decaySec: 0.1, bandpassHz: 1200, gain: 0.05 },
    repeat: { enabled: true, intervalSec: 12, timingJitterSec: 1.0, gainJitter: 0.08, alternatePan: false, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
  tibetan_bowl_low: {
    name: "Tibetan Bowl (Low)",
    baseHz: 194.18,
    waveform: "sine",
    harmonics: [
      { multiple: 1.000, gainRatio: 1.00, detuneCentsRange: 5, wobbleHz: 0.05, wobbleDepthCents: 4, decaySec: 9.0, sustainRatio: 0 },
      { multiple: 2.015, gainRatio: 0.60, detuneCentsRange: 6, wobbleHz: 0.04, wobbleDepthCents: 3, decaySec: 6.0, sustainRatio: 0 },
      { multiple: 3.025, gainRatio: 0.32, detuneCentsRange: 7, wobbleHz: 0.03, wobbleDepthCents: 2, decaySec: 3.5, sustainRatio: 0 },
      { multiple: 4.060, gainRatio: 0.15, detuneCentsRange: 7, decaySec: 1.8, sustainRatio: 0 },
    ],
    attackSec: 0.9,
    decaySec: 9.0,
    sustainRatio: 0,
    releaseSec: 3.5,
    lowpassHz: 4500,
    stereoSpread: 0.25,
    reverb: { wet: 0.32, decaySec: 5.5, preDelayMs: 22 },
    repeat: { enabled: true, intervalSec: 9, timingJitterSec: 0.6, gainJitter: 0.09, alternatePan: false, doubleStrike: { enabled: false, delaySec: 0.1, gain: 0.5 } },
  },
};

export type PlayOptions = {
  durationSec?: number;
  attackSec?: number;
  decaySec?: number;
  sustainRatio?: number;
  releaseSec?: number;
  peakGain?: number;
  waveform?: OscillatorType;
  harmonics?: Harmonic[];
  auxTones?: Harmonic[];
  preset?: string;
  loop?: boolean;
  lowpassHz?: number;
  highpassHz?: number;
  stereoSpread?: number;
  noiseBurst?: NoiseBurst;
  reverb?: ReverbConfig;
  overlap?: boolean;
  gainMultiplier?: number;
  panDirection?: number; // 1 or -1
};

// ── Tools ─────────────────────────────────────────────────────────

const sampleBuffers = new Map<string, AudioBuffer>();
const samplePromises = new Map<string, Promise<AudioBuffer>>();

async function loadSample(c: AudioContext, url: string): Promise<AudioBuffer> {
  const cached = sampleBuffers.get(url);
  if (cached) return cached;
  const inflight = samplePromises.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`sample fetch failed`);
    const ab = await r.arrayBuffer();
    return await c.decodeAudioData(ab);
  })();
  samplePromises.set(url, p);
  const buf = await p;
  sampleBuffers.set(url, buf);
  samplePromises.delete(url);
  return buf;
}

const reverbBuffers = new Map<string, AudioBuffer>();

function getReverbBuffer(c: AudioContext, decaySec: number): AudioBuffer {
  const key = `reverb_${decaySec.toFixed(2)}`;
  if (reverbBuffers.has(key)) return reverbBuffers.get(key)!;
  
  const length = c.sampleRate * decaySec;
  const buffer = c.createBuffer(2, length, c.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  
  for (let i = 0; i < length; i++) {
    const factor = Math.pow(1 - i / length, 2.5);
    left[i] = (Math.random() * 2 - 1) * factor;
    right[i] = (Math.random() * 2 - 1) * factor;
  }
  
  reverbBuffers.set(key, buffer);
  return buffer;
}

function setupGlobalReverb(c: AudioContext, config: ReverbConfig | undefined) {
  if (!config || config.wet === 0) {
    if (globalReverbInMix) {
      globalReverbInMix.disconnect();
      if (globalReverbDryGain) globalReverbDryGain.disconnect();
      globalReverbInMix = null;
      globalReverbDryGain = null;
      globalReverbWetGain = null;
      currentReverbConfigString = "";
    }
    return;
  }

  const configStr = `${config.decaySec}_${config.preDelayMs}`;
  if (globalReverbInMix && currentReverbConfigString === configStr) {
    if (globalReverbWetGain) globalReverbWetGain.gain.value = config.wet;
    if (globalReverbDryGain) globalReverbDryGain.gain.value = 1.0 - config.wet;
    return;
  }

  if (globalReverbInMix) globalReverbInMix.disconnect();
  if (globalReverbDryGain) globalReverbDryGain.disconnect();

  globalReverbInMix = c.createGain();
  globalReverbDryGain = c.createGain();
  globalReverbDryGain.gain.value = 1.0 - config.wet;
  globalReverbDryGain.connect(c.destination);

  const preDelay = c.createDelay();
  preDelay.delayTime.value = (config.preDelayMs || 0) / 1000;
  
  const convolver = c.createConvolver();
  convolver.buffer = getReverbBuffer(c, config.decaySec || 3);
  
  globalReverbWetGain = c.createGain();
  globalReverbWetGain.gain.value = config.wet;

  globalReverbInMix.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(globalReverbWetGain);
  globalReverbWetGain.connect(c.destination);

  currentReverbConfigString = configStr;
}

// ── Play/Stop API ──────────────────────────────────────────────────

export function stopFrequency(): void {
  if (activeStopTimer) {
    clearTimeout(activeStopTimer);
    activeStopTimer = null;
  }
  const c = ctx;
  if (activeOscillators.length > 0 && activeGains.length > 0 && c) {
    const now = c.currentTime;
    try {
      activeGains.forEach(gain => {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.05); // quick release
      });
      activeOscillators.forEach(osc => {
        try { osc.stop(now + 0.5); } catch {}
      });
    } catch {}
  }
  activeOscillators = [];
  activeGains = [];
  activeNodes = [];
}

export function playFrequency(hz: number, options: PlayOptions = {}): boolean {
  const c = getCtx();
  if (!c) return false;
  if (c.state === "suspended") void c.resume();

  if (!options.overlap) {
    stopFrequency();
  }

  const preset = options.preset ? PRESETS[options.preset] : null;

  const waveform: OscillatorType = options.waveform ?? preset?.waveform ?? "sine";
  const harmonics: Harmonic[] = options.harmonics ?? preset?.harmonics ?? [
    { multiple: 1, gainRatio: 1.0 },
    { multiple: 2, gainRatio: 0.1 },
  ];
  const auxTones: Harmonic[] = options.auxTones ?? preset?.auxTones ?? [];
  const attackSec  = options.attackSec  ?? preset?.attackSec  ?? 0.4;
  const decaySec   = options.decaySec   ?? preset?.decaySec   ?? 0;
  const sustainRatio = options.sustainRatio ?? preset?.sustainRatio ?? 1.0;
  const releaseSec = options.releaseSec ?? preset?.releaseSec ?? 0.8;
  const peakGain   = (options.peakGain ?? 0.18) * (preset?.masterVolume ?? 1.0);
  const durationSec = options.durationSec ?? 8;
  const lowpassHz = options.lowpassHz ?? preset?.lowpassHz;
  const highpassHz = options.highpassHz ?? preset?.highpassHz;
  const stereoSpread = options.stereoSpread ?? preset?.stereoSpread ?? 0;
  const reverbConfig = options.reverb ?? preset?.reverb;
  const noiseBurst = options.noiseBurst ?? preset?.noiseBurst;
  const loop = options.loop ?? true;

  const now = c.currentTime;

  if (preset?.sampleUrl) {
    // simplified fallback for sample playback
    const sampleHz = preset.sampleHz ?? hz;
    void loadSample(c, preset.sampleUrl).then(buf => {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = preset.sampleLoop ?? loop;
      src.playbackRate.value = hz / sampleHz;
      const env = c.createGain();
      env.gain.value = 0;
      env.gain.linearRampToValueAtTime(peakGain, c.currentTime + attackSec);
      src.connect(env);
      env.connect(c.destination);
      src.start(c.currentTime);
      activeGains.push(env);
      activeNodes.push(src as any);
    });
    return true;
  }

  // 1. Setup Global Reverb
  setupGlobalReverb(c, reverbConfig);

  // Filter chain logic
  let outputNode: AudioNode = c.destination;
  if (globalReverbInMix && globalReverbDryGain) {
    const splitMix = c.createGain();
    splitMix.connect(globalReverbDryGain);
    splitMix.connect(globalReverbInMix);
    outputNode = splitMix;
    activeNodes.push(splitMix);
  }

  if (lowpassHz) {
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpassHz;
    filter.Q.value = 0.7;
    filter.connect(outputNode);
    activeNodes.push(filter);
    outputNode = filter;
  }

  if (highpassHz) {
    const filter = c.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = highpassHz;
    filter.Q.value = 0.7;
    filter.connect(outputNode);
    activeNodes.push(filter);
    outputNode = filter;
  }

  // 2. Harmonics and Aux Tones (Oscillators)
  const allTones = [...harmonics, ...auxTones];
  allTones.forEach((h, i) => {
    const osc = c.createOscillator();
    osc.type = h.waveform ?? waveform;
    osc.frequency.value = h.absoluteHz ?? hz * h.multiple;

    if (h.detuneCentsRange && h.detuneCentsRange > 0) {
      osc.detune.value = (Math.random() - 0.5) * 2 * h.detuneCentsRange;
    }

    const wobbleGain = c.createGain();
    wobbleGain.gain.value = 1.0;

    const envGain = c.createGain();
    envGain.gain.value = 0;

    osc.connect(wobbleGain);
    wobbleGain.connect(envGain);

    let finalPan = h.pan !== undefined ? h.pan : (stereoSpread > 0 ? (i % 2 === 0 ? -stereoSpread : stereoSpread) : 0);
    if (options.panDirection) {
      finalPan *= options.panDirection; // Alternate pan
    }
    
    if (finalPan !== 0) {
      const panner = c.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, finalPan));
      envGain.connect(panner);
      panner.connect(outputNode);
      activeNodes.push(panner);
    } else {
      envGain.connect(outputNode);
    }

    // ADSR Envelope
    const pAttack  = h.attackSec  ?? attackSec;
    const pDecay   = h.decaySec   ?? decaySec;
    const pSustain = h.sustainRatio ?? sustainRatio;
    const pRelease = h.releaseSec ?? releaseSec;

    const targetGain = peakGain * h.gainRatio * (options.gainMultiplier || 1);
    envGain.gain.setValueAtTime(0, now);
    envGain.gain.linearRampToValueAtTime(targetGain, now + pAttack);

    if (pDecay > 0) {
      envGain.gain.setTargetAtTime(targetGain * pSustain, now + pAttack, pDecay / 3);
    }

    if (!loop) {
      // release phase for non-looping
      const holdEnd = now + Math.max(pAttack + pDecay, durationSec - pRelease);
      envGain.gain.cancelScheduledValues(holdEnd);
      envGain.gain.setTargetAtTime(0, holdEnd, pRelease / 3);
    }

    // LFO Pitch Modulation (via detune, in cents)
    if (h.wobbleHz && h.wobbleHz > 0) {
      const lfo = c.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = h.wobbleHz;
      const lfoDepth = c.createGain();
      // Default depth: 3 cents (subtle, meditative). User can override via wobbleDepthCents.
      lfoDepth.gain.value = h.wobbleDepthCents ?? 3;
      lfo.connect(lfoDepth);
      lfoDepth.connect(osc.detune);  // pitch modulation, not amplitude
      lfo.start(now);
      if (!loop) lfo.stop(now + durationSec + pRelease + 0.1);
      activeOscillators.push(lfo);
      activeNodes.push(lfoDepth);
    }

    osc.start(now);
    if (!loop) osc.stop(now + durationSec + pRelease + 0.1);

    activeOscillators.push(osc);
    activeGains.push(envGain);
  });

  // 3. Noise Burst
  if (noiseBurst && noiseBurst.gain > 0) {
    const bufferSize = c.sampleRate * (noiseBurst.attackSec + noiseBurst.decaySec + 0.1);
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);

    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      if (noiseBurst.type === "pink") {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else {
        data[i] = white;
      }
    }

    const noiseSrc = c.createBufferSource();
    noiseSrc.buffer = buffer;

    let noiseOutNode: AudioNode = outputNode;

    if (noiseBurst.bandpassHz) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = noiseBurst.bandpassHz;
      bp.Q.value = 1.0;
      bp.connect(outputNode);
      activeNodes.push(bp);
      noiseOutNode = bp;
    }

    const noiseEnv = c.createGain();
    noiseEnv.gain.setValueAtTime(0, now);
    noiseEnv.gain.linearRampToValueAtTime(noiseBurst.gain * (options.gainMultiplier || 1), now + noiseBurst.attackSec);
    noiseEnv.gain.setTargetAtTime(0, now + noiseBurst.attackSec, noiseBurst.decaySec / 3);

    noiseSrc.connect(noiseEnv);
    noiseEnv.connect(noiseOutNode);

    noiseSrc.start(now);
    noiseSrc.stop(now + noiseBurst.attackSec + noiseBurst.decaySec + 0.1);
    activeGains.push(noiseEnv);
    activeNodes.push(noiseSrc as any);
  }

  if (!loop && !options.overlap) {
    activeStopTimer = setTimeout(() => {
      activeOscillators = [];
      activeGains = [];
      activeNodes = [];
      activeStopTimer = null;
    }, (durationSec + releaseSec + 0.5) * 1000);
  }

  // Auto-cleanup for overlapping notes
  if (options.overlap && !loop) {
    setTimeout(() => {
      // Memory cleanup: we don't clear the arrays entirely because other overlapping notes might be active,
      // but in a perfect world we'd filter them. Since GC cleans up disconnected nodes anyway, we just let them decay.
    }, (durationSec + releaseSec + 0.5) * 1000);
  }

  return true;
}

export function isPlaying(): boolean {
  return activeOscillators.length > 0;
}

export function playPreset(presetName: string, hz: number, overrides: PlayOptions = {}): boolean {
  return playFrequency(hz, { ...overrides, preset: presetName });
}

// ── Multi-Sequencer API ───────────────────────────────────────────

const activeSequences = new Map<string, { timeoutId: number; active: boolean }>();

export function isSequencePlaying(presetId: string): boolean {
  return activeSequences.has(presetId);
}

export function stopSequence(presetId: string): void {
  const seq = activeSequences.get(presetId);
  if (seq) {
    seq.active = false;
    clearTimeout(seq.timeoutId);
    activeSequences.delete(presetId);
  }
}

export function stopAllSequences(): void {
  activeSequences.forEach(seq => {
    seq.active = false;
    clearTimeout(seq.timeoutId);
  });
  activeSequences.clear();
}

export function startSequence(presetId: string, preset: SynthPreset, hz: number, customDurationSec: number = 4.0): void {
  stopSequence(presetId);

  const seqObj = { timeoutId: 0 as any, active: true };
  activeSequences.set(presetId, seqObj);

  const repeat = preset.repeat;

  // Single-shot: play once and auto-unregister after sound fades
  if (!repeat || !repeat.enabled) {
    playFrequency(hz, { ...preset, loop: false, durationSec: customDurationSec, overlap: true, preset: undefined });
    const fadeMs = ((preset.decaySec ?? customDurationSec) + (preset.releaseSec ?? 1) + 2) * 1000;
    seqObj.timeoutId = setTimeout(() => {
      activeSequences.delete(presetId);
    }, fadeMs) as any;
    return;
  }

  let n = 0;
  const trigger = () => {
    if (!seqObj.active) return;

    const jitter = repeat.timingJitterSec ? (Math.random() - 0.5) * repeat.timingJitterSec : 0;
    const gainRand = repeat.gainJitter ? 1 + (Math.random() - 0.5) * repeat.gainJitter : 1;
    const panDir = repeat.alternatePan ? (n % 2 === 0 ? -1 : 1) : 1;

    playFrequency(hz, {
      ...preset,
      loop: false,
      durationSec: customDurationSec,
      overlap: true,
      gainMultiplier: gainRand,
      panDirection: panDir,
      preset: undefined
    });

    if (repeat.doubleStrike && repeat.doubleStrike.enabled) {
      setTimeout(() => {
        if (!seqObj.active) return;
        playFrequency(hz, {
          ...preset,
          loop: false,
          durationSec: customDurationSec,
          overlap: true,
          gainMultiplier: gainRand * (repeat.doubleStrike!.gain),
          panDirection: repeat.alternatePan ? (n % 2 === 0 ? 1 : -1) : 1,
          preset: undefined
        });
      }, repeat.doubleStrike.delaySec * 1000);
    }

    n++;
    if (repeat.count && n >= repeat.count) {
      stopSequence(presetId);
      return;
    }

    const nextIntervalMs = (repeat.intervalSec + jitter) * 1000;
    if (seqObj.active) {
      seqObj.timeoutId = setTimeout(trigger, nextIntervalMs) as any;
    }
  };

  trigger();
}

// Update a running sequence with new preset params (for live editor updates).
// Restarts the sequence immediately with the new config; reverb tails from old strikes remain.
export function updateSequencePreset(presetId: string, newPreset: SynthPreset, hz: number): void {
  if (!activeSequences.has(presetId)) return;
  startSequence(presetId, newPreset, hz);
}
