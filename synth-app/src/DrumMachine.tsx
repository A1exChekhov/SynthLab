"use client";

import { useEffect, useRef, useState } from "react";
import { triggerDrum, setDrumBusVolume, subscribeTransport, toggleTransport, isTransportPlaying } from "./frequency-synth";
import type { PlayOptions } from "./frequency-synth";

export const DRUM_STEPS = 16;

type Drum = { id: string; label: string; color: string; hz: number; voice: PlayOptions };

const DRUMS: Drum[] = [
  { id: "kick", label: "Kick", color: "#e63946", hz: 55, voice: {
    waveform: "sine", harmonics: [{ multiple: 1, gainRatio: 1.0 }],
    attackSec: 0.001, decaySec: 0.24, sustainRatio: 0, releaseSec: 0.05,
    noiseBurst: { type: "white", attackSec: 0.001, decaySec: 0.02, bandpassHz: 1400, gain: 0.4 },
  } },
  { id: "snare", label: "Snare", color: "#ffd166", hz: 190, voice: {
    waveform: "triangle", harmonics: [{ multiple: 1, gainRatio: 0.5 }],
    attackSec: 0.001, decaySec: 0.12, sustainRatio: 0, releaseSec: 0.05,
    noiseBurst: { type: "white", attackSec: 0.001, decaySec: 0.16, bandpassHz: 1900, gain: 1.0 },
  } },
  { id: "clap", label: "Clap", color: "#f78c6b", hz: 100, voice: {
    harmonics: [], attackSec: 0.001, releaseSec: 0.02,
    noiseBurst: { type: "white", attackSec: 0.001, decaySec: 0.12, bandpassHz: 1500, gain: 0.95 },
  } },
  { id: "chat", label: "Hat", color: "#2dd36f", hz: 8000, voice: {
    harmonics: [], attackSec: 0.001, releaseSec: 0.02,
    noiseBurst: { type: "white", attackSec: 0.001, decaySec: 0.035, bandpassHz: 9000, gain: 0.6 },
  } },
  { id: "ohat", label: "Open Hat", color: "#06d6a0", hz: 8000, voice: {
    harmonics: [], attackSec: 0.001, releaseSec: 0.05,
    noiseBurst: { type: "white", attackSec: 0.001, decaySec: 0.3, bandpassHz: 8500, gain: 0.5 },
  } },
  { id: "tom", label: "Tom", color: "#0077b6", hz: 130, voice: {
    waveform: "sine", harmonics: [{ multiple: 1, gainRatio: 1.0 }],
    attackSec: 0.001, decaySec: 0.28, sustainRatio: 0, releaseSec: 0.05,
  } },
];

export const NUM_DRUMS = DRUMS.length;
export const emptyDrumPattern = (): boolean[][] => DRUMS.map(() => Array(DRUM_STEPS).fill(false));

type Props = {
  theme?: "dark" | "light";
  bpm: number;
  pattern: boolean[][];
  setPattern: React.Dispatch<React.SetStateAction<boolean[][]>>;
  vols: number[];
  setVols: React.Dispatch<React.SetStateAction<number[]>>;
  mutes: boolean[];
  setMutes: React.Dispatch<React.SetStateAction<boolean[]>>;
  busVol: number;
  setBusVol: (v: number) => void;
};

