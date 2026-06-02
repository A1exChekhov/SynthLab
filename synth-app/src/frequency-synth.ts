"use client";

let ctx: AudioContext | null = null;
let activeOscillators: OscillatorNode[] = [];
let activeGains: GainNode[] = [];
let activeNodes: AudioNode[] = [];
let activeFinalBoosts: GainNode[] = [];
let activeStopTimer: ReturnType<typeof setTimeout> | null = null;

// Global Reverb Bus
let globalReverbInMix: GainNode | null = null;
let globalReverbWetGain: GainNode | null = null;
let globalReverbDryGain: GainNode | null = null;
let currentReverbConfigString: string = "";
let analyzerNode: AnalyserNode | null = null;
let analyzerL: AnalyserNode | null = null;
let analyzerR: AnalyserNode | null = null;

export let globalMasterVolume = 0.5; // DEFAULT 50% Volume
export let masterGainNode: GainNode | null = null;

export function setGlobalVolume(v: number) {
  globalMasterVolume = v;
  if (masterGainNode) {
    masterGainNode.gain.setTargetAtTime(v, getCtx()?.currentTime || 0, 0.05);
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  
  masterGainNode = ctx.createGain();
  masterGainNode.gain.value = globalMasterVolume;
  masterGainNode.connect(ctx.destination);
  
  return ctx;
}

export function isAudioSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.AudioContext || (window as any).webkitAudioContext);
}

export function getAnalyzer(): AnalyserNode | null {
  const c = getCtx();
  if (!c) return null;
  if (!analyzerNode) {
    analyzerNode = c.createAnalyser();
    analyzerNode.fftSize = 2048;
  }
  return analyzerNode;
}

export function getStereoAnalyzers(): { L: AnalyserNode; R: AnalyserNode } | null {
  const c = getCtx();
  if (!c) return null;
  if (!analyzerL || !analyzerR) {
    analyzerL = c.createAnalyser();
    analyzerL.fftSize = 512;
    analyzerL.smoothingTimeConstant = 0.5;

    analyzerR = c.createAnalyser();
    analyzerR.fftSize = 512;
    analyzerR.smoothingTimeConstant = 0.5;
  }
  return { L: analyzerL, R: analyzerR };
}

// ── Types ─────────────────────────────────────────────────────────

export type Harmonic = {
  multiple: number;
  gainRatio: number;
  waveform?: OscillatorType;
  delaySec?: number;      // New: Independent start time for each overtone
  attackSec?: number;
  decaySec?: number;      // New: for bell-like hits
  sustainRatio?: number;  // New: 0 to 1
  releaseSec?: number;
  wobbleHz?: number;          // LFO Rate: 0 = off, 0.01–8 Hz
  wobbleDepthCents?: number;  // LFO Depth in cents (pitch modulation)
  detuneCentsRange?: number;
  absoluteHz?: number;
  pan?: number;
  gainL?: number; // New: independent left gain (0..1)
  gainR?: number; // New: independent right gain (0..1)
  binauralBeatHz?: number;
};

export type NoiseBurst = {
  type: "white" | "pink";
  delaySec?: number; // New: for multiple impacts
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
  outputGain?: number; // Post-limiter gain multiplier
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
  noiseBurst?: NoiseBurst | NoiseBurst[];
  reverb?: ReverbConfig;
  repeat?: RepeatConfig;
  sampleUrl?: string;
  sampleHz?: number;
  sampleLoop?: boolean;
  systemId?: string;
  groupId?: string;
  pannerType?: "stereo" | "3d";
  spatialRotationHz?: number;
};

export const SYSTEM_CATEGORIES = [
  { id: "uncategorized", label: "Все пресеты / Без категории" },
  { id: "solfeggio", label: "Частоты Сольфеджио (Solfeggio)" },
  { id: "cosmic_octave", label: "Космическая Октава (Cosmic Octave)" },
  { id: "chakra", label: "Музыкальные Шкалы Чакр" },
  { id: "earth_space", label: "Физика Земли и Космоса" },
  { id: "acoustic", label: "Акустические Инструменты" },
  { id: "drone_rhythm", label: "Дроны и Ритмические паттерны" },
  { id: "digital_binaural", label: "Цифровые, Бинауральные и Голос" },
  { id: "errarium", label: "Errarium Resonance Matrix" }
];

// ── Preset Library ────────────────────────────────────────────────

