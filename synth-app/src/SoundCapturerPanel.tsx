"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  playFrequency, stopFrequency, isAudioSupported, SYSTEM_CATEGORIES
} from "./frequency-synth";
import type { SynthPreset, Harmonic, NoiseBurst } from "./frequency-synth";

const STORAGE_KEY = "synth_custom_presets";

function loadCustomPresets(): Record<string, SynthPreset> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCustomPresets(p: Record<string, SynthPreset>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

// NOTE NAMES mapping for digital tuner
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function getNoteFromFrequency(frequency: number) {
  if (!frequency || frequency <= 0) return { name: "-", cents: 0, noteNum: 0 };
  const noteNum = Math.round(12 * Math.log2(frequency / 440) + 69);
  const name = NOTE_NAMES[noteNum % 12] + (Math.floor(noteNum / 12) - 1);
  const expectedFreq = 440 * Math.pow(2, (noteNum - 69) / 12);
  const cents = Math.round(1200 * Math.log2(frequency / expectedFreq));
  return { name, cents, noteNum };
}

// Hybrid Pitch Detection: Autocorrelation for lower frequencies, FFT peak interpolation for higher frequencies
function detectPitchHybrid(
  timeBuffer: Float32Array,
  freqBuffer: Float32Array,
  sampleRate: number,
  fftSize: number
): number {
  let rms = 0;
  for (let i = 0; i < timeBuffer.length; i++) {
    const val = timeBuffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / timeBuffer.length);
  if (rms < 0.008) return -1; // Silent room / room noise threshold

  const minLag = Math.floor(sampleRate / 2000);
  const maxLag = Math.ceil(sampleRate / 40);

  let bestLag = -1;
  let bestCorrelation = -1;

  const correlations = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let sumSquaresSignal = 0;
    let sumSquaresLag = 0;
    const len = timeBuffer.length - lag;
    for (let i = 0; i < len; i++) {
      const s = timeBuffer[i];
      const l = timeBuffer[i + lag];
      sum += s * l;
      sumSquaresSignal += s * s;
      sumSquaresLag += l * l;
    }
    const denom = Math.sqrt(sumSquaresSignal * sumSquaresLag);
    correlations[lag] = denom > 0 ? sum / denom : 0;
  }

  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (correlations[lag] > correlations[lag - 1] && correlations[lag] > correlations[lag + 1]) {
      if (correlations[lag] > 0.5 && correlations[lag] > bestCorrelation) {
        bestCorrelation = correlations[lag];
        bestLag = lag;
      }
    }
  }

  if (bestLag !== -1 && bestCorrelation > 0.65) {
    let T0 = bestLag;
    const alpha = correlations[bestLag - 1];
    const beta = correlations[bestLag];
    const gamma = correlations[bestLag + 1];
    const denom = alpha - 2 * beta + gamma;
    if (denom !== 0) {
      T0 = bestLag + 0.5 * (alpha - gamma) / denom;
    }
    const pitch = sampleRate / T0;
    if (pitch >= 35 && pitch <= 2200) {
      return pitch;
    }
  }

  const binHz = sampleRate / fftSize;
  const startBin = Math.floor(1800 / binHz);
  const endBin = Math.ceil(16000 / binHz);
  
  let maxVal = -Infinity;
  let maxBin = -1;

  for (let i = startBin; i <= endBin && i < freqBuffer.length; i++) {
    if (freqBuffer[i] > maxVal) {
      maxVal = freqBuffer[i];
      maxBin = i;
    }
  }

  if (maxBin > 0 && maxVal > -60) {
    let binRefined = maxBin;
    if (maxBin > startBin && maxBin < freqBuffer.length - 1) {
      const alpha = freqBuffer[maxBin - 1];
      const beta = freqBuffer[maxBin];
      const gamma = freqBuffer[maxBin + 1];
      const denom = alpha - 2 * beta + gamma;
      if (denom !== 0) {
        binRefined = maxBin + 0.5 * (alpha - gamma) / denom;
      }
    }
    const pitch = binRefined * binHz;
    if (pitch >= 40 && pitch <= 16000) {
      return pitch;
    }
  }

  return -1;
}