export default function DrumMachine({ theme = "dark", bpm, pattern, setPattern, vols, setVols, mutes, setMutes, busVol, setBusVol }: Props) {
  const [playing, setPlaying] = useState(isTransportPlaying());
  const [curStep, setCurStep] = useState(-1);

  const patternRef = useRef(pattern); patternRef.current = pattern;
  const bpmRef = useRef(bpm); bpmRef.current = bpm;
  const volsRef = useRef(vols); volsRef.current = vols;
  const mutesRef = useRef(mutes); mutesRef.current = mutes;
  const lastStepRef = useRef(-1);

  // Drive the grid from the shared transport clock (synced with the timeline).
  useEffect(() => {
    const unsub = subscribeTransport(pos => {
      if (pos < 0) { setPlaying(false); setCurStep(-1); lastStepRef.current = -1; return; }
      setPlaying(true);
      const stepDur = 60 / bpmRef.current / 4; // 16th notes
      const step = Math.floor(pos / stepDur) % DRUM_STEPS;
      if (step !== lastStepRef.current) {
        lastStepRef.current = step;
        const pat = patternRef.current;
        DRUMS.forEach((d, r) => {
          if (!mutesRef.current[r] && pat[r] && pat[r][step]) triggerDrum(d.hz, d.voice, volsRef.current[r]);
        });
        setCurStep(step);
      }
    });
    return unsub;
  }, []);

  const toggle = (r: number, s: number) =>
    setPattern(prev => prev.map((row, ri) => ri === r ? row.map((v, si) => si === s ? !v : v) : row));
  const clearRow = (r: number) => setPattern(prev => prev.map((row, ri) => ri === r ? Array(DRUM_STEPS).fill(false) : row));
  const clearAll = () => setPattern(emptyDrumPattern());

  const isLight = theme === "light";
  const bg = isLight ? "#f4f5f7" : "#15181d";
  const bd = isLight ? "#dadde2" : "#2a2f37";
  const lc = isLight ? "#555" : "#9aa3ad";
  const cellOff = isLight ? "#e4e7ec" : "#22262e";

  const btn = (active: boolean, color: string): React.CSSProperties => ({
    padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 700,
    border: `1px solid ${active ? color : bd}`, background: active ? color : "transparent",
    color: active ? "#fff" : color, transition: "all .15s",
  });

  return (
    <div style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 10, padding: 14, marginTop: 18, color: "var(--text-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 1 }}>🥁 DRUM MACHINE</span>
        <button onClick={toggleTransport} style={btn(playing, playing ? "#e63946" : "#2dd36f")}>{playing ? "■ STOP" : "▶ PLAY"}</button>
        <span style={{ fontSize: 11, color: lc }}>BPM {bpm} · общий транспорт</span>
        <button onClick={clearAll} style={btn(false, "#e6a23c")}>Очистить</button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: lc }}>DRUMS VOL</span>
          <input type="range" min={0} max={100} value={busVol} onChange={e => { setBusVol(Number(e.target.value)); setDrumBusVolume(Number(e.target.value) / 100); }} style={{ width: 100, accentColor: "#e63946" }} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {DRUMS.map((d, r) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => setMutes(m => m.map((v, i) => i === r ? !v : v))}
              title="Mute" style={{ width: 70, textAlign: "left", fontSize: 12, fontWeight: 700, color: mutes[r] ? lc : d.color, background: "transparent", border: "none", cursor: "pointer", opacity: mutes[r] ? 0.5 : 1 }}>
              {d.label}
            </button>
            <input type="range" min={0} max={150} value={Math.round((vols[r] ?? 1) * 100)}
              onChange={e => setVols(v => v.map((x, i) => i === r ? Number(e.target.value) / 100 : x))}
              style={{ width: 56, accentColor: d.color }} title="Громкость" />
            <div style={{ display: "flex", gap: 3, flex: 1 }}>
              {Array.from({ length: DRUM_STEPS }, (_, s) => {
                const on = pattern[r] && pattern[r][s];
                const beat = Math.floor(s / 4) % 2 === 0;
                const isCur = playing && curStep === s;
                return (
                  <button key={s} onClick={() => toggle(r, s)} style={{
                    flex: 1, height: 26, borderRadius: 4, cursor: "pointer",
                    border: isCur ? "2px solid #fff" : `1px solid ${bd}`,
                    background: on ? d.color : (beat ? cellOff : (isLight ? "#eef0f3" : "#1b1f26")),
                    boxShadow: on ? `0 0 6px ${d.color}` : "none", transition: "background .05s",
                  }} />
                );
              })}
            </div>
            <button onClick={() => clearRow(r)} title="Очистить дорожку" style={{ background: "transparent", border: "none", color: lc, cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 3, marginLeft: 132 }}>
          {Array.from({ length: DRUM_STEPS }, (_, s) => (
            <div key={s} style={{ flex: 1, textAlign: "center", fontSize: 9, color: s % 4 === 0 ? "var(--text-primary)" : lc }}>{s % 4 === 0 ? s / 4 + 1 : "·"}</div>
          ))}
          <div style={{ width: 14 }} />
        </div>
      </div>
    </div>
  );
}