export const PRESETS: Record<string, SynthPreset> = {
  solfeggio_174: {
    name: "Освобождение от боли (174 Hz)",
    systemId: "solfeggio",
    baseHz: 174,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_285: {
    name: "Восстановление тканей (285 Hz)",
    systemId: "solfeggio",
    baseHz: 285,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_396: {
    name: "Освобождение от страха (396 Hz)",
    systemId: "solfeggio",
    baseHz: 396,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_417: {
    name: "Трансформация (417 Hz)",
    systemId: "solfeggio",
    baseHz: 417,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_528: {
    name: "Исцеление / ДНК (528 Hz)",
    systemId: "solfeggio",
    baseHz: 528,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_639: {
    name: "Связь и отношения (639 Hz)",
    systemId: "solfeggio",
    baseHz: 639,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_741: {
    name: "Очищение и выражение (741 Hz)",
    systemId: "solfeggio",
    baseHz: 741,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_852: {
    name: "Духовный порядок (852 Hz)",
    systemId: "solfeggio",
    baseHz: 852,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  solfeggio_963: {
    name: "Единство / Коронная (963 Hz)",
    systemId: "solfeggio",
    baseHz: 963,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_194_18: {
    name: "Muladhara (Корневая) (194.18 Hz)",
    systemId: "cosmic_octave",
    baseHz: 194.18,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_210_42: {
    name: "Svadhisthana (Сакральная) (210.42 Hz)",
    systemId: "cosmic_octave",
    baseHz: 210.42,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_126_22: {
    name: "Manipura (Солн. сплетение) (126.22 Hz)",
    systemId: "cosmic_octave",
    baseHz: 126.22,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_136_1: {
    name: "Anahata (Сердце / OM) (136.1 Hz)",
    systemId: "cosmic_octave",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_141_27: {
    name: "Vishuddha (Горло) (141.27 Hz)",
    systemId: "cosmic_octave",
    baseHz: 141.27,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_221_23: {
    name: "Ajna (Третий глаз) (221.23 Hz)",
    systemId: "cosmic_octave",
    baseHz: 221.23,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_172_06: {
    name: "Sahasrara (Корона) (172.06 Hz)",
    systemId: "cosmic_octave",
    baseHz: 172.06,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_144_72: {
    name: "Марс (144.72 Hz)",
    systemId: "cosmic_octave",
    baseHz: 144.72,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_183_58: {
    name: "Юпитер (183.58 Hz)",
    systemId: "cosmic_octave",
    baseHz: 183.58,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_147_85: {
    name: "Сатурн (147.85 Hz)",
    systemId: "cosmic_octave",
    baseHz: 147.85,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_207_36: {
    name: "Уран (207.36 Hz)",
    systemId: "cosmic_octave",
    baseHz: 207.36,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_211_44: {
    name: "Нептун (211.44 Hz)",
    systemId: "cosmic_octave",
    baseHz: 211.44,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  cosmic_octave_140_64: {
    name: "Плутон (140.64 Hz)",
    systemId: "cosmic_octave",
    baseHz: 140.64,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_261_63: {
    name: "C4 (261.63 Hz)",
    systemId: "chakra",
    baseHz: 261.63,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_293_66: {
    name: "D4 (293.66 Hz)",
    systemId: "chakra",
    baseHz: 293.66,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_164_81: {
    name: "E3 (164.81 Hz)",
    systemId: "chakra",
    baseHz: 164.81,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_349_23: {
    name: "F4 (349.23 Hz)",
    systemId: "chakra",
    baseHz: 349.23,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_392: {
    name: "G4 (392 Hz)",
    systemId: "chakra",
    baseHz: 392,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_440: {
    name: "A4 (440 Hz)",
    systemId: "chakra",
    baseHz: 440,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_493_88: {
    name: "B4 (493.88 Hz)",
    systemId: "chakra",
    baseHz: 493.88,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_256: {
    name: "C3 (256 Hz)",
    systemId: "chakra",
    baseHz: 256,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_288: {
    name: "D3 (288 Hz)",
    systemId: "chakra",
    baseHz: 288,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_167: {
    name: "E3+ (167 Hz)",
    systemId: "chakra",
    baseHz: 167,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_171: {
    name: "F3 (171 Hz)",
    systemId: "chakra",
    baseHz: 171,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_192: {
    name: "G3 (192 Hz)",
    systemId: "chakra",
    baseHz: 192,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_216: {
    name: "A3 (216 Hz)",
    systemId: "chakra",
    baseHz: 216,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_432: {
    name: "A4 (432 Hz)",
    systemId: "chakra",
    baseHz: 432,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  chakra_240: {
    name: "B3 (240 Hz)",
    systemId: "chakra",
    baseHz: 240,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_7_83: {
    name: "Шуман 1 (7.83 Hz)",
    systemId: "earth_space",
    baseHz: 7.83,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_14_3: {
    name: "Шуман 2 (14.3 Hz)",
    systemId: "earth_space",
    baseHz: 14.3,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_250_56: {
    name: "Шуман (октава) (250.56 Hz)",
    systemId: "earth_space",
    baseHz: 250.56,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_9_36: {
    name: "Геомагнитное поле (9.36 Hz)",
    systemId: "earth_space",
    baseHz: 9.36,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_207_67: {
    name: "H-alpha (207.67 Hz)",
    systemId: "earth_space",
    baseHz: 207.67,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_140_18: {
    name: "H-beta (140.18 Hz)",
    systemId: "earth_space",
    baseHz: 140.18,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_157: {
    name: "H-gamma (157 Hz)",
    systemId: "earth_space",
    baseHz: 157,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_166_14: {
    name: "H-delta (166.14 Hz)",
    systemId: "earth_space",
    baseHz: 166.14,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_171_65: {
    name: "H-epsilon (171.65 Hz)",
    systemId: "earth_space",
    baseHz: 171.65,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_174: {
    name: "Сириус (174 Hz)",
    systemId: "earth_space",
    baseHz: 174,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  earth_space_154_15: {
    name: "Галактика (154.15 Hz)",
    systemId: "earth_space",
    baseHz: 154.15,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_126_22: {
    name: "Камертон Солнца (126.22 Hz)",
    systemId: "acoustic",
    baseHz: 126.22,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_136_1: {
    name: "Камертон OM / Earth Year (136.1 Hz)",
    systemId: "acoustic",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_194_18: {
    name: "Камертон Earth Day (194.18 Hz)",
    systemId: "acoustic",
    baseHz: 194.18,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_221_23: {
    name: "Камертон Венеры (221.23 Hz)",
    systemId: "acoustic",
    baseHz: 221.23,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_147_85: {
    name: "Камертон Сатурна (147.85 Hz)",
    systemId: "acoustic",
    baseHz: 147.85,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_141_27: {
    name: "Камертон Меркурия (141.27 Hz)",
    systemId: "acoustic",
    baseHz: 141.27,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_256: {
    name: "Master Fork — Steiner C (256 Hz)",
    systemId: "acoustic",
    baseHz: 256,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_128: {
    name: "Otto 128 (тело) (128 Hz)",
    systemId: "acoustic",
    baseHz: 128,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_261_63: {
    name: "Хрустальная чаша C (261.63 Hz)",
    systemId: "acoustic",
    baseHz: 261.63,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_293_66: {
    name: "Хрустальная чаша D (293.66 Hz)",
    systemId: "acoustic",
    baseHz: 293.66,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_167: {
    name: "Тибетская чаша E (167 Hz)",
    systemId: "acoustic",
    baseHz: 167,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_349_23: {
    name: "Хрустальная чаша F (349.23 Hz)",
    systemId: "acoustic",
    baseHz: 349.23,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_392: {
    name: "Хрустальная чаша G (392 Hz)",
    systemId: "acoustic",
    baseHz: 392,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_432: {
    name: "Чаша A=432 (432 Hz)",
    systemId: "acoustic",
    baseHz: 432,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_493_88: {
    name: "Хрустальная чаша B (493.88 Hz)",
    systemId: "acoustic",
    baseHz: 493.88,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_126_22_alt: {
    name: "Гонг Солнца (126.22 Hz)",
    systemId: "acoustic",
    baseHz: 126.22,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_210_42: {
    name: "Гонг Луны (210.42 Hz)",
    systemId: "acoustic",
    baseHz: 210.42,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_221_23_alt: {
    name: "Гонг Венеры (221.23 Hz)",
    systemId: "acoustic",
    baseHz: 221.23,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_144_72: {
    name: "Гонг Марса (144.72 Hz)",
    systemId: "acoustic",
    baseHz: 144.72,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_183_58: {
    name: "Гонг Юпитера (183.58 Hz)",
    systemId: "acoustic",
    baseHz: 183.58,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_147_85_alt: {
    name: "Гонг Сатурна (147.85 Hz)",
    systemId: "acoustic",
    baseHz: 147.85,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_207_36: {
    name: "Гонг Урана (207.36 Hz)",
    systemId: "acoustic",
    baseHz: 207.36,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_211_44: {
    name: "Гонг Нептуна (211.44 Hz)",
    systemId: "acoustic",
    baseHz: 211.44,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_140_64: {
    name: "Гонг Плутона (140.64 Hz)",
    systemId: "acoustic",
    baseHz: 140.64,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_136_1_alt: {
    name: "Гонг OM / Земля год (136.1 Hz)",
    systemId: "acoustic",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_141_27_alt: {
    name: "Колокольчики Меркурия (141.27 Hz)",
    systemId: "acoustic",
    baseHz: 141.27,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_432_alt: {
    name: "Колокольчики 432 (432 Hz)",
    systemId: "acoustic",
    baseHz: 432,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  acoustic_528: {
    name: "Колокольчики Solfeggio (528 Hz)",
    systemId: "acoustic",
    baseHz: 528,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_136_1: {
    name: "Монохорд OM (136.1 Hz)",
    systemId: "drone_rhythm",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_432: {
    name: "Монохорд A=432 (432 Hz)",
    systemId: "drone_rhythm",
    baseHz: 432,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_261_63: {
    name: "Монохорд C — корень (261.63 Hz)",
    systemId: "drone_rhythm",
    baseHz: 261.63,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_136_1_alt: {
    name: "Шрути-бокс OM (136.1 Hz)",
    systemId: "drone_rhythm",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_167: {
    name: "Шрути-бокс E (167 Hz)",
    systemId: "drone_rhythm",
    baseHz: 167,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_220: {
    name: "Тамбура A — третий глаз (220 Hz)",
    systemId: "drone_rhythm",
    baseHz: 220,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_80: {
    name: "Фрейм-барабан (80 Hz)",
    systemId: "drone_rhythm",
    baseHz: 80,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_100: {
    name: "Шаманский барабан (Тета 5 Hz) (100 Hz)",
    systemId: "drone_rhythm",
    baseHz: 100,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_70: {
    name: "Шаманский медленный (70 Hz)",
    systemId: "drone_rhythm",
    baseHz: 70,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_90: {
    name: "Барабан — мягкий транс (4 Hz) (90 Hz)",
    systemId: "drone_rhythm",
    baseHz: 90,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  drone_rhythm_110: {
    name: "Барабан — активный (7 Hz) (110 Hz)",
    systemId: "drone_rhythm",
    baseHz: 110,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_200: {
    name: "Бинауральный тета 7.8 Hz (200 Hz)",
    systemId: "digital_binaural",
    baseHz: 200,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_136_1: {
    name: "Бинауральный OM (136.1 Hz)",
    systemId: "digital_binaural",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_100: {
    name: "Бинауральный альфа ≈8-12 Hz (100 Hz)",
    systemId: "digital_binaural",
    baseHz: 100,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_250_56: {
    name: "Шуман — октавный тон (250.56 Hz)",
    systemId: "digital_binaural",
    baseHz: 250.56,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_7_83: {
    name: "Шуман прямой 7.83 Hz (7.83 Hz)",
    systemId: "digital_binaural",
    baseHz: 7.83,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_174: {
    name: "UT — боль (174 Hz)",
    systemId: "digital_binaural",
    baseHz: 174,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_285: {
    name: "Восстановление (285 Hz)",
    systemId: "digital_binaural",
    baseHz: 285,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_396: {
    name: "UT — страх (396 Hz)",
    systemId: "digital_binaural",
    baseHz: 396,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_417: {
    name: "RE — трансформация (417 Hz)",
    systemId: "digital_binaural",
    baseHz: 417,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_528: {
    name: "MI — чудо (528 Hz)",
    systemId: "digital_binaural",
    baseHz: 528,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_639: {
    name: "FA — связь (639 Hz)",
    systemId: "digital_binaural",
    baseHz: 639,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_741: {
    name: "SOL — очищение (741 Hz)",
    systemId: "digital_binaural",
    baseHz: 741,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_852: {
    name: "LA — дух (852 Hz)",
    systemId: "digital_binaural",
    baseHz: 852,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_963: {
    name: "SI — единство (963 Hz)",
    systemId: "digital_binaural",
    baseHz: 963,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_136_1_alt: {
    name: "OM на 136.10 Hz (136.1 Hz)",
    systemId: "digital_binaural",
    baseHz: 136.1,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_196: {
    name: "LAM — корневая (196 Hz)",
    systemId: "digital_binaural",
    baseHz: 196,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_220: {
    name: "VAM — сакральная (220 Hz)",
    systemId: "digital_binaural",
    baseHz: 220,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_167: {
    name: "RAM — solar plexus (167 Hz)",
    systemId: "digital_binaural",
    baseHz: 167,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_174_alt: {
    name: "YAM — сердечная (174 Hz)",
    systemId: "digital_binaural",
    baseHz: 174,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_196_alt: {
    name: "HAM — горловая (196 Hz)",
    systemId: "digital_binaural",
    baseHz: 196,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  digital_binaural_220_alt: {
    name: "OM — третий глаз/корона (220 Hz)",
    systemId: "digital_binaural",
    baseHz: 220,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_126_22: {
    name: "Хрустальная чаша · Личность · Солнце (126.22 Hz)",
    systemId: "errarium",
    baseHz: 126.22,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_210_42: {
    name: "Тибетская поющая чаша · Эмоции · Луна (210.42 Hz)",
    systemId: "errarium",
    baseHz: 210.42,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_141_27: {
    name: "Колокольчики · Ум · Меркурий (141.27 Hz)",
    systemId: "errarium",
    baseHz: 141.27,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_221_23: {
    name: "Арфа · Чувства · Венера (221.23 Hz)",
    systemId: "errarium",
    baseHz: 221.23,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_144_72: {
    name: "Барабан · Действие · Марс (144.72 Hz)",
    systemId: "errarium",
    baseHz: 144.72,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_183_58: {
    name: "Орган · Рост · Юпитер (183.58 Hz)",
    systemId: "errarium",
    baseHz: 183.58,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  errarium_147_85: {
    name: "Контрабас · Закон · Сатурн (147.85 Hz)",
    systemId: "errarium",
    baseHz: 147.85,
    waveform: "sine",
    harmonics: [ { multiple: 1, gainRatio: 1, decaySec: 6 } ],
    attackSec: 0.5, releaseSec: 2, masterVolume: 1.0,
    reverb: { wet: 0.3, decaySec: 5, preDelayMs: 20 },
    repeat: { enabled: true, intervalSec: 8, timingJitterSec: 0.4, gainJitter: 0.08 }
  },
  crystal_bowl: {
    name: "Crystal Bowl",
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
    systemId: "cosmic_octave",
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
  noiseBurst?: NoiseBurst | NoiseBurst[];
  reverb?: ReverbConfig;
  overlap?: boolean;
  gainMultiplier?: number;
  panDirection?: number; // 1 or -1
  pannerType?: string;
  spatialRotationHz?: number;
  destination?: AudioNode; // Mixer: route this voice into a channel bus instead of master
};

// Handle to the audio nodes created by a single playFrequency() call,
// so the mixer can stop one channel's voices independently of the rest.
export type VoiceHandle = {
  osc: OscillatorNode[];
  gains: GainNode[];
  nodes: AudioNode[];
  boosts: GainNode[];
};
let lastVoiceHandle: VoiceHandle | null = null;

// ── Tools ─────────────────────────────────────────────────────────

const sampleBuffers = new Map<string, AudioBuffer>();

export function clearAudioCache() {
  sampleBuffers.clear();
  currentReverbConfigString = "";
  console.log("Audio cache cleared (sample buffers and reverb).");
}
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
  globalReverbDryGain.connect(masterGainNode!);

  const preDelay = c.createDelay();
  preDelay.delayTime.value = (config.preDelayMs || 0) / 1000;
  
  const convolver = c.createConvolver();
  convolver.buffer = getReverbBuffer(c, config.decaySec || 3);
  
  globalReverbWetGain = c.createGain();
  globalReverbWetGain.gain.value = config.wet;

  globalReverbInMix.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(globalReverbWetGain);
  globalReverbWetGain.connect(masterGainNode!);

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
        gain.gain.setTargetAtTime(0, now, 0.03); // slightly faster but still smooth release
      });
      activeOscillators.forEach(osc => {
        try { osc.stop(now + 0.5); } catch {}
      });
    } catch {}
  }
  activeOscillators = [];
  activeGains = [];
  activeNodes = [];
  activeFinalBoosts = [];
}

export function updateActiveOutputGain(gain: number): void {
  const c = ctx;
  if (!c) return;
  const now = c.currentTime;
  activeFinalBoosts.forEach(g => {
    try { g.gain.setTargetAtTime(gain, now, 0.05); } catch {}
  });
}

export function playFrequency(hz: number, options: PlayOptions = {}): boolean {
  const c = getCtx();
  if (!c) return false;
  if (c.state === "suspended") void c.resume();

  if (!options.overlap) {
    stopFrequency();
  }

  // Mixer: remember array offsets so we can isolate the nodes THIS call creates
  // (JS is single-threaded, so nothing interleaves within this synchronous function).
  const _oscStart = activeOscillators.length;
  const _gainStart = activeGains.length;
  const _nodeStart = activeNodes.length;
  const _boostStart = activeFinalBoosts.length;
  lastVoiceHandle = null;

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
  const peakGain   = (options.peakGain ?? 0.8) * (preset?.masterVolume ?? 1.0); // Safe raw volume
  const outputGain = preset?.outputGain ?? 1.0; // Safe post-limiter hardware gain
  const durationSec = options.durationSec ?? 8;
  const lowpassHz = options.lowpassHz ?? preset?.lowpassHz;
  const highpassHz = options.highpassHz ?? preset?.highpassHz;
  const stereoSpread = options.stereoSpread ?? preset?.stereoSpread ?? 0;
  const reverbConfig = options.reverb ?? preset?.reverb;
  const noiseBurst = options.noiseBurst ?? preset?.noiseBurst;
  const loop = options.loop ?? true;
  const pannerType = options.pannerType ?? preset?.pannerType ?? "stereo";
  const spatialRotationHz = options.spatialRotationHz ?? preset?.spatialRotationHz ?? 0;

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
      env.connect(options.destination ?? masterGainNode!);
      src.start(c.currentTime);
      activeGains.push(env);
      activeNodes.push(src as any);
    });
    return true;
  }

  // 1. Setup Global Reverb
  setupGlobalReverb(c, reverbConfig);

  // Filter chain logic
  let outputNode: AudioNode = masterGainNode!;

  // Setup Limiter/Compressor right before c.destination to prevent any clipping
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-1.0, now); // Prevent clipping (max -1dB headroom)
  limiter.knee.setValueAtTime(10, now);
  limiter.ratio.setValueAtTime(20, now); // Act as a brickwall limiter
  limiter.attack.setValueAtTime(0.003, now);
  limiter.release.setValueAtTime(0.1, now);
  limiter.connect(options.destination ?? masterGainNode!);

  // Final Boost (Make-up Gain / Output Gain) before limiter
  const finalBoost = c.createGain();
  finalBoost.gain.setValueAtTime(outputGain, now);
  finalBoost.connect(limiter);
  activeFinalBoosts.push(finalBoost);
  
  const analyzer = getAnalyzer();
  if (analyzer) {
    limiter.connect(analyzer);
  }

  // Stereo Splitter for L/R metering
  const stereoAnalyzers = getStereoAnalyzers();
  if (stereoAnalyzers) {
    const splitter = c.createChannelSplitter(2);
    limiter.connect(splitter);
    splitter.connect(stereoAnalyzers.L, 0);
    splitter.connect(stereoAnalyzers.R, 1);
  }

  if (globalReverbInMix && globalReverbDryGain) {
    const splitMix = c.createGain();
    splitMix.connect(globalReverbDryGain);
    splitMix.connect(globalReverbInMix);
    outputNode = splitMix;
    activeNodes.push(splitMix);
    
    globalReverbDryGain.disconnect();
    globalReverbDryGain.connect(finalBoost);
    globalReverbWetGain?.disconnect();
    globalReverbWetGain?.connect(finalBoost);
  } else {
    // If no reverb, connect output to finalBoost
    const mainBus = c.createGain();
    mainBus.connect(finalBoost);
    outputNode = mainBus;
    activeNodes.push(mainBus);
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
    const pAttack  = Math.max(0.001, h.attackSec  ?? attackSec);
    const pDecay   = Math.max(0.001, h.decaySec   ?? decaySec);
    const pSustain = Math.max(0, h.sustainRatio ?? sustainRatio);
    const pRelease = Math.max(0.001, h.releaseSec ?? releaseSec);
    const targetGain = peakGain * h.gainRatio * (options.gainMultiplier || 1);

    const hDelay = (typeof h.delaySec === 'number' && !isNaN(h.delaySec)) ? h.delaySec : 0;
    const startTime = now + Math.max(0, hDelay);

    const createOscPath = (freq: number, panVal: number) => {
      const osc = c.createOscillator();
      osc.type = h.waveform ?? waveform;
      osc.frequency.value = freq;

      if (h.detuneCentsRange && h.detuneCentsRange > 0) {
        osc.detune.value = (Math.random() - 0.5) * 2 * h.detuneCentsRange;
      }

      const wobbleGain = c.createGain();
      wobbleGain.gain.value = 1.0;
      const envGain = c.createGain();
      envGain.gain.value = 0;

      osc.connect(wobbleGain);
      wobbleGain.connect(envGain);

      const panner = c.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, panVal));
      envGain.connect(panner);

      if (pannerType === "3d") {
        // Replace or wrap with 3D Panner
        const p3d = c.createPanner();
        p3d.panningModel = "HRTF";
        p3d.distanceModel = "inverse";
        
        // Convert panVal (-1..1) to X position (-5..5)
        p3d.positionX.setValueAtTime(panVal * 5, now);
        p3d.positionZ.setValueAtTime(-2, now); // Slightly in front

        if (spatialRotationHz > 0) {
          // Circular rotation animation
          const angleOffset = (i / allTones.length) * Math.PI * 2;
          const radius = 5;
          const updatePos = () => {
            const time = c.currentTime;
            const angle = time * Math.PI * 2 * spatialRotationHz + angleOffset;
            p3d.positionX.setValueAtTime(Math.sin(angle) * radius, time);
            p3d.positionZ.setValueAtTime(Math.cos(angle) * radius, time);
            if (activeOscillators.length > 0) requestAnimationFrame(updatePos);
          };
          updatePos();
        }

        panner.connect(p3d);
        p3d.connect(outputNode);
        activeNodes.push(p3d);
      } else {
        panner.connect(outputNode);
      }

      // ADSR Envelope - Smoother transitions to prevent clicks
      envGain.gain.setValueAtTime(envGain.gain.value, startTime);
      envGain.gain.setTargetAtTime(targetGain, startTime, pAttack / 4);
      if (pDecay > 0) {
        envGain.gain.setTargetAtTime(targetGain * pSustain, startTime + pAttack, pDecay / 3);
      }
      if (!loop) {
        const holdEnd = startTime + Math.max(pAttack + pDecay, durationSec - pRelease);
        envGain.gain.cancelScheduledValues(holdEnd);
        envGain.gain.setTargetAtTime(0, holdEnd, pRelease / 3);
      }

      // Wobble (LFO)
      if (h.wobbleHz && h.wobbleHz > 0) {
        const lfo = c.createOscillator();
        lfo.frequency.value = h.wobbleHz;
        const lfoGain = c.createGain();
        lfoGain.gain.value = h.wobbleDepthCents ?? 3;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.detune);
        lfo.start(startTime);
        if (!loop) lfo.stop(startTime + durationSec + pRelease + 0.1);
        activeOscillators.push(lfo);
        activeNodes.push(lfoGain);
      }

      osc.start(startTime);
      if (!loop) osc.stop(startTime + durationSec + pRelease + 0.1);
      activeOscillators.push(osc);
      activeGains.push(envGain);
      activeNodes.push(panner, wobbleGain);
    };

    const baseFreq = h.absoluteHz ?? hz * h.multiple;

    if (h.binauralBeatHz && h.binauralBeatHz > 0) {
      // Create TWO paths for binaural effect: Left (freq - beat/2) and Right (freq + beat/2)
      createOscPath(baseFreq - h.binauralBeatHz / 2, -1);
      createOscPath(baseFreq + h.binauralBeatHz / 2, 1);
    } else {
      // Standard single path or Dual Gain path
      let finalPan = h.pan !== undefined ? h.pan : (stereoSpread > 0 ? (i % 2 === 0 ? -stereoSpread : stereoSpread) : 0);
      if (options.panDirection) finalPan *= options.panDirection;

      // Support for independent L/R gain (Dual Volume)
      if (h.gainL !== undefined && h.gainR !== undefined) {
        // Adjust the master harmonic gain if L/R are set
        // Total gain for the path will be (peakGain * totalGain * gainRatio)
        // This effectively makes gainRatio a master for that harmonic.
        const calculatedPan = (h.gainR - h.gainL) / (h.gainR + h.gainL || 1);
        createOscPath(baseFreq, calculatedPan);
      } else {
        createOscPath(baseFreq, finalPan);
      }
    }
  });

  // 3. Noise Bursts (Multi-Impact Support)
  const bursts = Array.isArray(noiseBurst) ? noiseBurst : (noiseBurst ? [noiseBurst] : []);
  bursts.forEach(burst => {
    if (burst.gain > 0) {
      const delaySec = burst.delaySec || 0;
      const startTime = now + delaySec;

      const bufferSize = c.sampleRate * (burst.attackSec + burst.decaySec + 0.1);
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);

      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        if (burst.type === "pink") {
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

      if (burst.bandpassHz) {
        const bp = c.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = burst.bandpassHz;
        bp.Q.value = 1.0;
        bp.connect(outputNode);
        activeNodes.push(bp);
        noiseOutNode = bp;
      }

      const noiseEnv = c.createGain();
      noiseEnv.gain.setValueAtTime(0, startTime);
      noiseEnv.gain.linearRampToValueAtTime(burst.gain * (options.gainMultiplier || 1), startTime + burst.attackSec);
      noiseEnv.gain.setTargetAtTime(0, startTime + burst.attackSec, burst.decaySec / 3);

      noiseSrc.connect(noiseEnv);
      noiseEnv.connect(noiseOutNode);

      noiseSrc.start(startTime);
      noiseSrc.stop(startTime + burst.attackSec + burst.decaySec + 0.1);
      activeGains.push(noiseEnv);
      activeNodes.push(noiseSrc as any);
    }
  });

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
      // Memory cleanup for final boost
      const idx = activeFinalBoosts.indexOf(finalBoost);
      if (idx !== -1) activeFinalBoosts.splice(idx, 1);
    }, (durationSec + releaseSec + 0.5) * 1000);
  }

  lastVoiceHandle = {
    osc: activeOscillators.slice(_oscStart),
    gains: activeGains.slice(_gainStart),
    nodes: activeNodes.slice(_nodeStart),
    boosts: activeFinalBoosts.slice(_boostStart),
  };

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
  stopFrequency();
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

// ── Mixer: 16-Channel Live Rack ───────────────────────────────────
// Each channel is an independent bus: voices → input(volume) → panner → analyser → master.
// Channels start/stop/mute/solo independently of each other and of the legacy single-voice API.

export const NUM_CHANNELS = 16;

type ChannelBus = {
  input: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  voices: VoiceHandle[];
  repeatTimer: ReturnType<typeof setTimeout> | null;
  active: boolean;
};

let channelBuses: ChannelBus[] | null = null;
const chVol: number[] = Array(NUM_CHANNELS).fill(0.8);
const chPan: number[] = Array(NUM_CHANNELS).fill(0);
const chMute: boolean[] = Array(NUM_CHANNELS).fill(false);
const chSolo: boolean[] = Array(NUM_CHANNELS).fill(false);

function getChannelBuses(): ChannelBus[] {
  const c = getCtx();
  if (!c) return [];
  if (channelBuses) return channelBuses;
  channelBuses = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const input = c.createGain();
    input.gain.value = chVol[i];
    const panner = c.createStereoPanner();
    panner.pan.value = chPan[i];
    const analyser = c.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    input.connect(panner);
    panner.connect(analyser);
    analyser.connect(masterGainNode!);
    return { input, panner, analyser, voices: [], repeatTimer: null, active: false };
  });
  return channelBuses;
}

function effectiveChannelGain(i: number): number {
  const anySolo = chSolo.some(Boolean);
  const audible = !chMute[i] && (!anySolo || chSolo[i]);
  return audible ? chVol[i] : 0;
}

function applyChannelGains(): void {
  const c = ctx;
  const buses = channelBuses;
  if (!c || !buses) return;
  const now = c.currentTime;
  buses.forEach((bus, i) => {
    try { bus.input.gain.setTargetAtTime(effectiveChannelGain(i), now, 0.03); } catch {}
  });
}

export function setChannelVolume(i: number, v: number): void {
  chVol[i] = Math.max(0, Math.min(2, v));
  getChannelBuses();
  applyChannelGains();
}

export function setChannelPan(i: number, p: number): void {
  chPan[i] = Math.max(-1, Math.min(1, p));
  const buses = getChannelBuses();
  const c = ctx;
  if (buses[i] && c) {
    try { buses[i].panner.pan.setTargetAtTime(chPan[i], c.currentTime, 0.03); } catch {}
  }
}

export function setChannelMute(i: number, m: boolean): void {
  chMute[i] = m;
  getChannelBuses();
  applyChannelGains();
}

export function setChannelSolo(i: number, s: boolean): void {
  chSolo[i] = s;
  getChannelBuses();
  applyChannelGains();
}

export function getChannelAnalyser(i: number): AnalyserNode | null {
  const buses = getChannelBuses();
  return buses[i]?.analyser ?? null;
}

export function isChannelPlaying(i: number): boolean {
  return channelBuses?.[i]?.active ?? false;
}

// Fade out and stop the nodes of a single voice, and drop them from global tracking
// so the legacy stopFrequency()/cleanup never touches already-freed nodes.
function stopVoiceHandle(h: VoiceHandle): void {
  const c = ctx;
  if (!c) return;
  const now = c.currentTime;
  h.gains.forEach(g => { try { g.gain.cancelScheduledValues(now); g.gain.setTargetAtTime(0, now, 0.03); } catch {} });
  h.osc.forEach(o => { try { o.stop(now + 0.5); } catch {} });
  activeOscillators = activeOscillators.filter(o => !h.osc.includes(o));
  activeGains = activeGains.filter(g => !h.gains.includes(g));
  activeNodes = activeNodes.filter(n => !h.nodes.includes(n));
  activeFinalBoosts = activeFinalBoosts.filter(b => !h.boosts.includes(b));
}

export function stopChannel(i: number): void {
  const buses = getChannelBuses();
  const bus = buses[i];
  if (!bus) return;
  bus.active = false;
  if (bus.repeatTimer) { clearTimeout(bus.repeatTimer); bus.repeatTimer = null; }
  bus.voices.forEach(stopVoiceHandle);
  bus.voices = [];
}

export function stopAllChannels(): void {
  for (let i = 0; i < NUM_CHANNELS; i++) stopChannel(i);
}

// Start an instrument (preset) playing on a channel. A preset with repeat.enabled
// runs as a rhythmic pattern; otherwise it sustains as a single looping voice.
export function startChannel(i: number, preset: SynthPreset, hz: number, opts: { durationSec?: number } = {}): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  const buses = getChannelBuses();
  const bus = buses[i];
  if (!bus) return;
  stopChannel(i);
  bus.active = true;

  const dur = opts.durationSec ?? 4.0;
  const baseHz = preset.baseHz ?? hz;

  const fire = (gainMul = 1, panDir = 1, loop = false) => {
    if (!bus.active) return;
    playFrequency(baseHz, {
      ...preset,
      preset: undefined,
      loop,
      durationSec: dur,
      overlap: true,
      destination: bus.input,
      gainMultiplier: gainMul,
      panDirection: panDir,
    });
    if (lastVoiceHandle) {
      bus.voices.push(lastVoiceHandle);
      // prune finished one-shots so the array doesn't grow unbounded
      if (bus.voices.length > 64) {
        const dropped = bus.voices.splice(0, bus.voices.length - 64);
        dropped.forEach(stopVoiceHandle);
      }
    }
  };

  const repeat = preset.repeat;
  if (!repeat || !repeat.enabled) {
    // Sustained, looping instrument voice
    fire(1, 1, true);
    return;
  }

  // Rhythmic pattern
  let n = 0;
  const trigger = () => {
    if (!bus.active) return;
    const jitter = repeat.timingJitterSec ? (Math.random() - 0.5) * repeat.timingJitterSec : 0;
    const gainRand = repeat.gainJitter ? 1 + (Math.random() - 0.5) * repeat.gainJitter : 1;
    const panDir = repeat.alternatePan ? (n % 2 === 0 ? -1 : 1) : 1;
    fire(gainRand, panDir, false);
    if (repeat.doubleStrike?.enabled) {
      setTimeout(() => { if (bus.active) fire(gainRand * repeat.doubleStrike!.gain, -panDir, false); }, repeat.doubleStrike.delaySec * 1000);
    }
    n++;
    if (repeat.count && n >= repeat.count) { stopChannel(i); return; }
    bus.repeatTimer = setTimeout(trigger, (repeat.intervalSec + jitter) * 1000);
  };
  trigger();
}

// Current AudioContext time — used by the drum/timeline schedulers for drift-free timing.
export function getAudioTime(): number {
  return ctx?.currentTime ?? 0;
}

export function resumeAudio(): void {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume();
}

// ── Drum bus ──────────────────────────────────────────────────────
let drumBus: GainNode | null = null;

export function getDrumBus(): GainNode | null {
  const c = getCtx();
  if (!c) return null;
  if (drumBus) return drumBus;
  drumBus = c.createGain();
  drumBus.gain.value = 0.9;
  drumBus.connect(masterGainNode!);
  return drumBus;
}

export function setDrumBusVolume(v: number): void {
  const c = ctx;
  const bus = getDrumBus();
  if (bus && c) { try { bus.gain.setTargetAtTime(v, c.currentTime, 0.03); } catch {} }
}

// Fire a one-shot percussion voice into the drum bus.
export function triggerDrum(hz: number, voice: PlayOptions, gain = 1): void {
  const bus = getDrumBus();
  if (!bus) return;
  playFrequency(hz, { ...voice, loop: false, overlap: true, durationSec: 1.2, destination: bus, gainMultiplier: gain, peakGain: 0.9 });
}

// ── Master recording → 16-bit PCM WAV ─────────────────────────────
// Taps the master bus with a ScriptProcessor, accumulates float PCM, encodes WAV on stop.
let recProc: ScriptProcessorNode | null = null;
let recL: Float32Array[] = [];
let recR: Float32Array[] = [];
let recordingFlag = false;

export function isRecordingSupported(): boolean {
  const c = getCtx();
  return !!c && typeof (c as any).createScriptProcessor === "function";
}

export function startRecording(): boolean {
  const c = getCtx();
  if (!c || !masterGainNode || recordingFlag) return false;
  recL = []; recR = [];
  try {
    recProc = c.createScriptProcessor(4096, 2, 2);
  } catch {
    return false;
  }
  recProc.onaudioprocess = (e: AudioProcessingEvent) => {
    if (!recordingFlag) return;
    const ib = e.inputBuffer;
    const l = ib.getChannelData(0);
    const r = ib.numberOfChannels > 1 ? ib.getChannelData(1) : l;
    recL.push(new Float32Array(l));
    recR.push(new Float32Array(r));
  };
  masterGainNode.connect(recProc);
  recProc.connect(c.destination); // required for the processor to run (outputs silence)
  recordingFlag = true;
  return true;
}

export function stopRecording(): Promise<Blob | null> {
  return new Promise(resolve => {
    const c = ctx;
    if (!recProc || !c) { resolve(null); return; }
    recordingFlag = false;
    try { masterGainNode?.disconnect(recProc); recProc.disconnect(); } catch { /* ignore */ }
    const blob = encodeWav(recL, recR, c.sampleRate);
    recProc = null; recL = []; recR = [];
    resolve(blob);
  });
}

export function isRecording(): boolean {
  return recordingFlag;
}

function flattenChunks(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function encodeWav(lChunks: Float32Array[], rChunks: Float32Array[], sampleRate: number): Blob {
  const left = flattenChunks(lChunks);
  const right = flattenChunks(rChunks);
  const n = Math.min(left.length, right.length);
  const buffer = new ArrayBuffer(44 + n * 4); // stereo 16-bit => 4 bytes/frame
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 4, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);     // PCM chunk size
  view.setUint16(20, 1, true);      // PCM format
  view.setUint16(22, 2, true);      // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true);      // block align
  view.setUint16(34, 16, true);     // bits per sample
  writeStr(36, "data");
  view.setUint32(40, n * 4, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const sl = Math.max(-1, Math.min(1, left[i]));
    const sr = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(off, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true); off += 2;
    view.setInt16(off, sr < 0 ? sr * 0x8000 : sr * 0x7fff, true); off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

// ── Shared transport (single clock for drums + timeline) ──────────
let tPlaying = false;
let tStart = 0;
let tTimer: ReturnType<typeof setTimeout> | null = null;
const tSubs = new Set<(pos: number) => void>();

export function isTransportPlaying(): boolean { return tPlaying; }

export function subscribeTransport(fn: (pos: number) => void): () => void {
  tSubs.add(fn);
  return () => { tSubs.delete(fn); };
}

export function startTransport(): void {
  resumeAudio();
  if (tPlaying) return;
  tPlaying = true;
  tStart = getAudioTime();
  const loop = () => {
    if (!tPlaying) return;
    const pos = getAudioTime() - tStart;
    tSubs.forEach(fn => { try { fn(pos); } catch { /* ignore */ } });
    tTimer = setTimeout(loop, 16);
  };
  loop();
}

export function stopTransport(): void {
  if (!tPlaying) return;
  tPlaying = false;
  if (tTimer) { clearTimeout(tTimer); tTimer = null; }
  tSubs.forEach(fn => { try { fn(-1); } catch { /* ignore */ } }); // -1 = stopped
}

export function toggleTransport(): void {
  if (tPlaying) stopTransport(); else startTransport();
}