export default function SoundCapturerPanel({ theme = 'dark', masterVolume = 0.5 }: { theme?: 'dark' | 'light', masterVolume?: number }) {
  const colors = theme === 'light' ? {
    bg: "#f8f9fa",
    panel: "#ffffff",
    accent: "#ff2a6d", // pink
    accentCyan: "#05d9e8", // cyan
    accentAmber: "#ffb347", // amber
    text: "#0f172a",
    textSecondary: "#64748b",
    border: "#e2e8f0",
    canvasBg: "#ffffff"
  } : {
    bg: "#121212",
    panel: "#1e1e1e",
    accent: "#ff2a6d",
    accentCyan: "#05d9e8",
    accentAmber: "#ffb347",
    text: "#e0e0e0",
    textSecondary: "#9aa0a6",
    border: "#333333",
    canvasBg: "#181818"
  };

  const hColors = theme === 'light'
    ? ["#2563eb", "#db2777", "#d97706", "#65a30d", "#7c3aed", "#c026d3", "#0d9488", "#475569"]
    : ["#05d9e8", "#ff2a6d", "#ffb347", "#a6e22e", "#9b5de5", "#f15bb5", "#00f5d4", "#ffffff"];

  const [supported, setSupported] = useState(true);
  const [micState, setMicState] = useState<"disabled" | "starting" | "enabled">("disabled");
  const [detectedHz, setDetectedHz] = useState<number>(-1);
  const [noteInfo, setNoteInfo] = useState<{ name: string; cents: number }>({ name: "-", cents: 0 });
  const [isLocked, setIsLocked] = useState<boolean>(false);

  // Capture / Freeze / Record variables
  const [capHz, setCapHz] = useState<number>(0);
  const [capHarmonics, setCapHarmonics] = useState<Harmonic[]>([]);
  const [isAveraging, setIsAveraging] = useState<boolean>(false);
  const [avgProgress, setAvgProgress] = useState<number>(0);

  // Dynamic Harmonic Envelope Analysis states
  const [isRecordingEnvelope, setIsRecordingEnvelope] = useState<boolean>(false);
  const [envelopeDuration, setEnvelopeDuration] = useState<number>(5); // Default 5 seconds, can be 10s
  const [recProgress, setRecProgress] = useState<number>(0);
  const [recordedDecays, setRecordedDecays] = useState<number[]>(Array(16).fill(1.5));
  const [hasRecordedEnvelope, setHasRecordedEnvelope] = useState<boolean>(false);

  // Refs for animation loop (avoid closure stale state bugs)
  const isAveragingRef = useRef<boolean>(false);
  const isRecordingEnvelopeRef = useRef<boolean>(false);

  useEffect(() => {
    isAveragingRef.current = isAveraging;
  }, [isAveraging]);

  useEffect(() => {
    isRecordingEnvelopeRef.current = isRecordingEnvelope;
  }, [isRecordingEnvelope]);

  // Advanced detected characteristics
  const [detectedVibratoHz, setDetectedVibratoHz] = useState<number>(0);
  const [detectedVibratoCents, setDetectedVibratoCents] = useState<number>(0);

  // Developer Preset Export Code
  const [showPresetCode, setShowPresetCode] = useState<boolean>(false);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // Audio File Analysis states
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [decodedBuffer, setDecodedBuffer] = useState<AudioBuffer | null>(null);
  const [isDecoding, setIsDecoding] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [listenDuringAnalysis, setListenDuringAnalysis] = useState<boolean>(true);
  const [fileAnalysisState, setFileAnalysisState] = useState<"idle" | "playing" | "paused">("idle");
  const [capNoiseBursts, setCapNoiseBursts] = useState<NoiseBurst[]>([]);

  // Playback Audition
  const [isPlayingAudition, setIsPlayingAudition] = useState<boolean>(false);

  // --- EDIT HANDLERS FOR SEQUENCER ---
  const updateHarmonicDelay = (index: number, newDelay: number) => {
    const updated = [...capHarmonics];
    updated[index] = { ...updated[index], delaySec: Math.max(0, newDelay) };
    setCapHarmonics(updated);
  };

  const updateBurstDelay = (index: number, newDelay: number) => {
    const updated = [...capNoiseBursts];
    updated[index] = { ...updated[index], delaySec: Math.max(0, newDelay) };
    setCapNoiseBursts(updated);
  };

  // Form Fields for Customize and Import
  const [presetName, setPresetName] = useState<string>("Captured Sound");
  const [presetCategory, setPresetCategory] = useState<string>("uncategorized");
  const [presetWaveform, setPresetWaveform] = useState<OscillatorType>("sine");
  const [atkSec, setAtkSec] = useState<number>(0.2);
  const [decSec, setDecSec] = useState<number>(1.5);
  const [susRatio, setSusRatio] = useState<number>(0.3);
  const [relSec, setRelSec] = useState<number>(2.5);
  const [testPlayDuration, setTestPlayDuration] = useState<number>(12); // Adjustable play duration
  const [reverbWet, setReverbWet] = useState<number>(0.3);
  const [reverbDecay, setReverbDecay] = useState<number>(4.0);
  const [lowpassHz, setLowpassHz] = useState<number>(12000);
  const [highpassHz, setHighpassHz] = useState<number>(20);
  const [, setCustomPresets] = useState<Record<string, SynthPreset>>(loadCustomPresets);

  // Web Audio Nodes refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  
  // File Player Nodes refs
  const fileSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const filePlayGainRef = useRef<GainNode | null>(null);

  // Canvas Refs  // References to visualizer canvases
  const tunerCanvasRef = useRef<HTMLCanvasElement>(null);
  const oscilloscopeCanvasRef = useRef<HTMLCanvasElement>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null);
  const harmonicsCanvasRef = useRef<HTMLCanvasElement>(null);
  const envelopeCanvasRef = useRef<HTMLCanvasElement>(null);
  const harmonicsMouseRef = useRef<{ x: number, y: number, isHovering: boolean }>({ x: -1, y: -1, isHovering: false });
  const spectrumMouseRef = useRef<{ x: number, y: number, isHovering: boolean }>({ x: -1, y: -1, isHovering: false });

  // Visualizer Smoothing Refs
  const smoothedHarmonicsRef = useRef<number[]>(Array(16).fill(0));
  const liveFrequenciesRef = useRef<number[]>(Array(16).fill(0));
  const fftPeakHoldRef = useRef<Float32Array | null>(null);
  const capHarmonicsRef = useRef<Harmonic[]>([]);
  const capHzRef = useRef<number>(0);

  useEffect(() => {
    capHarmonicsRef.current = capHarmonics;
    capHzRef.current = capHz;
  }, [capHarmonics, capHz]);

  // Real-time Master Volume Link
  useEffect(() => {
    if (filePlayGainRef.current) {
      // Ramp gain to avoid clicking noises
      filePlayGainRef.current.gain.setTargetAtTime(
        listenDuringAnalysis ? masterVolume : 0.0,
        audioCtxRef.current?.currentTime || 0,
        0.05
      );
    }
  }, [masterVolume, listenDuringAnalysis]);

  // ResizeObserver to dynamically update canvas internal resolution
  useEffect(() => {
    const canvases = [
      tunerCanvasRef.current,
      oscilloscopeCanvasRef.current,
      spectrumCanvasRef.current,
      harmonicsCanvasRef.current,
      envelopeCanvasRef.current
    ];
    
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const canvas = entry.target as HTMLCanvasElement;
        const rect = entry.contentRect;
        const newW = Math.floor(rect.width);
        const newH = Math.floor(rect.height);
        
        // Only assign if changed, because assigning clears the canvas buffer!
        if (canvas.width !== newW) canvas.width = newW;
        if (canvas.height !== newH) canvas.height = newH;
      }
    });

    canvases.forEach(c => { if (c) observer.observe(c); });
    return () => observer.disconnect();
  }, []);


  // Data refs
  const avgBufferRef = useRef<{ hz: number; harmonics: number[] }[]>([]);
  const averagingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const envelopeHistoryRef = useRef<{ 
    time: number; 
    amplitudes: number[]; 
    frequencies: number[]; 
    freqData?: Float32Array;
    noiseEnergy?: number;
  }[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const lastKnownHzRef = useRef<number>(136.1);

  useEffect(() => {
    setSupported(isAudioSupported());
    return () => {
      stopMic();
      stopFileAnalysis();
    };
  }, []);

  // Sync Form when capture changes
  useEffect(() => {
    if (capHz > 0) {
      setPresetName(`Captured ${noteInfo.name} (${Math.round(capHz)}Hz)`);
    }
  }, [capHz]);

  const startMic = async () => {
    if (micState !== "disabled") return;
    setMicState("starting");
    stopFileAnalysis();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const actx = new AudioContextClass();
      audioCtxRef.current = actx;
      micStreamRef.current = stream;

      const source = actx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const analyser = actx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.4;
      analyserNodeRef.current = analyser;

      source.connect(analyser);
      setMicState("enabled");

      runAnalysisLoop();
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Не удалось получить доступ к микрофону. Проверьте разрешения в браузере.");
      setMicState("disabled");
    }
  };

  const stopMic = () => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    if (averagingTimerRef.current) {
      clearInterval(averagingTimerRef.current);
      averagingTimerRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (audioCtxRef.current && !decodedBuffer) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    setMicState("disabled");
    setDetectedHz(-1);
    setNoteInfo({ name: "-", cents: 0 });
    setIsLocked(false);
    setIsRecordingEnvelope(false);
    setIsAveraging(false);
  };

  const processFile = async (file: File) => {
    setSelectedFile(file);
    setIsDecoding(true);
    setDecodedBuffer(null);
    stopMic();
    stopFileAnalysis();

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const arrayBuffer = event.target?.result as ArrayBuffer;
        if (!arrayBuffer) return;

        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioContextClass();
        }
        
        const actx = audioCtxRef.current;
        try {
          const buffer = await actx.decodeAudioData(arrayBuffer);
          setDecodedBuffer(buffer);
          setPresetName(file.name.replace(/\.[^/.]+$/, ""));
          setIsDecoding(false);
        } catch (decodeErr) {
          console.error("Error decoding audio data:", decodeErr);
          alert("Не удалось декодировать файл. Убедитесь, что это корректный аудио или видеофайл (.wav, .mp3, .ogg, .flac, .mp4, .m4a, .mov).");
          setIsDecoding(false);
        }
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      console.error("Error reading file:", err);
      setIsDecoding(false);
    }
  };

  // Audio File Upload Handler
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
  };

  // Start Audio File Analysis Player
  const handleStartFileAnalysis = () => {
    if (!decodedBuffer || !audioCtxRef.current) {
      alert("Сначала загрузите звуковой файл!");
      return;
    }

    stopMic();
    stopFileAnalysis();

    const actx = audioCtxRef.current;
    if (actx.state === "suspended") {
      void actx.resume();
    }

    // Set up Analyser if not created
    let analyser = analyserNodeRef.current;
    if (!analyser) {
      analyser = actx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.4;
      analyserNodeRef.current = analyser;
    }

    // Create Buffer Source Node for playing the file
    const source = actx.createBufferSource();
    source.buffer = decodedBuffer;
    fileSourceRef.current = source;

    // Create Gain Node to control hearing the file during analysis
    const playGain = actx.createGain();
    playGain.gain.value = listenDuringAnalysis ? masterVolume : 0.0;
    filePlayGainRef.current = playGain;

    // Connect source -> analyser -> playGain -> destination
    source.connect(analyser);
    analyser.connect(playGain);
    playGain.connect(actx.destination);

    // Reset recording variables
    setIsRecordingEnvelope(true);
    setRecProgress(0);
    setHasRecordedEnvelope(false);
    setDetectedVibratoHz(0);
    setDetectedVibratoCents(0);
    envelopeHistoryRef.current = [];
    recordingStartTimeRef.current = Date.now();
    avgBufferRef.current = [];

    // Play
    source.start(0);
    setMicState("enabled"); // Mock enabled state to allow drawing frames
    setFileAnalysisState("playing");

    // Set up continuous frames rendering
    runAnalysisLoop();

    // Set up timer to end analysis matching file length or max selected duration
    const fileDuration = decodedBuffer.duration;
    const durationSec = Math.min(envelopeDuration, fileDuration);
    const durationMs = durationSec * 1000;
    const intervalMs = 50;
    const totalSteps = durationMs / intervalMs;
    let count = 0;

    averagingTimerRef.current = setInterval(() => {
      count++;
      setRecProgress(Math.min(100, Math.round((count / totalSteps) * 100)));

      if (detectedHz > 0 && isLocked) {
        avgBufferRef.current.push({ hz: detectedHz, harmonics: [] });
      }

      if (count >= totalSteps) {
        stopFileAnalysis();
        setIsRecordingEnvelope(false);
        processEnvelopeRecording();
      }
    }, intervalMs);
  };

  const stopFileAnalysis = () => {
    if (averagingTimerRef.current) {
      clearInterval(averagingTimerRef.current);
      averagingTimerRef.current = null;
    }

    if (fileSourceRef.current) {
      try {
        fileSourceRef.current.stop();
      } catch {}
      fileSourceRef.current.disconnect();
      fileSourceRef.current = null;
    }

    if (filePlayGainRef.current) {
      filePlayGainRef.current.disconnect();
      filePlayGainRef.current = null;
    }

    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }

    setMicState("disabled");
    setIsRecordingEnvelope(false);
    setFileAnalysisState("idle");
  };

  const handlePauseFileAnalysis = () => {
    if (audioCtxRef.current && fileAnalysisState === "playing") {
      audioCtxRef.current.suspend();
      setFileAnalysisState("paused");
      setIsRecordingEnvelope(false); // Pause data accumulation
      if (averagingTimerRef.current) {
        clearInterval(averagingTimerRef.current);
        averagingTimerRef.current = null;
      }
    }
  };

  const handleResumeFileAnalysis = () => {
    if (audioCtxRef.current && fileAnalysisState === "paused") {
      audioCtxRef.current.resume();
      setFileAnalysisState("playing");
      setIsRecordingEnvelope(true); // Resume data accumulation
      
      // Resume the timer tracking
      const fileDuration = decodedBuffer?.duration || envelopeDuration;
      const durationSec = Math.min(envelopeDuration, fileDuration);
      const durationMs = durationSec * 1000;
      const intervalMs = 50;
      const totalSteps = durationMs / intervalMs;
      // Calculate remaining steps based on current progress
      let count = Math.floor((recProgress / 100) * totalSteps);

      averagingTimerRef.current = setInterval(() => {
        count++;
        setRecProgress(Math.min(100, Math.round((count / totalSteps) * 100)));

        if (detectedHz > 0 && isLocked) {
          avgBufferRef.current.push({ hz: detectedHz, harmonics: [] });
        }

        if (count >= totalSteps) {
          stopFileAnalysis();
          setIsRecordingEnvelope(false);
          processEnvelopeRecording();
        }
      }, intervalMs);
    }
  };

  const runAnalysisLoop = () => {
    const analyser = analyserNodeRef.current;
    if (!analyser || !audioCtxRef.current) return;

    const sampleRate = audioCtxRef.current.sampleRate;
    const fftSize = analyser.fftSize;

    const timeData = new Float32Array(fftSize);
    const freqData = new Float32Array(analyser.frequencyBinCount);

    const update = () => {
      analyser.getFloatTimeDomainData(timeData);
      analyser.getFloatFrequencyData(freqData);

      const binHz = sampleRate / fftSize;

      // 1. Detect Pitch
      const pitch = detectPitchHybrid(timeData, freqData, sampleRate, fftSize);

      let currentHz = -1;
      let currentNote = { name: "-", cents: 0 };
      let locked = false;

      if (pitch > 35 && pitch < 16000) {
        currentHz = pitch;
        const note = getNoteFromFrequency(pitch);
        currentNote = { name: note.name, cents: note.cents };
        locked = true;
        lastKnownHzRef.current = pitch;
      }

      setDetectedHz(currentHz);
      setNoteInfo(currentNote);
      setIsLocked(locked);

      // 2. Measure Harmonic Volumes & Exact Peak Frequencies (to capture Inharmonicity!)
      let realTimeHarmonics: number[] = Array(16).fill(0);
      let realTimeFrequencies: number[] = Array(16).fill(0);
      let localMaxima: number[] = [];
      for (let i = 1; i < freqData.length - 1; i++) {
        if (freqData[i] >= freqData[i-1] && freqData[i] > freqData[i+1] && freqData[i] > -130) {
          localMaxima.push(i);
        }
      }

      let livePeaks: { bin: number, hz: number, ampDb: number, prominence: number }[] = [];
      for (let maxIdx of localMaxima) {
        let amp = freqData[maxIdx];
        let minL = amp;
        for (let j = maxIdx - 1; j >= 0; j--) {
           if (freqData[j] > amp) break;
           if (freqData[j] < minL) minL = freqData[j];
        }
        let minR = amp;
        for (let j = maxIdx + 1; j < freqData.length; j++) {
           if (freqData[j] > amp) break;
           if (freqData[j] < minR) minR = freqData[j];
        }
        let prominence = amp - Math.max(minL, minR);
        
        const alpha = freqData[maxIdx-1], beta = freqData[maxIdx], gamma = freqData[maxIdx+1];
        const denom = alpha - 2*beta + gamma;
        let refinedBin = maxIdx;
        let peakDb = beta;
        if (denom !== 0) {
          const offset = 0.5 * (alpha - gamma) / denom;
          refinedBin = maxIdx + offset;
          peakDb = beta - 0.25 * (alpha - gamma) * offset;
        }
        livePeaks.push({ bin: refinedBin, hz: refinedBin * binHz, ampDb: peakDb, prominence });
      }
      
      // Sort purely by Prominence (topological height)
      livePeaks.sort((a, b) => b.prominence - a.prominence);
      const topLivePeaks: typeof livePeaks = [];
      for (let p of livePeaks) {
        if (topLivePeaks.length >= 16) break;
        let tooClose = false;
        const minDistance = Math.max(80, p.hz * 0.08); // Minimum 80Hz apart, or 8% of frequency
        for (let t of topLivePeaks) {
          if (Math.abs(p.hz - t.hz) < minDistance) { tooClose = true; break; }
        }
        if (!tooClose) topLivePeaks.push(p);
      }
      topLivePeaks.sort((a, b) => a.hz - b.hz); // Sort by frequency from left to right

      if (topLivePeaks.length > 0) {
         let f0AmpDb = topLivePeaks.reduce((max, p) => p.ampDb > max ? p.ampDb : max, -150);
         const linearMaxAmp = Math.pow(10, f0AmpDb / 20);

         for (let i = 0; i < 16; i++) {
           if (i < topLivePeaks.length) {
              const peakDb = topLivePeaks[i].ampDb;
              const linearAmp = Math.pow(10, peakDb / 20);
              realTimeHarmonics[i] = Math.min(1.0, linearAmp / linearMaxAmp);
              realTimeFrequencies[i] = topLivePeaks[i].hz;
           } else {
              realTimeHarmonics[i] = 0;
              realTimeFrequencies[i] = 0;
           }
         }
      }
      
      liveFrequenciesRef.current = realTimeFrequencies;

      // 3. Accumulate for average mode
      if (isAveragingRef.current && locked && currentHz > 0) {
        avgBufferRef.current.push({ hz: currentHz, harmonics: [...realTimeHarmonics] });
      }

      // 3b. Accumulate for Dynamic Envelope & Vibrato Recording
      if (isRecordingEnvelopeRef.current) {
        const timeElapsed = Date.now() - recordingStartTimeRef.current;
        envelopeHistoryRef.current.push({
          time: timeElapsed,
          amplitudes: [...realTimeHarmonics],
          frequencies: [...realTimeFrequencies],
          freqData: new Float32Array(freqData)
        });
      }

      // Apply exponential smoothing for the bar chart (active balance)
      for (let i = 0; i < 16; i++) {
        smoothedHarmonicsRef.current[i] = smoothedHarmonicsRef.current[i] * 0.85 + realTimeHarmonics[i] * 0.15;
      }

      // 4. Render Canvas elements
      drawOscilloscope(timeData);
      drawSpectrum(freqData, currentHz, binHz);
      drawTuner(currentNote, locked);
      drawHarmonics(smoothedHarmonicsRef.current);

      animationFrameIdRef.current = requestAnimationFrame(update);
    };

    animationFrameIdRef.current = requestAnimationFrame(update);
  };

  // Canvas Oscilloscope Renderer
  const drawOscilloscope = (data: Float32Array) => {
    const canvas = oscilloscopeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "#06060c";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "#111b2e";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 30) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 20) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    ctx.shadowBlur = 4;
    ctx.shadowColor = "#ff2a6d";
    ctx.strokeStyle = "#ff2a6d";
    ctx.lineWidth = 2;
    ctx.beginPath();

    const sliceW = w / 512;
    for (let i = 0; i < 512; i++) {
      const x = i * sliceW;
      const y = (0.5 + data[i] * 0.8) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  // Canvas FFT Spectrum Renderer with Harmonic Pointers
  const drawSpectrum = (freqData: Float32Array, _fundamentalHz: number, binHz: number, isHoverOnly = false) => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = colors.canvasBg;
    ctx.fillRect(0, 0, w, h);
    
    // Draw frequency grid (vertical lines)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    [100, 1000, 10000].forEach(hz => {
      const p = Math.log10(hz / binHz) / Math.log10(freqData.length);
      const x = p * w;
      if (x > 0 && x < w) {
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
      }
    });
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = "#05d9e8";
    ctx.lineWidth = 2;
    ctx.shadowBlur = 3;

    const totalBins = freqData.length;
    const logMax = Math.log10(totalBins);

    // Initialize or decay peak hold array
    if (!fftPeakHoldRef.current || fftPeakHoldRef.current.length !== totalBins) {
      fftPeakHoldRef.current = new Float32Array(totalBins);
      fftPeakHoldRef.current.fill(-150);
    }
    const peakHold = fftPeakHoldRef.current;
    
    if (!isHoverOnly) {
      for (let i = 0; i < totalBins; i++) {
        peakHold[i] = Math.max(freqData[i], peakHold[i] - 0.7); // Decay peak by 0.7dB per frame
      }
    }

    // Draw Peak Hold Ghost Line
    ctx.beginPath();
    ctx.strokeStyle = "rgba(5, 217, 232, 0.3)";
    ctx.lineWidth = 1.5;
    for (let x = 0; x < w; x++) {
      const percent = x / w;
      const binIdx = Math.max(1, Math.floor(Math.pow(10, percent * logMax)));
      const valDb = peakHold[Math.min(totalBins - 1, binIdx)];
      const dbClamped = Math.max(-110, Math.min(-10, valDb));
      const percentY = (dbClamped + 110) / 100;
      const y = h - 5 - (percentY * (h - 10));
      
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw Active Live Spectrum
    ctx.beginPath();
    ctx.strokeStyle = "#05d9e8";
    ctx.lineWidth = 2;
    ctx.shadowBlur = 3;
    ctx.shadowColor = "#05d9e8";

    for (let x = 0; x < w; x++) {
      const percent = x / w;
      const binIdx = Math.max(1, Math.floor(Math.pow(10, percent * logMax)));
      const valDb = freqData[Math.min(totalBins - 1, binIdx)];
      
      const dbClamped = Math.max(-110, Math.min(-10, valDb));
      const percentY = (dbClamped + 110) / 100;
      const y = h - 5 - (percentY * (h - 10));
      
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    const currentCapHarmonics = capHarmonicsRef.current;
    const currentCapHz = capHzRef.current;
    const markers = (currentCapHarmonics && currentCapHarmonics.length > 0 && currentCapHz > 0) 
       ? currentCapHarmonics.map((h, i) => ({
           hz: currentCapHz * (h.multiple !== undefined ? h.multiple : (i + 1)),
           label: i === 0 ? "f0" : `CH${i + 1}`,
           color: hColors[i % hColors.length] || "#ffb347",
           text: `${(currentCapHz * (h.multiple !== undefined ? h.multiple : (i + 1))).toFixed(1)} Hz (${Math.round(h.gainRatio * 100)}%)`
         }))
       : liveFrequenciesRef.current.map((hz, i) => ({
           hz: hz,
           label: i === 0 ? "f0" : `P${i + 1}`,
           color: i === 0 ? "#ff2a6d" : "#ffb347",
           text: hz > 0 ? `${hz.toFixed(1)} Hz` : ""
         })).filter(m => m.hz > 0);

    if (markers.length > 0) {
      ctx.lineWidth = 1.5;
      ctx.font = "bold 13px sans-serif";
      markers.forEach((marker, k) => {
        const targetHz = marker.hz;
        if (targetHz > 21000 || targetHz <= 0) return;

        const binIdx = Math.max(1, targetHz / binHz);
        const percent = Math.log10(binIdx) / logMax;
        const x = percent * w;

        if (x >= 0 && x < w) {
          ctx.strokeStyle = marker.color;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, 110); // Start line below the text levels
          ctx.lineTo(x, h);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = marker.color;
          ctx.shadowColor = "#000";
          ctx.shadowBlur = 4;
          
          // Stagger Y position across 4 levels to prevent overlapping text
          const level = k % 4;
          const yPos = 16 + (level * 24); 
          
          ctx.fillText(marker.label, x + 5, yPos);
          
          ctx.fillStyle = k === 0 ? "#fff" : marker.color;
          ctx.font = k === 0 ? "bold 12px sans-serif" : "bold 10px sans-serif";
          ctx.fillText(marker.text, x + 5, yPos + 12);
          
          ctx.shadowBlur = 0;
        }
      });
    }

    // Draw Interactive Hover Cursor
    if (spectrumMouseRef.current.isHovering) {
      const mouseX = spectrumMouseRef.current.x;
      if (mouseX >= 0 && mouseX < w) {
        // Calculate the exact Hz at this pixel using the logarithmic formula
        const percent = mouseX / w;
        const binIdx = Math.max(1, Math.floor(Math.pow(10, percent * logMax)));
        const exactHz = binIdx * binHz;
        const exactDb = freqData[Math.min(totalBins - 1, binIdx)];

        // Draw vertical line
        ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(mouseX, 0);
        ctx.lineTo(mouseX, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw tooltip
        const tooltipW = 85;
        const tooltipH = 34;
        let tx = mouseX + 10;
        let ty = 10;
        
        // Prevent tooltip from overflowing the right edge
        if (tx + tooltipW > w) {
          tx = mouseX - tooltipW - 10;
        }

        ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
        ctx.strokeStyle = "#444";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px sans-serif";
        ctx.fillText(`${exactHz.toFixed(0)} Hz`, tx + 6, ty + 14);
        
        ctx.fillStyle = "#05d9e8";
        ctx.font = "10px sans-serif";
        ctx.fillText(`${exactDb.toFixed(1)} dB`, tx + 6, ty + 28);
      }
    }
  };

  // Canvas Tuner Ring Renderer
  const drawTuner = (note: { name: string; cents: number }, locked: boolean) => {
    const canvas = tunerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 12;

    ctx.fillStyle = "#06060c";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = locked ? "#ff2a6d" : "#222233";
    ctx.lineWidth = 3;
    ctx.shadowBlur = locked ? 6 : 0;
    ctx.shadowColor = "#ff2a6d";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = "#333344";
    ctx.lineWidth = 1;
    for (let c = -50; c <= 50; c += 10) {
      const angle = (c * (Math.PI / 100)) - (Math.PI / 2);
      const x1 = cx + Math.cos(angle) * (radius - 5);
      const y1 = cy + Math.sin(angle) * (radius - 5);
      const x2 = cx + Math.cos(angle) * radius;
      const y2 = cy + Math.sin(angle) * radius;

      ctx.strokeStyle = c === 0 ? "#05d9e8" : "#333344";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    if (locked) {
      const angle = (note.cents * (Math.PI / 100)) - (Math.PI / 2);
      const needleLength = radius - 15;
      
      ctx.shadowBlur = 8;
      ctx.shadowColor = "#05d9e8";
      ctx.strokeStyle = "#05d9e8";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * needleLength, cy + Math.sin(angle) * needleLength);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = "#ff2a6d";
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = locked ? "#ffffff" : "#444455";
    ctx.font = "bold 26px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(note.name, cx, cy - 8);

    if (locked) {
      ctx.fillStyle = Math.abs(note.cents) < 5 ? "#05d9e8" : "#ffb347";
      ctx.font = "bold 12px monospace";
      ctx.fillText(
        note.cents === 0 ? "IN TUNE" : `${note.cents > 0 ? "+" : ""}${note.cents} ¢`,
        cx,
        cy + 18
      );
    } else {
      ctx.fillStyle = "#8a8a8a";
      ctx.font = "11px monospace";
      ctx.fillText("NO SIGNAL", cx, cy + 18);
    }
  };

  // Canvas Harmonics Live Bar-mixer Renderer
  const drawHarmonics = (harmonics: number[]) => {
    const canvas = harmonicsCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "#06060c";
    ctx.fillRect(0, 0, w, h);

    const barCount = 16;
    const padding = 6;
    const barW = (w - (padding * (barCount + 1))) / barCount;

    for (let i = 0; i < barCount; i++) {
      const val = harmonics[i] || 0;
      const barH = val * (h - 25);
      const x = padding + i * (barW + padding);
      const y = h - 20 - barH;

      ctx.fillStyle = "#11111c";
      ctx.fillRect(x, 5, barW, h - 25);

      if (val > 0) {
        const grad = ctx.createLinearGradient(0, y, 0, h - 20);
        grad.addColorStop(0, "#05d9e8");
        grad.addColorStop(1, "rgba(5, 217, 232, 0.2)");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, barW, 2);

        ctx.fillStyle = i === 0 ? "#ff2a6d" : "#05d9e8";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        const pct = Math.round(val * 100) + "%";
        const textY = Math.max(12, y - 6); 
        ctx.fillText(pct, x + barW / 2, textY);
      }

      ctx.fillStyle = "#8a8a8a";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`CH${i + 1}`, x + barW / 2, h - 6);
    }

    // Draw Tooltip if hovering
    const mouse = harmonicsMouseRef.current;
    if (mouse.isHovering) {
      for (let i = 0; i < barCount; i++) {
        const x = padding + i * (barW + padding);
        if (mouse.x >= x && mouse.x <= x + barW) {
          const val = harmonics[i] || 0;
          const pct = Math.round(val * 100);
          // Add captured data if available
          const cap = capHarmonics && capHarmonics.length > i ? capHarmonics[i] : null;
          const baseHz = (cap && hasRecordedEnvelope) ? capHzRef.current : detectedHz;
          const hz = baseHz > 0 ? (baseHz * (i + 1)).toFixed(1) + " Hz" : "---";
          
          let tooltipLines = [
            `ГАРМОНИКА CH${i + 1} (${i === 0 ? "f0" : (i + 1) + "f"})`,
            `Частота: ${hz}`,
            `Амплитуда (Real-time): ${pct}%`
          ];

          // Add captured data if available
          if (cap) {
            tooltipLines.push(`--- ЗАХВАЧЕНО ---`);
            tooltipLines.push(`Громкость: ${Math.round(cap.gainRatio * 100)}%`);
            tooltipLines.push(`Затухание (Decay): ${cap.decaySec !== undefined ? cap.decaySec.toFixed(2) + "s" : "N/A"}`);
            if (cap.detuneCentsRange) {
              tooltipLines.push(`Расстройка: ±${cap.detuneCentsRange}¢`);
            }
          }

          // Tooltip dimensions
          ctx.font = "11px sans-serif";
          ctx.textAlign = "left";
          let maxW = 0;
          for (const line of tooltipLines) {
            maxW = Math.max(maxW, ctx.measureText(line).width);
          }
          const tooltipW = maxW + 20;
          const tooltipH = tooltipLines.length * 16 + 16;
          
          // Position tooltip so it doesn't go off-canvas
          let tX = mouse.x + 15;
          let tY = mouse.y - 15;
          if (tX + tooltipW > w) tX = mouse.x - tooltipW - 15;
          if (tY + tooltipH > h) tY = h - tooltipH - 10;
          if (tY < 0) tY = 10;

          // Draw tooltip box
          ctx.shadowColor = "rgba(0,0,0,0.5)";
          ctx.shadowBlur = 8;
          ctx.fillStyle = "rgba(10, 10, 20, 0.95)";
          ctx.strokeStyle = i === 0 ? "#ff2a6d" : "#05d9e8";
          ctx.lineWidth = 1;
          
          ctx.beginPath();
          ctx.roundRect(tX, tY, tooltipW, tooltipH, 6);
          ctx.fill();
          ctx.stroke();
          
          ctx.shadowBlur = 0;

          // Draw text
          for (let j = 0; j < tooltipLines.length; j++) {
            const line = tooltipLines[j];
            if (j === 0) {
              ctx.fillStyle = i === 0 ? "#ff2a6d" : "#05d9e8";
              ctx.font = "bold 11px sans-serif";
            } else if (line.startsWith("---")) {
              ctx.fillStyle = colors.accentAmber;
              ctx.font = "bold 10px monospace";
            } else {
              ctx.fillStyle = "#ffffff";
              ctx.font = "11px sans-serif";
            }
            ctx.fillText(line, tX + 10, tY + 20 + j * 16);
          }
          break; // only draw one tooltip
        }
      }
    }
  };

  // Action: Freeze Capture (Snapshot)
  const handleFreezeCapture = () => {
    if (detectedHz <= 0 || !isLocked) {
      alert("Не обнаружен стабильный звуковой сигнал для захвата. Пожалуйста, пойте или играйте звук в микрофон!");
      return;
    }
    setCapHz(detectedHz);
    setHasRecordedEnvelope(false);
    setDetectedVibratoHz(0);
    setDetectedVibratoCents(0);
    
    const activeHarmonics: Harmonic[] = [];
    const analyser = analyserNodeRef.current;
    if (analyser && audioCtxRef.current) {
      const sampleRate = audioCtxRef.current.sampleRate;
      const fftSize = analyser.fftSize;
      const freqData = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(freqData);

      const binHz = sampleRate / fftSize;
      const rawAmps: number[] = [];

      for (let k = 1; k <= 16; k++) {
        const targetHz = detectedHz * k;
        if (targetHz > 21000) break;
        const targetBin = Math.round(targetHz / binHz);
        let maxAmpDb = -120;
        for (let offset = -2; offset <= 2; offset++) {
          const b = targetBin + offset;
          if (b >= 0 && b < freqData.length) {
            maxAmpDb = Math.max(maxAmpDb, freqData[b]);
          }
        }
        const ampLinear = Math.max(0, (maxAmpDb + 90) / 90);
        rawAmps.push(ampLinear);
      }

      const f0Amp = rawAmps[0] || 0.1;
      for (let i = 0; i < 16; i++) {
        const ratio = Math.min(1.0, (rawAmps[i] || 0) / f0Amp);
        if (i === 0 || ratio > 0.02) {
          activeHarmonics.push({
            multiple: i + 1,
            gainRatio: parseFloat(ratio.toFixed(3)),
            gainL: parseFloat((ratio * 0.5).toFixed(3)),
            gainR: parseFloat((ratio * 0.5).toFixed(3)),
            decaySec: decSec,
            pan: parseFloat(([0, -0.3, 0.3, -0.15, 0.15, -0.4, 0.4, 0][i] || 0).toFixed(2))
          });
        }
      }
    }

    setCapHarmonics(activeHarmonics);
  };

  // Action: Live Recording Average over 3 Seconds (Static Tone Profile)
  const handleStartAveraging = () => {
    if (micState !== "enabled") {
      alert("Пожалуйста, сначала включите микрофон!");
      return;
    }
    setIsAveraging(true);
    setAvgProgress(0);
    avgBufferRef.current = [];
    setHasRecordedEnvelope(false);
    setDetectedVibratoHz(0);
    setDetectedVibratoCents(0);

    let count = 0;
    const durationMs = 3000;
    const intervalMs = 100;
    const totalSteps = durationMs / intervalMs;

    averagingTimerRef.current = setInterval(() => {
      count++;
      const prog = Math.round((count / totalSteps) * 100);
      setAvgProgress(prog);

      if (count >= totalSteps) {
        clearInterval(averagingTimerRef.current!);
        averagingTimerRef.current = null;
        setIsAveraging(false);

        const validSnapshots = avgBufferRef.current;
        if (validSnapshots.length === 0) {
          alert("Запись завершена, но не удалось зафиксировать стабильный тон. Пожалуйста, попробуйте еще раз!");
          return;
        }

        let sumHz = 0;
        validSnapshots.forEach(snap => sumHz += snap.hz);
        const finalHz = sumHz / validSnapshots.length;

        const sumHarmonics = Array(16).fill(0);
        validSnapshots.forEach(snap => {
          for (let i = 0; i < 16; i++) {
            sumHarmonics[i] += snap.harmonics[i] || 0;
          }
        });

        const averagedAmps: Harmonic[] = [];
        const f0Amp = sumHarmonics[0] / validSnapshots.length || 0.1;

        for (let i = 0; i < 16; i++) {
          const avgRatio = Math.min(1.0, (sumHarmonics[i] / validSnapshots.length) / f0Amp);
          if (i === 0 || avgRatio > 0.02) {
            averagedAmps.push({
              multiple: i + 1,
              gainRatio: parseFloat(avgRatio.toFixed(3)),
              gainL: parseFloat((avgRatio * 0.5).toFixed(3)),
              gainR: parseFloat((avgRatio * 0.5).toFixed(3)),
              decaySec: decSec,
              pan: parseFloat(([0, -0.3, 0.3, -0.15, 0.15, -0.4, 0.4, 0][i] || 0).toFixed(2))
            });
          }
        }

        setCapHz(finalHz);
        setCapHarmonics(averagedAmps);
      }
    }, intervalMs);
  };

  // Action: Dynamic Harmonic Envelope & Advanced Characteristics Recording (5s - 15s)
  const handleStartEnvelopeRecording = () => {
    if (micState !== "enabled") {
      alert("Пожалуйста, сначала включите микрофон!");
      return;
    }

    setIsRecordingEnvelope(true);
    setRecProgress(0);
    setHasRecordedEnvelope(false);
    setDetectedVibratoHz(0);
    setDetectedVibratoCents(0);
    envelopeHistoryRef.current = [];
    recordingStartTimeRef.current = Date.now();

    avgBufferRef.current = [];

    const durationMs = envelopeDuration * 1000;
    const intervalMs = 50;
    const totalSteps = durationMs / intervalMs;
    let count = 0;

    const timer = setInterval(() => {
      count++;
      setRecProgress(Math.min(100, Math.round((count / totalSteps) * 100)));

      if (detectedHz > 0 && isLocked) {
        avgBufferRef.current.push({ hz: detectedHz, harmonics: [] });
      }

      if (count >= totalSteps) {
        clearInterval(timer);
        setIsRecordingEnvelope(false);
        processEnvelopeRecording();
      }
    }, intervalMs);
  };

  const processEnvelopeRecording = () => {
    const history = envelopeHistoryRef.current;
    if (history.length === 0) {
      alert("Запись огибающих завершена, но не удалось записать аудиоданные.");
      return;
    }

    // 1. Calculate Robust Fundamental Pitch (f0)
    let finalHz = lastKnownHzRef.current;
    if (avgBufferRef.current.length > 0) {
      const framesWithEnergy = avgBufferRef.current.map(item => {
        const energy = item.harmonics.reduce((sum, val) => sum + val, 0);
        return { hz: item.hz, energy };
      });
      framesWithEnergy.sort((a, b) => b.energy - a.energy);
      const topFrames = framesWithEnergy.slice(0, Math.max(1, Math.floor(framesWithEnergy.length * 0.2)));
      let sumHz = 0;
      topFrames.forEach(f => sumHz += f.hz);
      finalHz = sumHz / topFrames.length;
    }

    // --- DYNAMIC PEAK FINDING & NOISE EXTRACT ---
    if (audioCtxRef.current && analyserNodeRef.current && history[0].freqData) {
      const binHz = audioCtxRef.current.sampleRate / analyserNodeRef.current.fftSize;
      const numBins = history[0].freqData.length;
      const peakHold = new Float32Array(numBins).fill(-150);

      const noiseStartBin = Math.floor(4000 / binHz);
      const noiseEndBin = Math.floor(12000 / binHz);

      history.forEach(step => {
        if (step.freqData) {
          // Update peakHold for harmonics
          for (let i = 0; i < numBins; i++) {
            if (step.freqData[i] > peakHold[i]) peakHold[i] = step.freqData[i];
          }
          // Calculate noise energy (Peak high-frequency energy)
          if (noiseEndBin > noiseStartBin) {
            let peakNoiseDb = -150;
            for (let b = noiseStartBin; b < noiseEndBin && b < numBins; b++) {
               if (step.freqData[b] > peakNoiseDb) {
                 peakNoiseDb = step.freqData[b];
               }
            }
            step.noiseEnergy = Math.max(0, (peakNoiseDb + 90) / 90);
          }
        }
      });

      // Find local maxima and compute Topological Prominence
      let localMaxima: number[] = [];
      for (let i = 1; i < numBins - 1; i++) {
        if (peakHold[i] >= peakHold[i-1] && peakHold[i] > peakHold[i+1] && peakHold[i] > -130) {
          localMaxima.push(i);
        }
      }

      let peaks: { bin: number, hz: number, ampDb: number, prominence: number }[] = [];
      for (let maxIdx of localMaxima) {
        let amp = peakHold[maxIdx];
        let minL = amp;
        for (let j = maxIdx - 1; j >= 0; j--) {
           if (peakHold[j] > amp) break;
           if (peakHold[j] < minL) minL = peakHold[j];
        }
        let minR = amp;
        for (let j = maxIdx + 1; j < numBins; j++) {
           if (peakHold[j] > amp) break;
           if (peakHold[j] < minR) minR = peakHold[j];
        }
        let prominence = amp - Math.max(minL, minR);
        
        const alpha = peakHold[maxIdx-1], beta = peakHold[maxIdx], gamma = peakHold[maxIdx+1];
        const denom = alpha - 2*beta + gamma;
        let refinedBin = maxIdx;
        let peakDb = beta;
        if (denom !== 0) {
          const offset = 0.5 * (alpha - gamma) / denom;
          refinedBin = maxIdx + offset;
          peakDb = beta - 0.25 * (alpha - gamma) * offset;
        }
        peaks.push({ bin: refinedBin, hz: refinedBin * binHz, ampDb: peakDb, prominence });
      }
      
      peaks.sort((a, b) => b.prominence - a.prominence);

      // --- REASSIGN FUNDAMENTAL TO STRONGEST PEAK IF NEEDED ---
      const mathF0Index = peaks.findIndex(p => Math.abs(p.hz - finalHz) < 30);
      if (peaks.length > 0) {
         const strongestPeak = peaks[0];
         // If mathematical fundamental is missing, or is much weaker than the dominant peak (> 15dB difference)
         if (mathF0Index === -1 || (strongestPeak.ampDb - peaks[mathF0Index].ampDb > 15)) {
             finalHz = strongestPeak.hz;
         } else {
             finalHz = peaks[mathF0Index].hz;
         }
      }
      setCapHz(finalHz);

      const targetPeaks: typeof peaks = [];
      const newF0Index = peaks.findIndex(p => Math.abs(p.hz - finalHz) < 30);
      if (newF0Index !== -1) targetPeaks.push(peaks[newF0Index]);
      else targetPeaks.push({ bin: finalHz/binHz, hz: finalHz, ampDb: -80, prominence: 0 });

      // FORCE the original mathematical fundamental to be included if we bypassed it, so we don't lose the low frequencies
      if (mathF0Index !== -1 && peaks[mathF0Index].hz !== finalHz) {
          targetPeaks.push(peaks[mathF0Index]);
      }

      for (let p of peaks) {
        if (targetPeaks.length >= 16) break;
        let tooClose = false;
        const minDistance = Math.max(80, p.hz * 0.08); // 80Hz or 8% dynamic threshold
        for (let t of targetPeaks) {
          if (Math.abs(p.hz - t.hz) < minDistance) { tooClose = true; break; }
        }
        if (!tooClose) targetPeaks.push(p);
      }
      while(targetPeaks.length < 16) targetPeaks.push({ bin: finalHz/binHz, hz: finalHz, ampDb: -80, prominence: 0 });

      targetPeaks.sort((a, b) => a.hz - b.hz);

      // Re-extract precise amplitudes for these 8 peaks
      history.forEach(step => {
        if (step.freqData) {
          const rawDb = new Array(16).fill(-150);
          const freqs = new Array(16).fill(0);
          const amps = new Array(16).fill(0);
          for (let k = 0; k < 16; k++) {
            const targetBin = Math.round(targetPeaks[k].hz / binHz);
            let maxDb = -150;
            let pBin = targetBin;
            for(let o = -3; o <= 3; o++) {
              const b = targetBin + o;
              if (b >= 0 && b < numBins && step.freqData[b] > maxDb) {
                maxDb = step.freqData[b]; pBin = b;
              }
            }
            let refinedBin = pBin;
            if (pBin > 0 && pBin < numBins - 1) {
              const a = step.freqData[pBin-1], b = step.freqData[pBin], c = step.freqData[pBin+1];
              const denom = a - 2*b + c;
              if (denom !== 0) refinedBin = pBin + 0.5 * (a - c) / denom;
            }
            rawDb[k] = maxDb;
            freqs[k] = refinedBin * binHz;
          }
          
          const maxRawDb = Math.max(...rawDb);
          if (maxRawDb > -140) {
            for(let k=0; k<16; k++) {
               // Dynamic range: map [maxRawDb - 50, maxRawDb] to [0.0, 1.0]
               amps[k] = Math.max(0, (rawDb[k] - (maxRawDb - 50)) / 50);
            }
          } else {
            amps.fill(0);
          }
          step.amplitudes = amps;
          step.frequencies = freqs;
        }
      });
    }
    // --- END DYNAMIC PEAK FINDING ---

    // 2. Perform Pitch Wobble / Vibrato Analysis on the fundamental frequency timeline
    const centsTimeline: number[] = [];
    history.forEach(step => {
      const f0 = step.frequencies[0] || finalHz;
      if (f0 > 30) {
        const cents = 1200 * Math.log2(f0 / finalHz);
        centsTimeline.push(cents);
      }
    });

    let vibratoHz = 0;
    let vibratoCents = 0;

    if (centsTimeline.length > 10) {
      const maxC = Math.max(...centsTimeline);
      const minC = Math.min(...centsTimeline);
      const p2pCents = maxC - minC;

      if (p2pCents > 3.0 && p2pCents < 150) {
        vibratoCents = Math.round(p2pCents / 2);

        const avgCents = centsTimeline.reduce((a, b) => a + b, 0) / centsTimeline.length;
        let crossings = 0;
        for (let i = 1; i < centsTimeline.length; i++) {
          const prev = centsTimeline[i - 1] - avgCents;
          const curr = centsTimeline[i] - avgCents;
          if (prev < 0 && curr >= 0) {
            crossings++;
          }
        }
        const totalSec = envelopeDuration;
        const rate = crossings / totalSec;
        if (rate >= 1.5 && rate <= 12) {
          vibratoHz = parseFloat(rate.toFixed(1));
        } else {
          vibratoHz = 5.2;
        }
      }
    }

    setDetectedVibratoHz(vibratoHz);
    setDetectedVibratoCents(vibratoCents);

    // 3. Time-Synchronized Amplitude Extraction & Decay Times
    const calculatedDelays = Array(16).fill(0);
    const calculatedDecays = Array(16).fill(1.5);
    const calculatedAttacks = Array(16).fill(0.01);
    const calculatedSustains = Array(16).fill(0);
    const calculatedMultiples = Array(16).fill(1.0);
    const calculatedDetunes = Array(16).fill(0);
    const peakAmps = Array(16).fill(0);

    // A. Find the exact frame where the Fundamental (f0) reaches its absolute peak
    let maxF0Amp = 0;
    let peakFrameIdx = 0;
    for (let j = 0; j < history.length; j++) {
      const f0Amp = history[j].amplitudes[0] || 0;
      if (f0Amp > maxF0Amp) {
        maxF0Amp = f0Amp;
        peakFrameIdx = j;
      }
    }

    // B. Sample all harmonic volumes exactly at this peak frame
    if (history.length > 0) {
      for (let k = 0; k < 16; k++) {
        peakAmps[k] = history[peakFrameIdx].amplitudes[k] || 0;
      }
    }

    for (let k = 0; k < 16; k++) {
      const peakAmp = peakAmps[k];
      const peakTime = history[peakFrameIdx]?.time || 0;

      if (peakAmp < 0.05 && k !== 0) {
        calculatedDelays[k] = 0;
        calculatedDecays[k] = 0.1;
        calculatedAttacks[k] = 0.01;
        calculatedSustains[k] = 0;
        calculatedMultiples[k] = k + 1;
        calculatedDetunes[k] = 0;
        continue;
      }

      // Calculate EXACT start time (delay) by finding when amplitude first hits 10% of peak
      let onsetTime = 0;
      for (let j = 0; j <= peakFrameIdx; j++) {
        if (history[j].amplitudes[k] >= peakAmp * 0.1) {
          onsetTime = history[j].time;
          break;
        }
      }
      
      calculatedDelays[k] = parseFloat((onsetTime / 1000).toFixed(3));
      // Attack is the time from onset to peak
      calculatedAttacks[k] = parseFloat(Math.max(0.01, (peakTime - onsetTime) / 1000).toFixed(2));
      
      const lastAmp = history[history.length - 1]?.amplitudes[k] || 0;
      if (lastAmp > peakAmp * 0.1 && envelopeDuration > 1) {
        calculatedSustains[k] = parseFloat((lastAmp / peakAmp).toFixed(2));
      } else {
        calculatedSustains[k] = 0;
      }

      // A. Calculate INDIVIDUAL DECAY SEC (drop to 10%)
      const targetAmp = peakAmp * 0.1;
      let dropTime = -1;

      for (let j = peakFrameIdx; j < history.length; j++) {
        if (history[j].amplitudes[k] <= targetAmp) {
          dropTime = history[j].time;
          break;
        }
      }

      if (dropTime !== -1) {
        calculatedDecays[k] = parseFloat(((dropTime - peakTime) / 1000).toFixed(2));
      } else {
        const lastIdx = history.length - 1;
        const lastAmp = history[lastIdx].amplitudes[k] || 0.001;
        const lastTime = history[lastIdx].time;
        const timeDiff = (lastTime - peakTime) / 1000;
        
        if (timeDiff > 0.5 && lastAmp < peakAmp) {
          const ratio = Math.max(0.001, lastAmp / peakAmp);
          const lambda = -Math.log(ratio) / timeDiff;
          if (lambda > 0.05) {
            const extrapolated = Math.log(10) / lambda;
            calculatedDecays[k] = parseFloat(Math.min(30, Math.max(0.5, extrapolated)).toFixed(2));
          } else {
            calculatedDecays[k] = 20.0;
          }
        } else {
          calculatedDecays[k] = parseFloat((envelopeDuration * 2.5).toFixed(2));
        }
      }

      // B. Calculate INHARMONICITY (Precision Peak Interpolation)
      let sumFreq = 0;
      let activeCount = 0;
      
      // Calculate multiplier by averaging frequencies around the peak frame, not the whole file
      const windowRange = 5; // Look at 5 frames before and after the peak
      const startIdx = Math.max(0, peakFrameIdx - windowRange);
      const endIdx = Math.min(history.length - 1, peakFrameIdx + windowRange);
      
      for (let j = startIdx; j <= endIdx; j++) {
        if (history[j].amplitudes[k] > 0.05) { // Lower threshold for stable pitch extraction
          sumFreq += history[j].frequencies[k];
          activeCount++;
        }
      }

      let exactRatio = history[peakFrameIdx].frequencies[k] / finalHz;
      if (activeCount > 0) {
        const avgHarmonicFreq = sumFreq / activeCount;
        exactRatio = avgHarmonicFreq / finalHz;
      }
      calculatedMultiples[k] = parseFloat(exactRatio.toFixed(3));

      // C. Calculate DETUNING RANGE
      const harmonicCentsTimeline: number[] = [];
      for (let j = 0; j < history.length; j++) {
        if (history[j].amplitudes[k] > 0.15) {
          const expectedTargetHz = finalHz * exactRatio;
          const currentHz = history[j].frequencies[k];
          if (currentHz > 10) {
            const cents = 1200 * Math.log2(currentHz / expectedTargetHz);
            harmonicCentsTimeline.push(cents);
          }
        }
      }

      if (harmonicCentsTimeline.length > 5) {
        const maxH = Math.max(...harmonicCentsTimeline);
        const minH = Math.min(...harmonicCentsTimeline);
        const varianceCents = maxH - minH;
        if (varianceCents > 1.5 && varianceCents < 80) {
          calculatedDetunes[k] = Math.min(60, Math.round(varianceCents));
        }
      }
    }

    setRecordedDecays(calculatedDecays);
    setHasRecordedEnvelope(true);

    // 4. Assemble CapHarmonics
    const activeHarmonics: Harmonic[] = [];
    const maxPeak = Math.max(...peakAmps);

    for (let i = 0; i < 16; i++) {
      const pAmp = peakAmps[i];
      const normRatio = maxPeak > 0 ? pAmp / maxPeak : 0;

      if (i === 0 || normRatio >= 0.005) {
        activeHarmonics.push({
          multiple: calculatedMultiples[i],
          delaySec: calculatedDelays[i],
          gainRatio: parseFloat(normRatio.toFixed(3)),
          gainL: parseFloat((normRatio * 0.5).toFixed(3)),
          gainR: parseFloat((normRatio * 0.5).toFixed(3)),
          attackSec: calculatedAttacks[i],
          decaySec: calculatedDecays[i],
          sustainRatio: calculatedSustains[i],
          detuneCentsRange: calculatedDetunes[i] > 0 ? calculatedDetunes[i] : undefined,
          pan: parseFloat(([0, -0.3, 0.3, -0.15, 0.15, -0.4, 0.4, 0][i] || 0).toFixed(2)),
          wobbleHz: vibratoHz > 0 ? vibratoHz : undefined,
          wobbleDepthCents: vibratoCents > 0 ? vibratoCents : undefined
        });
      }
    }

    setCapHarmonics(activeHarmonics);

    // 5. Impact (Noise Burst) Extraction (Multi-Impact Support)
    const extractedNoiseBursts: NoiseBurst[] = [];
    if (history.length > 5) {
      // Step 1: Calculate High-Frequency Noise Energy dynamically
      const activeNumBins = history[0].freqData ? history[0].freqData.length : 2048;
      const activeBinHz = audioCtxRef.current ? audioCtxRef.current.sampleRate / (activeNumBins * 2) : 21.5;
      const startBin = Math.floor(4000 / activeBinHz);
      const endBin = Math.floor(14000 / activeBinHz);
      history.forEach(step => {
        let maxNoiseDb = -150;
        if (step.freqData) {
          for (let b = startBin; b < Math.min(endBin, activeNumBins); b++) {
            if (step.freqData[b] > maxNoiseDb) maxNoiseDb = step.freqData[b];
          }
        }
        step.noiseEnergy = maxNoiseDb; 
      });

      const globalNoiseMax = Math.max(...history.map(h => h.noiseEnergy || -150));

      // Find all local maxima in noiseEnergy
      for (let j = 1; j < history.length - 1; j++) {
        const prev = history[j-1].noiseEnergy || -150;
        const curr = history[j].noiseEnergy || -150;
        const next = history[j+1].noiseEnergy || -150;

        // Peak must be prominent and at least within 35dB of the loudest crackle
        if (curr >= prev && curr > next && curr > globalNoiseMax - 35 && curr > -120) {
           // Local peak found! Look for a drop relative to the peak and the noise floor.
           // A drop of 8 dB signifies the transient decayed
           const targetNoise = Math.max(globalNoiseMax - 35, curr - 8);
           let noiseDropTime = -1;
           for (let k = j + 1; k < Math.min(history.length, j + 25); k++) {
             if (history[k].noiseEnergy !== undefined && history[k].noiseEnergy! <= targetNoise) {
               noiseDropTime = history[k].time;
               break;
             }
           }
           
           if (noiseDropTime !== -1) {
             const noiseDecaySec = (noiseDropTime - history[j].time) / 1000;
             if (noiseDecaySec > 0) {
               // Calculate absolute delay from the very first frame
               const rawDelaySec = history[j].time / 1000;
               extractedNoiseBursts.push({
                 type: "pink",
                 delaySec: parseFloat(rawDelaySec.toFixed(3)),
                 attackSec: 0.01,
                 decaySec: parseFloat(noiseDecaySec.toFixed(2)),
                 bandpassHz: 5000,
                 gain: parseFloat(Math.min(2.0, Math.max(0, (curr - (globalNoiseMax - 40)) / 40)).toFixed(2))
               });
             }
           }
           // Skip ahead to avoid detecting the same peak multiple times or trailing noise
           j += 3;
        }
      }
    }

    // Normalize delays so the first impact happens immediately (delay = 0)
    if (extractedNoiseBursts.length > 0) {
      const firstDelay = extractedNoiseBursts[0].delaySec || 0;
      extractedNoiseBursts.forEach(b => {
        b.delaySec = parseFloat(Math.max(0, (b.delaySec || 0) - firstDelay).toFixed(3));
      });
    }

    setCapNoiseBursts(extractedNoiseBursts);

    // Draw the decay graph
    setTimeout(() => {
      drawDecayCurves(history);
    }, 50);
  };

  // Canvas multi-line decay curve graph drawer
  const drawDecayCurves = (history: { time: number; amplitudes: number[] }[]) => {
    const canvas = envelopeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "#06060c";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "#111b2e";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += w / 5) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 25); ctx.stroke();
    }
    for (let y = 0; y < h - 25; y += (h - 25) / 4) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const hColors = ["#05d9e8", "#ff2a6d", "#ffb347", "#a6e22e", "#9b5de5", "#f15bb5", "#00f5d4", "#ffffff"];
    const totalDuration = envelopeDuration * 1000;

    for (let k = 0; k < 16; k++) {
      const maxAmp = Math.max(...history.map(item => item.amplitudes[k] || 0));
      if (maxAmp < 0.05) continue;

      // Apply Moving Average for smooth envelope
      const windowSize = 5;
      const smoothedAmps: number[] = [];
      for (let j = 0; j < history.length; j++) {
        let sum = 0, count = 0;
        for (let m = Math.max(0, j - windowSize); m <= Math.min(history.length - 1, j + windowSize); m++) {
          sum += history[m].amplitudes[k] || 0;
          count++;
        }
        smoothedAmps.push(sum / count);
      }

      ctx.strokeStyle = hColors[k] || "#fff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      for (let j = 0; j < history.length; j++) {
        const amp = smoothedAmps[j] || 0;
        const x = (history[j].time / totalDuration) * w;
        const y = h - 25 - (amp * (h - 35));

        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = "#8a8a8a";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    
    let step = 1;
    if (envelopeDuration > 30) step = 10;
    else if (envelopeDuration > 15) step = 5;
    else if (envelopeDuration > 5) step = 2;

    for (let sec = 0; sec <= envelopeDuration; sec += step) {
      const x = (sec / envelopeDuration) * w;
      ctx.fillText(`${sec}s`, x, h - 8);
    }
  };

  // Playback Audition
  const handleTestPlay = () => {
    if (capHz <= 0 || capHarmonics.length === 0) return;

    if (isPlayingAudition) {
      stopFrequency();
      setIsPlayingAudition(false);
      return;
    }

    const testPreset: SynthPreset = {
      name: "Captured Audition",
      baseHz: capHz,
      waveform: presetWaveform,
      harmonics: capHarmonics,
      attackSec: atkSec,
      decaySec: decSec,
      sustainRatio: susRatio,
      releaseSec: relSec,
      noiseBurst: capNoiseBursts.length > 0 ? capNoiseBursts : undefined,
      lowpassHz: lowpassHz,
      highpassHz: highpassHz,
      masterVolume: 1.0,
      reverb: { wet: reverbWet, decaySec: reverbDecay, preDelayMs: 20 }
    };

    stopFrequency();
    
    // Calculate total duration needed to hear all noise bursts
    let maxDelay = 0;
    if (capNoiseBursts && capNoiseBursts.length > 0) {
      maxDelay = Math.max(...capNoiseBursts.map(b => (b.delaySec || 0) + b.decaySec + b.attackSec));
    }
    const dynamicDuration = Math.max(testPlayDuration, maxDelay + 0.5);

    const success = playFrequency(capHz, {
      ...testPreset,
      loop: false,
      durationSec: dynamicDuration
    });

    if (success) {
      setIsPlayingAudition(true);
      
      const maxDecay = hasRecordedEnvelope 
        ? Math.max(...recordedDecays)
        : decSec;

      setTimeout(() => {
        setIsPlayingAudition(false);
      }, (dynamicDuration + Math.min(10, maxDecay)) * 1000);
    }
  };

  // Save/Import Preset into Generator Rack
  const handleSaveToSynth = () => {
    if (capHz <= 0 || capHarmonics.length === 0) {
      alert("Сначала захватите звук с помощью снимка спектра или записи огибающих!");
      return;
    }

    const key = presetName.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_" + Date.now().toString().slice(-4);
    
    const mappedHarmonics = capHarmonics.map(h => ({
      ...h,
      decaySec: h.decaySec !== undefined ? h.decaySec : decSec,
      sustainRatio: susRatio,
      releaseSec: relSec
    }));

    const newPreset: SynthPreset = {
      name: presetName.trim(),
      systemId: presetCategory,
      baseHz: parseFloat(capHz.toFixed(2)),
      waveform: presetWaveform,
      harmonics: mappedHarmonics,
      attackSec: atkSec,
      decaySec: decSec, 
      sustainRatio: susRatio,
      releaseSec: relSec,
      noiseBurst: capNoiseBursts.length > 0 ? capNoiseBursts : undefined,
      lowpassHz: lowpassHz,
      highpassHz: highpassHz,
      masterVolume: 1.0,
      reverb: { wet: reverbWet, decaySec: reverbDecay, preDelayMs: 20 }
    };

    const freshStorage = loadCustomPresets();
    const updated = { ...freshStorage, [key]: newPreset };
    setCustomPresets(updated);
    saveCustomPresets(updated);

    alert(`Пресет "${presetName}" успешно сохранен! Вы можете найти его во вкладке USER в Rack Консоли или Classic.`);
  };

  // Generate exact SynthPreset formatted code for developers to copy
  const getPresetCodeString = () => {
    if (capHz <= 0 || capHarmonics.length === 0) return "";
    
    const key = presetName.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_" + Date.now().toString().slice(-4);
    
    const mappedHarmonics = capHarmonics.map(h => ({
      ...h,
      decaySec: h.decaySec !== undefined ? h.decaySec : decSec,
      sustainRatio: susRatio,
      releaseSec: relSec
    }));

    const lines = [
      `  ${key}: {`,
      `    name: "${presetName.trim()}",`,
      `    systemId: "${presetCategory}",`,
      `    baseHz: ${parseFloat(capHz.toFixed(2))},`,
      `    waveform: "${presetWaveform}",`,
      `    attackSec: ${atkSec},`,
      `    decaySec: ${decSec},`,
      `    sustainRatio: ${susRatio},`,
      `    releaseSec: ${relSec},`,
      ...(capNoiseBursts.length > 0 ? [`    noiseBurst: ${JSON.stringify(capNoiseBursts)},`] : []),
      `    lowpassHz: ${lowpassHz},`,
      `    highpassHz: ${highpassHz},`,
      `    masterVolume: 1.0,`,
      `    reverb: { wet: ${reverbWet}, decaySec: ${reverbDecay}, preDelayMs: 20 },`,
      `    harmonics: [`
    ];

    mappedHarmonics.forEach(h => {
      const parts = [
        `multiple: ${h.multiple.toFixed(3)}`,
        `gainRatio: ${h.gainRatio.toFixed(3)}`,
        `gainL: ${h.gainL?.toFixed(3) || "0.500"}`,
        `gainR: ${h.gainR?.toFixed(3) || "0.500"}`,
        `decaySec: ${h.decaySec?.toFixed(2) || decSec.toFixed(2)}`,
        `sustainRatio: ${h.sustainRatio?.toFixed(2) || susRatio.toFixed(2)}`,
        `releaseSec: ${h.releaseSec?.toFixed(2) || relSec.toFixed(2)}`,
        `pan: ${h.pan?.toFixed(2) || "0.00"}`
      ];
      
      if (h.detuneCentsRange) parts.push(`detuneCentsRange: ${h.detuneCentsRange}`);
      if (h.wobbleHz) parts.push(`wobbleHz: ${h.wobbleHz}`);
      if (h.wobbleDepthCents) parts.push(`wobbleDepthCents: ${h.wobbleDepthCents}`);

      lines.push(`      { ${parts.join(", ")} },`);
    });

    lines.push("    ]");
    lines.push("  },");

    return lines.join("\n");
  };


  const buttonStyle = (active: boolean, color = colors.accent, disabled = false) => ({
    background: active ? color : "transparent",
    border: `1px solid ${disabled ? colors.border : color}`,
    color: active ? "#000" : (disabled ? colors.textSecondary : color),
    padding: "8px 16px",
    borderRadius: "4px",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "13px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    boxShadow: "none",
    transition: "all 0.2s",
    opacity: disabled ? 0.4 : 1
  });

  const inputStyle = {
    background: "#11111a",
    border: "1px solid #333344",
    color: colors.accentCyan,
    padding: "6px 10px",
    borderRadius: "4px",
    fontSize: "12px",
    fontFamily: "monospace",
    outline: "none"
  };

  if (!supported) return <div style={{ color: colors.accent, padding: "12px" }}>Web Audio API not supported.</div>;

  return (
    <div style={{ height: "100%", background: colors.bg, color: colors.text, padding: "12px", fontFamily: "'Inter', 'Helvetica Neue', sans-serif", fontWeight: 300, display: "flex", flexDirection: "column" }}>
      <div style={{ width: "100%", display: "flex", flexDirection: "row", gap: "16px", margin: "0 auto", flex: 1, minHeight: 0, maxWidth: "1900px" }}>
        
        {/* LEFT COLUMN: Header + Visualizers */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", flex: "1 1 auto", minWidth: 0, overflowY: "auto", paddingRight: "4px" }}>

          {/* Header Panel with Mode Toggles */}
          <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "12px", flexShrink: 0 }}>
          
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
            <div>
              <h2 style={{ fontSize: "20px", color: colors.accent, margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
                🎙️ ЗВУКОВОЙ ЗАХВАТ, АНАЛИЗАТОР И ОЦИФРОВЩИК ФАЙЛОВ
              </h2>
              <p style={{ margin: "4px 0 0 0", color: colors.textSecondary, fontSize: "12px" }}>
                Записывайте звук с микрофона в реальном времени или загружайте аудиофайлы для прецизионного анализа всех акустических характеристик.
              </p>
            </div>
            
            {/* Quick Micro-checks & Controls */}
            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "10px", color: colors.textSecondary }}>
                ДЛИТЕЛЬНОСТЬ ЗАПИСИ
                <select value={envelopeDuration} onChange={e => setEnvelopeDuration(parseInt(e.target.value))} style={{ ...inputStyle, padding: "3px 6px", fontSize: "11px" }}>
                  <option value="5">5 СЕКУНД</option>
                  <option value="10">10 СЕКУНД</option>
                  <option value="15">15 СЕКУНД</option>
                  <option value="30">30 СЕКУНД</option>
                  <option value="60">60 СЕКУНД (1 МИН)</option>
                </select>
              </label>

              <button
                onClick={micState === "enabled" ? stopMic : startMic}
                style={buttonStyle(micState === "enabled", micState === "enabled" ? colors.accent : colors.accentCyan)}
              >
                {micState === "enabled" ? "ВЫКЛЮЧИТЬ МИКРОФОН" : "ВКЛЮЧИТЬ МИКРОФОН"}
              </button>

              <button
                onClick={handleStartEnvelopeRecording}
                disabled={micState !== "enabled" || !!decodedBuffer || isRecordingEnvelope || isAveraging}
                style={buttonStyle(isRecordingEnvelope, colors.accent, micState !== "enabled" || !!decodedBuffer || isRecordingEnvelope || isAveraging)}
              >
                {isRecordingEnvelope ? `ЗАПИСЬ ОГИБАЮЩИХ (${recProgress}%)` : "ИНТЕЛЛЕКТУАЛЬНЫЙ АНАЛИЗ"}
              </button>

              <button
                onClick={handleStartAveraging}
                disabled={micState !== "enabled" || !!decodedBuffer || isRecordingEnvelope || isAveraging}
                style={buttonStyle(isAveraging, colors.accentAmber, micState !== "enabled" || !!decodedBuffer || isRecordingEnvelope || isAveraging)}
              >
                {isAveraging ? `ЗАПИСЬ СПЕКТРА (${avgProgress}%)` : "БЫСТРОЕ СРЕДНЕЕ (3 СЕК)"}
              </button>

              <button 
                onClick={handleFreezeCapture} 
                disabled={micState !== "enabled" || isRecordingEnvelope || isAveraging}
                style={buttonStyle(false, colors.accentCyan, micState !== "enabled" || isRecordingEnvelope || isAveraging)}
              >
                БЫСТРЫЙ СНИМОК
              </button>
            </div>
          </div>

          {/* New Audio File Drop / Uploader Area */}
          <div 
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
            }}
            onDrop={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) {
                await processFile(file);
              }
            }}
            style={{ 
              display: "flex", 
              flexDirection: "column",
              justifyContent: "center",
              gap: "16px", 
              background: isDragging ? "rgba(0, 242, 254, 0.1)" : "rgba(0,0,0,0.3)", 
              padding: "16px", 
              borderRadius: "8px", 
              border: `1px dashed ${isDragging ? colors.accentCyan : (selectedFile ? colors.accentCyan : colors.border)}`,
              transition: "all 0.2s ease",
              height: "130px",
              boxSizing: "border-box",
              overflow: "hidden"
            }}
          >
            {/* ROW 1: File Uploader and Name */}
            <div style={{ display: "flex", alignItems: "center", gap: "16px", width: "100%", minWidth: 0 }}>
              <label 
                htmlFor="file-uploader" 
                style={{ 
                  ...buttonStyle(false, colors.accentCyan), 
                  display: "inline-block", 
                  textAlign: "center", 
                  whiteSpace: "nowrap",
                  flexShrink: 0
                }}
              >
                📁 ВЫБРАТЬ ФАЙЛ
              </label>
              <input 
                type="file" 
                accept="audio/*,video/mp4,video/quicktime,video/x-matroska,.mp4,.mov,.m4a,.webm" 
                onChange={handleFileChange} 
                style={{ display: "none" }} 
                id="file-uploader" 
              />
              
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
                {isDecoding ? (
                  <span style={{ color: colors.accentAmber, fontSize: "13px" }}>Декодирование и чтение файла... ⏳</span>
                ) : decodedBuffer ? (
                  <div style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ color: colors.accentCyan, fontWeight: "bold" }}>Загружен: </span>
                    <span style={{ color: colors.text }}>{selectedFile?.name}</span>
                    <span style={{ color: colors.textSecondary, marginLeft: "10px" }}>
                      ({decodedBuffer.duration.toFixed(2)} сек, {decodedBuffer.sampleRate}Гц, {decodedBuffer.numberOfChannels} ch)
                    </span>
                  </div>
                ) : (
                  <span style={{ color: colors.textSecondary, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    Или перетащите файл сюда
                  </span>
                )}
              </div>
            </div>

            {/* ROW 2: Control Buttons */}
            <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", width: "100%" }}>
              <button 
                onClick={
                  fileAnalysisState === "playing" ? handlePauseFileAnalysis :
                  fileAnalysisState === "paused" ? handleResumeFileAnalysis :
                  handleStartFileAnalysis
                }
                style={{
                  ...buttonStyle(fileAnalysisState === "playing" || fileAnalysisState === "paused", fileAnalysisState === "playing" ? colors.accentAmber : colors.accent),
                  padding: "10px 24px",
                  fontSize: "14px",
                  letterSpacing: "1px",
                  opacity: decodedBuffer ? 1 : 0.5,
                  pointerEvents: decodedBuffer ? "auto" : "none"
                }}
              >
                {fileAnalysisState === "playing" ? "⏸ ПАУЗА" : 
                 fileAnalysisState === "paused" ? "▶ ПРОДОЛЖИТЬ" : 
                 "▶ АНАЛИЗИРОВАТЬ ФАЙЛ"}
              </button>
              
              {(fileAnalysisState === "playing" || fileAnalysisState === "paused") && (
                <>
                  <button 
                    onClick={() => {
                      processEnvelopeRecording();
                    }}
                    style={{
                      ...buttonStyle(false, colors.accentCyan),
                      padding: "10px 24px",
                      fontSize: "14px",
                      letterSpacing: "1px"
                    }}
                  >
                    ⚡ ПРИМЕНИТЬ
                  </button>
                  
                  <button 
                    onClick={() => {
                      stopFileAnalysis();
                      processEnvelopeRecording();
                    }}
                    style={{
                      ...buttonStyle(false, "#ff2a6d"),
                      padding: "10px 24px",
                      fontSize: "14px",
                      letterSpacing: "1px"
                    }}
                  >
                    ⏹ СТОП И ПРИМЕНИТЬ
                  </button>
                </>
              )}
              
              <label style={{ display: "flex", gap: "6px", fontSize: "12px", color: colors.text, fontWeight: 500, alignItems: "center", cursor: "pointer", marginLeft: "12px", opacity: decodedBuffer ? 1 : 0.5, pointerEvents: decodedBuffer ? "auto" : "none", whiteSpace: "nowrap" }}>
                <input 
                  type="checkbox" 
                  checked={listenDuringAnalysis} 
                  onChange={e => setListenDuringAnalysis(e.target.checked)} 
                  style={{ accentColor: colors.accentCyan }}
                />
                ПРОСЛУШИВАТЬ ПРИ АНАЛИЗЕ
              </label>
            </div>
          </div>

        </div> {/* Close Header Panel Wrapper */}

        {/* Dashboard Visualizers Layout - Smart Grid */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", flexShrink: 0, padding: "16px", background: colors.panel, borderRadius: "12px", border: `1px solid ${colors.border}` }}>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 3fr", gap: "12px", flexShrink: 0, minHeight: "250px" }}>
          
          {/* Visualizer 1: Digital Tuner Ring (Compact) */}
          <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
            <h3 style={{ margin: 0, fontSize: "15px", color: colors.accentCyan, width: "100%", textAlign: "left", borderBottom: `1px solid ${colors.border}`, paddingBottom: "6px", fontWeight: 600, flexShrink: 0 }}>
              ЦИФРОВОЙ ТЮНЕР / ВЫСОТА
            </h3>
            <div style={{ flex: 1, position: "relative", width: "100%", display: "flex", justifyContent: "center", alignItems: "center", minHeight: 0 }}>
              <canvas ref={tunerCanvasRef} style={{ background: colors.canvasBg, borderRadius: "50%", maxHeight: "100%", maxWidth: "100%", aspectRatio: "1/1", border: `1px solid ${colors.border}`, flexShrink: 0 }} />
            </div>
            <div style={{ fontSize: "14px", color: colors.accentAmber, fontWeight: 600, flexShrink: 0 }}>
              {detectedHz > 0 ? `Детектировано: ${detectedHz.toFixed(2)} Hz` : "Поиск стабильного сигнала..."}
            </div>
          </div>

          {/* Visualizer 2: Time Oscilloscope */}
          <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
            <h3 style={{ margin: 0, fontSize: "15px", color: colors.accent, width: "100%", textAlign: "left", borderBottom: `1px solid ${colors.border}`, paddingBottom: "6px", fontWeight: 600, flexShrink: 0 }}>
              ОСЦИЛЛОГРАФ (ФОРМА ВОЛНЫ)
            </h3>
            <div style={{ flex: 1, position: "relative", width: "100%" }}>
              <canvas ref={oscilloscopeCanvasRef} style={{ background: colors.canvasBg, borderRadius: "8px", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: `1px solid ${colors.border}` }} />
            </div>
            <div style={{ fontSize: "13px", color: colors.text, flexShrink: 0 }}>
              Форма колебаний входящего сигнала.
            </div>
          </div>

          {/* Visualizer 3: FFT Spectrum with Harmonic Pointer (Max Width) */}
          <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
            <h3 style={{ margin: 0, fontSize: "15px", color: colors.accentCyan, width: "100%", textAlign: "left", borderBottom: `1px solid ${colors.border}`, paddingBottom: "6px", fontWeight: 600, flexShrink: 0 }}>
              ЧАСТОТНЫЙ СПЕКТР И ГАРМОНИКИ (FFT)
            </h3>
            <div style={{ flex: 1, position: "relative", width: "100%" }}>
              <canvas 
                ref={spectrumCanvasRef} 
                style={{ background: colors.canvasBg, borderRadius: "8px", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: `1px solid ${colors.border}`, cursor: "crosshair" }}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  spectrumMouseRef.current = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                    isHovering: true
                  };
                  if (fileAnalysisState !== "playing" && fftPeakHoldRef.current) {
                    drawSpectrum(fftPeakHoldRef.current, 0, 48000 / 16384, true);
                  }
                }}
                onMouseLeave={() => {
                  spectrumMouseRef.current.isHovering = false;
                  if (fileAnalysisState !== "playing" && fftPeakHoldRef.current) {
                    drawSpectrum(fftPeakHoldRef.current, 0, 48000 / 16384, true);
                  }
                }}
              />
            </div>
            <div style={{ fontSize: "13px", color: colors.text, flexShrink: 0 }}>
              Логарифмический спектр. Маркеры показывают гармоники.
            </div>
          </div>
        </div>

        {/* Live Harmonics and Captured State View */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px", flexShrink: 0, minHeight: "300px" }}>
          
          {/* Live Mixer Bars */}
          <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
            <h3 style={{ margin: 0, fontSize: "15px", color: colors.accentAmber, borderBottom: `1px solid ${colors.border}`, paddingBottom: "6px", fontWeight: 600, flexShrink: 0 }}>
              АКТИВНЫЙ БАЛАНС ГАРМОНИК (REAL-TIME RATIOS)
            </h3>
            <div style={{ flex: 1, position: "relative", width: "100%" }}>
              <canvas 
                ref={harmonicsCanvasRef} 
                style={{ background: colors.canvasBg, borderRadius: "8px", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: `1px solid ${colors.border}` }} 
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  harmonicsMouseRef.current = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                    isHovering: true
                  };
                }}
                onMouseLeave={() => {
                  harmonicsMouseRef.current.isHovering = false;
                }}
              />
            </div>
            <div style={{ fontSize: "13px", color: colors.text, flexShrink: 0 }}>
              Наведите курсор на столб для точных значений (Hz, %, захват).
            </div>
          </div>

          {/* Decay Envelopes over Time Graph */}
          <div style={{ 
            background: colors.panel, 
            padding: "12px", 
            border: `1px solid ${hasRecordedEnvelope ? colors.accentCyan : colors.border}`, 
            borderRadius: "12px", 
            display: "flex", 
            flexDirection: "column", 
            gap: "12px",
            boxShadow: hasRecordedEnvelope ? `0 0 10px rgba(0, 119, 182, 0.15)` : "0 2px 8px rgba(0,0,0,0.02)"
          }}>
            <h3 style={{ margin: 0, fontSize: "15px", color: colors.accentCyan, borderBottom: `1px solid ${colors.border}`, paddingBottom: "6px", display: "flex", justifyContent: "space-between", fontWeight: 600, flexShrink: 0 }}>
              <span>📉 КРИВЫЕ ЗАТУХАНИЯ ГАРМОНИК (AMPLITUDE ENVELOPES)</span>
              {hasRecordedEnvelope && <span style={{ fontSize: "11px", color: colors.accentAmber, fontWeight: 500 }}>АНАЛИЗ ЗАВЕРШЕН</span>}
            </h3>
            <div style={{ display: "flex", flex: 1, gap: "16px", minHeight: 0 }}>
              <div style={{ flex: 1, position: "relative" }}>
                <canvas ref={envelopeCanvasRef} style={{ background: colors.canvasBg, borderRadius: "8px", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: `1px solid ${colors.border}` }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", justifyContent: "center", width: "100px", flexShrink: 0 }}>
                {hColors.map((col, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ display: "inline-block", width: "12px", height: "12px", background: col, borderRadius: "3px", flexShrink: 0 }} />
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ fontSize: "10px", color: colors.textSecondary, lineHeight: "1" }}>CH{idx + 1}</span>
                      <span style={{ fontSize: "13px", fontWeight: "bold", color: colors.text, lineHeight: "1.2" }}>
                        {recordedDecays[idx] !== undefined ? `${recordedDecays[idx]}s` : "1.5s"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div> {/* Close Live Harmonics Grid */}
      </div> {/* Close Visualizers Wrapper */}
    </div> {/* Close LEFT COLUMN: Header + Visualizers */}

    {/* RIGHT COLUMN: Snapshots & Forms */}
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", flex: "0 0 380px", minWidth: 0, overflowY: "auto", paddingRight: "4px" }}>
            {/* Captured Data Snapshot */}
            <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "14px", flexShrink: 0 }}>
            <h3 style={{ margin: 0, fontSize: "15px", color: colors.accent, borderBottom: `1px solid #222`, paddingBottom: "6px", fontWeight: 600 }}>
              АНАЛИЗ ХАРАКТЕРИСТИК ЗВУКА (ACOUSTIC SPECS)
            </h3>
            {capHz > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: colors.textSecondary }}>Основная частота ($f_0$):</span>
                  <span style={{ color: colors.accentCyan, fontSize: "16px", fontWeight: "bold" }}>{capHz.toFixed(2)} Hz ({getNoteFromFrequency(capHz).name})</span>
                </div>

                {detectedVibratoCents > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px dashed #222", paddingTop: "4px" }}>
                    <span style={{ color: colors.textSecondary }}>Вибрато (LFO Pitch Wobble):</span>
                    <span style={{ color: colors.accentAmber, fontSize: "12px", fontWeight: "bold" }}>
                      {detectedVibratoHz} Hz (±{detectedVibratoCents}¢)
                    </span>
                  </div>
                )}
                
                <div style={{ borderTop: "1px solid #222", paddingTop: "8px" }}>
                  <span style={{ color: colors.textSecondary, fontSize: "13px" }}>Характеристики гармоник (Inharmonicity & Envelopes):</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.6fr 0.6fr 0.6fr 0.5fr", gap: "6px", fontSize: "11px", color: colors.textSecondary, borderBottom: "1px solid #222", paddingBottom: "4px", fontWeight: "bold" }}>
                      <span>КАНАЛ</span>
                      <span style={{ textAlign: "center", color: colors.accent }}>СТАРТ (s)</span>
                      <span style={{ textAlign: "center" }}>МНОЖ.</span>
                      <span style={{ textAlign: "center" }}>ГРОМК.</span>
                      <span style={{ textAlign: "center" }}>ЗАТУХ.</span>
                      <span style={{ textAlign: "center" }}>РАССТР.</span>
                    </div>
                    <div style={{ maxHeight: "250px", overflowY: "auto", paddingRight: "4px" }}>
                      {capHarmonics.map((h, idx) => {
                      const color = hColors[idx] || "#fff";
                      const mult = h.multiple !== undefined ? h.multiple : (idx + 1);
                      return (
                        <div key={idx} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.6fr 0.6fr 0.6fr 0.5fr", gap: "6px", fontSize: "13px", alignItems: "center", color: colors.text, padding: "2px 0" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-block", width: "10px", height: "10px", background: color, borderRadius: "50%" }} />
                            CH{idx + 1} <span style={{ color: colors.textSecondary, fontSize: "11px" }}>({Math.round(capHz * mult)}Hz)</span>
                          </span>
                          <input 
                            type="number" 
                            step="0.05" 
                            min="0"
                            value={h.delaySec !== undefined ? Number(h.delaySec.toFixed(3)) : 0} 
                            onChange={(e) => updateHarmonicDelay(idx, parseFloat(e.target.value) || 0)}
                            style={{ background: "#111", border: "1px solid #333", color: colors.accent, width: "100%", padding: "2px", borderRadius: "3px", textAlign: "center", fontSize: "12px", outline: "none" }}
                          />
                          <span style={{ textAlign: "center", fontWeight: "bold", background: "rgba(0,0,0,0.2)", borderRadius: "2px" }}>
                            {mult.toFixed(3)}
                          </span>
                          <span style={{ textAlign: "center", fontWeight: "bold" }}>{Math.round(h.gainRatio * 100)}%</span>
                          <span style={{ textAlign: "center" }}>
                            {h.decaySec !== undefined ? `${h.decaySec.toFixed(1)}s` : "1.5s"}
                          </span>
                          <span style={{ textAlign: "center", fontSize: "12px", color: colors.textSecondary }}>
                            {h.detuneCentsRange ? `±${h.detuneCentsRange}¢` : "0¢"}
                          </span>
                        </div>
                      );
                    })}
                    </div>
                  </div>
                </div>


                <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
                  <button onClick={handleTestPlay} style={buttonStyle(isPlayingAudition, colors.accent)}>
                    {isPlayingAudition ? "СТОП ТЕСТ" : "ПРОСЛУШАТЬ СИНТЕЗАТОР"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: "40px 0", textAlign: "center", color: colors.textSecondary, fontSize: "13px" }}>
                Нет зафиксированного спектра. Подключите микрофон или выберите аудиофайл выше для запуска анализа!
              </div>
            )}
          </div>
        </div> {/* Close MIDDLE COLUMN (Harmonics) */}

        {/* FAR RIGHT COLUMN: Transients & Forms */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", flex: "0 0 380px", minWidth: 0, overflowY: "auto", paddingRight: "4px" }}>
          {/* Separate Transients / Impacts Card */}
          {capHz > 0 && (
            <div style={{ background: colors.panel, padding: "12px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "14px", flexShrink: 0 }}>
              <h3 style={{ margin: 0, fontSize: "15px", color: colors.accent, borderBottom: `1px solid #222`, paddingBottom: "6px", fontWeight: 600 }}>
                АНАЛИЗ УДАРОВ (TRANSIENTS)
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr 0.8fr 0.6fr", gap: "6px", fontSize: "11px", color: colors.textSecondary, borderBottom: "1px solid #222", paddingBottom: "4px", fontWeight: "bold" }}>
                  <span>УДАР</span>
                  <span style={{ textAlign: "center", color: colors.accent }}>СТАРТ (s)</span>
                  <span style={{ textAlign: "center" }}>ГРОМК.</span>
                  <span style={{ textAlign: "center" }}>ЗАТУХ.</span>
                  <span style={{ textAlign: "center" }}>ФИЛЬТР</span>
                </div>
                {capNoiseBursts.length === 0 ? (
                  <div style={{ fontSize: "12px", color: colors.textSecondary, textAlign: "center", padding: "8px 0" }}>
                    Шумовых транзиентов не обнаружено
                  </div>
                ) : (
                  capNoiseBursts.map((burst, idx) => (
                    <div key={idx} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr 0.8fr 0.6fr", gap: "6px", fontSize: "13px", alignItems: "center", color: colors.text, padding: "2px 0" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
                        <span style={{ display: "inline-block", width: "10px", height: "10px", background: "#fff", borderRadius: "2px", transform: "rotate(45deg)" }} />
                        IMPACT {idx+1} 
                      </span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0"
                        value={burst.delaySec !== undefined ? Number(burst.delaySec.toFixed(3)) : 0} 
                        onChange={(e) => updateBurstDelay(idx, parseFloat(e.target.value) || 0)}
                        style={{ background: "#111", border: "1px solid #333", color: colors.accent, width: "100%", padding: "2px", borderRadius: "3px", textAlign: "center", fontSize: "12px", outline: "none" }}
                      />
                      <span style={{ textAlign: "center", fontWeight: "bold" }}>{Math.round(burst.gain * 100)}%</span>
                      <span style={{ textAlign: "center" }}>{burst.decaySec.toFixed(2)}s</span>
                      <span style={{ textAlign: "center", fontSize: "12px", color: colors.textSecondary }}>{burst.bandpassHz}Hz</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div> {/* CLOSE FAR RIGHT COLUMN */}
      </div> {/* CLOSE 3-COLUMN CONTAINER */}

      {/* Customize captured tone & Save Form (Full Width Bottom) */}
      {capHz > 0 && (
          <div style={{ background: colors.panel, padding: "12px", border: `2px solid ${colors.accent}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <h3 style={{ margin: 0, fontSize: "16px", color: colors.accentCyan, borderBottom: `1px solid ${colors.border}`, paddingBottom: "10px" }}>
              НАСТРОЙКА И ИМПОРТ ЗВУКА В ГЕНЕРАТОР SYNTH LAB
            </h3>
            
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "11px", color: colors.textSecondary }}>НАЗВАНИЕ ПРЕСЕТА</label>
                <input type="text" value={presetName} onChange={e => setPresetName(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "11px", color: colors.textSecondary }}>БАЗОВАЯ ФОРМА ВОЛНЫ</label>
                <select value={presetWaveform} onChange={e => setPresetWaveform(e.target.value as OscillatorType)} style={inputStyle}>
                  <option value="sine">SINE (Синусоида - чистый тон)</option>
                  <option value="triangle">TRIANGLE (Треугольная - мягкий)</option>
                  <option value="sawtooth">SAWTOOTH (Пила - яркий, богатый)</option>
                  <option value="square">SQUARE (Меандр - полый, кларнет)</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "11px", color: colors.textSecondary }}>КАТЕГОРИЯ ИНСТРУМЕНТА</label>
                <select value={presetCategory} onChange={e => setPresetCategory(e.target.value)} style={inputStyle}>
                  {SYSTEM_CATEGORIES.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* ADSR & FX customization row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", background: "rgba(0,0,0,0.2)", padding: "16px", borderRadius: "8px", border: "1px solid #222" }}>
              
              {/* Envelope (ADSR) */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <h4 style={{ margin: 0, fontSize: "12px", color: colors.accentAmber }}>ОГИБАЮЩАЯ ГРОМКОСТИ (ENVELOPE)</h4>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    ATTACK (s)
                    <input type="number" step="0.05" min="0" max="5" value={atkSec} onChange={e => setAtkSec(parseFloat(e.target.value))} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    DECAY (s) (Глобальный)
                    <input type="number" step="0.1" min="0.1" max="15" value={decSec} onChange={e => setDecSec(parseFloat(e.target.value))} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    SUSTAIN
                    <input type="number" step="0.05" min="0" max="1" value={susRatio} onChange={e => setSusRatio(parseFloat(e.target.value))} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    RELEASE (s)
                    <input type="number" step="0.5" min="0.1" max="60" value={relSec} onChange={e => setRelSec(parseFloat(e.target.value))} style={inputStyle} />
                  </label>
                </div>
                <div style={{ fontSize: "10px", color: colors.accentCyan, marginTop: "4px" }}>
                  * Анализатор автоматически записал уникальные расстройки (Inharmonicity), огибающие затухания (Decay Envelopes), дрейф высоты (Detune) и пространственный разнос (Stereo Spread) для каждой гармоники отдельно!
                </div>
              </div>

              {/* Sounding Duration */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <h4 style={{ margin: 0, fontSize: "12px", color: colors.accentAmber }}>ВРЕМЯ ЗВУЧАНИЯ ПРИ ТЕСТЕ (DURATION)</h4>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px" }}>
                  Тестовая длительность ноты (до 60 сек):
                  <input type="range" min="1" max="60" value={testPlayDuration} onChange={e => setTestPlayDuration(parseInt(e.target.value))} style={{ accentColor: colors.accent }} />
                  <span style={{ fontSize: "11px", color: colors.accentCyan }}>{testPlayDuration} секунд + {relSec} сек затухание</span>
                </label>
              </div>

              {/* Filters & Reverb */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <h4 style={{ margin: 0, fontSize: "12px", color: colors.accentAmber }}>ФИЛЬТРЫ И ЭФФЕКТЫ (FX)</h4>
                <div style={{ display: "flex", gap: "10px" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    REVERB WET
                    <input type="number" step="0.05" min="0" max="1" value={reverbWet} onChange={e => setReverbWet(parseFloat(e.target.value))} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    REVERB DEC (s)
                    <input type="number" step="0.5" min="0.5" max="15" value={reverbDecay} onChange={e => setReverbDecay(parseFloat(e.target.value))} style={inputStyle} />
                  </label>
                </div>
                <div style={{ display: "flex", gap: "10px" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    LPF (Hz)
                    <input type="number" step="100" min="200" max="20000" value={lowpassHz} onChange={e => setLowpassHz(parseInt(e.target.value))} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", flex: 1 }}>
                    HPF (Hz)
                    <input type="number" step="10" min="10" max="2000" value={highpassHz} onChange={e => setHighpassHz(parseInt(e.target.value))} style={inputStyle} />
                  </label>
                </div>
              </div>

            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", alignItems: "center" }}>
              <button 
                onClick={() => setShowPresetCode(!showPresetCode)} 
                style={buttonStyle(showPresetCode, colors.accentAmber)}
              >
                📝 {showPresetCode ? "СКРЫТЬ КОД ПРЕСЕТА" : "ПОКАЗАТЬ КОД ПРЕСЕТА"}
              </button>
              
              <button onClick={handleSaveToSynth} style={{ ...buttonStyle(true, colors.accentCyan), padding: "12px 24px", fontSize: "14px" }}>
                💾 СОХРАНИТЬ В SYNTH RACK (ЭКСПОРТ)
              </button>
            </div>

            {showPresetCode && (
              <div style={{ 
                marginTop: "20px", 
                background: "#06060c", 
                border: `1px solid ${colors.accentAmber}`, 
                borderRadius: "8px", 
                padding: "16px",
                boxShadow: "0 0 15px rgba(255, 179, 71, 0.15)"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <span style={{ color: colors.accentAmber, fontSize: "12px", fontWeight: "bold" }}>
                    СГЕНЕРИРОВАННЫЙ КОД ПРЕСЕТА (ДОБАВЬТЕ В PRESETS В frequency-synth.ts)
                  </span>
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(getPresetCodeString());
                      setIsCopied(true);
                      setTimeout(() => setIsCopied(false), 2000);
                    }} 
                    style={buttonStyle(isCopied, colors.accentCyan)}
                  >
                    {isCopied ? "СКОПИРОВАНО! ✓" : "КОПИРОВАТЬ В БУФЕР"}
                  </button>
                </div>
                <pre style={{ 
                  margin: 0, 
                  background: "#020204", 
                  padding: "12px", 
                  borderRadius: "4px", 
                  overflowX: "auto", 
                  fontSize: "11px", 
                  color: "#a6e22e", 
                  fontFamily: "monospace",
                  border: "1px solid #111",
                  maxHeight: "350px"
                }}>
                  {getPresetCodeString()}
                </pre>
              </div>
            )}
          </div>
        )}
  </div>
  );
}
