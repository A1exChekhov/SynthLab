"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PRESETS, SYSTEM_CATEGORIES, NUM_CHANNELS,
  startChannel, stopChannel, stopAllChannels,
  setChannelVolume, setChannelPan, setChannelMute, setChannelSolo,
  getChannelAnalyser, getStereoAnalyzers, setGlobalVolume, isAudioSupported,
  startRecording, stopRecording, isRecordingSupported, stopTransport,
} from "./frequency-synth";
import type { SynthPreset, NoiseBurst } from "./frequency-synth";
import DrumMachine, { NUM_DRUMS, emptyDrumPattern } from "./DrumMachine";
import Timeline from "./Timeline";
import type { Clip } from "./Timeline";

const STORAGE_KEY = "synth_custom_presets";

function loadCustomPresets(): Record<string, SynthPreset> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

type ChannelState = {
  presetKey: string;
  preset: SynthPreset;   // working clone, freely edited per channel
  hz: number;
  volume: number;        // 0..1.5
  pan: number;           // -1..1
  mute: boolean;
  solo: boolean;
  playing: boolean;
  expanded: boolean;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function hzToNote(hz: number): string {
  if (!hz || hz <= 0) return "-";
  const n = Math.round(12 * Math.log2(hz / 440) + 69);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

const DEFAULT_HZ = [
  110.0, 130.81, 164.81, 196.0, 220.0, 261.63, 329.63, 392.0,
  440.0, 523.25, 130.81, 174.61, 220.0, 293.66, 110.0, 146.83,
];

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

function firstBurst(nb: SynthPreset["noiseBurst"]): NoiseBurst | null {
  if (!nb) return null;
  return Array.isArray(nb) ? (nb[0] ?? null) : nb;
}

export default function StudioPanel({ theme = "dark", masterVolume = 0.5 }: { theme?: "dark" | "light"; masterVolume?: number }) {
  const customPresets = useMemo(() => loadCustomPresets(), []);
  const allPresets = useMemo<Record<string, SynthPreset>>(() => ({ ...PRESETS, ...customPresets }), [customPresets]);
  const customKeys = useMemo(() => new Set(Object.keys(customPresets)), [customPresets]);
  const presetKeys = useMemo(() => Object.keys(allPresets), [allPresets]);

  const grouped = useMemo(() => {
    const groups = SYSTEM_CATEGORIES.map(cat => ({
      id: cat.id, label: cat.label,
      keys: presetKeys.filter(k => !customKeys.has(k) && (allPresets[k].systemId || "uncategorized") === cat.id),
    })).filter(g => g.keys.length > 0);
    if (customKeys.size > 0) groups.push({ id: "__custom__", label: "🎙 Захваченные (Custom)", keys: [...customKeys] });
    return groups;
  }, [allPresets, presetKeys, customKeys]);

  const [supported] = useState(isAudioSupported());
  const [master, setMaster] = useState<number>(masterVolume * 100);

  const [channels, setChannels] = useState<ChannelState[]>(() =>
    Array.from({ length: NUM_CHANNELS }, (_, i) => {
      const presetKey = presetKeys[i % presetKeys.length] || "synthesizer";
      const p = allPresets[presetKey] || { waveform: "sine", harmonics: [{ multiple: 1, gainRatio: 1 }], attackSec: 0.4, releaseSec: 0.8 };
      return {
        presetKey,
        preset: clone(p),
        hz: p?.baseHz ?? DEFAULT_HZ[i] ?? 220,
        volume: 0.8, pan: 0, mute: false, solo: false, playing: false, expanded: false,
      } as ChannelState;
    })
  );

  const meterRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const masterRef = useRef<HTMLCanvasElement | null>(null);

  // keep a live ref to channels so the timeline scheduler reads current presets
  const channelsRef = useRef(channels); channelsRef.current = channels;

  // ── Shared tempo + transport state ──
  const [bpm, setBpm] = useState(110);
  const [tlLoop, setTlLoop] = useState(true);

  // ── Drum machine state (lifted for sync + project save) ──
  const [drumPattern, setDrumPattern] = useState<boolean[][]>(emptyDrumPattern);
  const [drumVols, setDrumVols] = useState<number[]>(Array(NUM_DRUMS).fill(1));
  const [drumMutes, setDrumMutes] = useState<boolean[]>(Array(NUM_DRUMS).fill(false));
  const [drumBusVol, setDrumBusVol] = useState(90);

  // ── Timeline arrangement ──
  const [tlDuration, setTlDuration] = useState(32);
  const [arrangement, setArrangement] = useState<Clip[]>(() =>
    Array.from({ length: NUM_CHANNELS }, (_, i) => ({ enter: Math.min(i * 1.5, 24), exit: Math.min(i * 1.5, 24) + 12, enabled: false }))
  );
  const tlEnter = (i: number) => { const c = channelsRef.current[i]; startChannel(i, c.preset, c.hz); patch(i, { playing: true }); };
  const tlExit = (i: number) => { stopChannel(i); patch(i, { playing: false }); };

  useEffect(() => {
    let raf = 0;
    const chBufs = Array.from({ length: NUM_CHANNELS }, () => new Uint8Array(new ArrayBuffer(128)));
    const mBuf = new Uint8Array(new ArrayBuffer(256));
    const rms = (b: Uint8Array) => { let s = 0; for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; s += v * v; } return Math.sqrt(s / b.length); };
    const paint = (g: CanvasRenderingContext2D, h: number, x: number, cw: number, level: number) => {
      g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(x, 0, cw, h);
      const bh = h * level; const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, "#2dd36f"); grad.addColorStop(0.7, "#ffd166"); grad.addColorStop(1, "#e63946");
      g.fillStyle = grad; g.fillRect(x, h - bh, cw, bh);
    };
    const draw = () => {
      for (let i = 0; i < NUM_CHANNELS; i++) {
        const cv = meterRefs.current[i]; if (!cv) continue;
        const g = cv.getContext("2d"); if (!g) continue;
        const an = getChannelAnalyser(i); let lvl = 0;
        if (an) { an.getByteTimeDomainData(chBufs[i]); lvl = Math.min(1, rms(chBufs[i]) * 3.2); }
        g.clearRect(0, 0, cv.width, cv.height); paint(g, cv.height, 0, cv.width, lvl);
      }
      const mcv = masterRef.current;
      if (mcv) { const g = mcv.getContext("2d"); const st = getStereoAnalyzers();
        if (g) { g.clearRect(0, 0, mcv.width, mcv.height); const cw = mcv.width / 2 - 3;
          ([[st?.L, 0], [st?.R, 1]] as [AnalyserNode | undefined, number][]).forEach(([an, idx]) => {
            let lvl = 0; if (an) { an.getByteTimeDomainData(mBuf); lvl = Math.min(1, rms(mBuf) * 3.2); }
            paint(g, mcv.height, idx * (cw + 6), cw, lvl);
          });
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => { stopTransport(); stopAllChannels(); }, []);

  const patch = (i: number, p: Partial<ChannelState>) => setChannels(prev => prev.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

  // (re)start a channel with its current working preset
  const restart = (i: number, ch: ChannelState) => startChannel(i, ch.preset, ch.hz);

  const playStop = (i: number) => {
    const c = channels[i];
    if (c.playing) { stopChannel(i); patch(i, { playing: false }); }
    else { restart(i, c); patch(i, { playing: true }); }
  };

  // edit the working preset; restart live if playing
  const editPreset = (i: number, mutate: (p: SynthPreset) => void) => {
    setChannels(prev => prev.map((c, idx) => {
      if (idx !== i) return c;
      const np = clone(c.preset); mutate(np);
      const nc = { ...c, preset: np };
      if (c.playing) startChannel(i, np, c.hz);
      return nc;
    }));
  };

  const pickPreset = (i: number, key: string) => {
    const p = allPresets[key]; if (!p) return;
    const np = clone(p);
    setChannels(prev => prev.map((c, idx) => {
      if (idx !== i) return c;
      const nc = { ...c, presetKey: key, preset: np, hz: p.baseHz ?? c.hz };
      if (c.playing) startChannel(i, np, nc.hz);
      return nc;
    }));
  };

  // Pick up an instrument handed off from the Capture panel → load into channel 1.
  useEffect(() => {
    let pending: string | null = null;
    try { pending = localStorage.getItem("studio_pending_preset"); } catch { /* ignore */ }
    if (pending && allPresets[pending]) {
      try { localStorage.removeItem("studio_pending_preset"); } catch { /* ignore */ }
      pickPreset(0, pending);
      patch(0, { expanded: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setHz = (i: number, hz: number) => setChannels(prev => prev.map((c, idx) => {
    if (idx !== i) return c; const nc = { ...c, hz };
    if (c.playing) startChannel(i, c.preset, hz); return nc;
  }));

  const vol = (i: number, v: number) => { setChannelVolume(i, v); patch(i, { volume: v }); };
  const pan = (i: number, p: number) => { setChannelPan(i, p); patch(i, { pan: p }); };
  const mute = (i: number) => { const m = !channels[i].mute; setChannelMute(i, m); patch(i, { mute: m }); };
  const solo = (i: number) => { const s = !channels[i].solo; setChannelSolo(i, s); patch(i, { solo: s }); };

  const playAll = () => { channels.forEach((c, i) => { if (!c.playing) restart(i, c); }); setChannels(prev => prev.map(c => ({ ...c, playing: true }))); };
  const stopAll = () => { stopAllChannels(); setChannels(prev => prev.map(c => ({ ...c, playing: false }))); };
  const onMaster = (v: number) => { setMaster(v); setGlobalVolume(v / 100); };

  // ── Recording ──
  const [recording, setRecording] = useState(false);
  const toggleRec = async () => {
    if (recording) {
      const blob = await stopRecording();
      setRecording(false);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ext = blob.type.includes("wav") ? "wav" : (blob.type.includes("webm") ? "webm" : "wav");
        a.href = url; a.download = `studio-mix.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } else {
      if (startRecording()) setRecording(true);
    }
  };

  // ── Project save / load ──
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const saveProject = () => {
    const project = {
      version: 1,
      master,
      bpm, tlLoop, tlDuration,
      channels: channels.map(c => ({ presetKey: c.presetKey, preset: c.preset, hz: c.hz, volume: c.volume, pan: c.pan, mute: c.mute, solo: c.solo })),
      arrangement,
      drum: { pattern: drumPattern, vols: drumVols, mutes: drumMutes, busVol: drumBusVol },
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "studio-project.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const loadProject = async (file: File) => {
    let p: any;
    try { p = JSON.parse(await file.text()); } catch { alert("Не удалось прочитать файл проекта."); return; }
    if (!p || !Array.isArray(p.channels)) { alert("Неверный формат проекта."); return; }
    stopTransport();
    stopAllChannels();
    if (typeof p.master === "number") { setMaster(p.master); setGlobalVolume(p.master / 100); }
    if (typeof p.bpm === "number") setBpm(p.bpm);
    if (typeof p.tlLoop === "boolean") setTlLoop(p.tlLoop);
    if (typeof p.tlDuration === "number") setTlDuration(p.tlDuration);
    // channels
    const loaded: ChannelState[] = Array.from({ length: NUM_CHANNELS }, (_, i) => {
      const src = p.channels[i];
      if (src && src.preset) {
        setChannelVolume(i, src.volume ?? 0.8);
        setChannelPan(i, src.pan ?? 0);
        setChannelMute(i, !!src.mute);
        setChannelSolo(i, !!src.solo);
        return { presetKey: src.presetKey ?? "", preset: src.preset, hz: src.hz ?? 220, volume: src.volume ?? 0.8, pan: src.pan ?? 0, mute: !!src.mute, solo: !!src.solo, playing: false, expanded: false };
      }
      return channels[i];
    });
    setChannels(loaded);
    if (Array.isArray(p.arrangement)) setArrangement(p.arrangement);
    if (p.drum) {
      if (Array.isArray(p.drum.pattern)) setDrumPattern(p.drum.pattern);
      if (Array.isArray(p.drum.vols)) setDrumVols(p.drum.vols);
      if (Array.isArray(p.drum.mutes)) setDrumMutes(p.drum.mutes);
      if (typeof p.drum.busVol === "number") setDrumBusVol(p.drum.busVol);
    }
  };

  if (!supported) return <div style={{ padding: 40, color: "var(--text-primary)" }}>Web Audio API не поддерживается.</div>;

  const isLight = theme === "light";
  const stripBg = isLight ? "#f4f5f7" : "#1a1d23";
  const editBg = isLight ? "#eceef1" : "#13161b";
  const bd = isLight ? "#dadde2" : "#2a2f37";
  const lc = isLight ? "#555" : "#9aa3ad";
  const inputBg = isLight ? "#fff" : "#0f1216";
  const anySolo = channels.some(c => c.solo);

  const btn = (active: boolean, color: string): React.CSSProperties => ({
    padding: "3px 0", width: "100%", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600,
    border: `1px solid ${active ? color : bd}`, background: active ? color : "transparent",
    color: active ? "#fff" : lc, transition: "all .15s",
  });
  const inp: React.CSSProperties = { width: "100%", fontSize: 11, padding: "2px 4px", borderRadius: 4, background: inputBg, color: "var(--text-primary)", border: `1px solid ${bd}` };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, fontSize: 10, color: lc };

  const burst = (i: number) => firstBurst(channels[i].preset.noiseBurst);

  return (
    <div style={{ padding: "76px 16px 24px", fontFamily: "'Inter','Helvetica Neue',sans-serif", color: "var(--text-primary)" }}>
      {/* Transport */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>🎚️ STUDIO RACK</span>
        <span style={{ fontSize: 12, color: lc }}>{NUM_CHANNELS} инструментов</span>
        <button onClick={playAll} style={{ ...btn(false, "#2dd36f"), width: "auto", padding: "6px 16px", color: "#2dd36f", borderColor: "#2dd36f" }}>▶ PLAY ALL</button>
        <button onClick={stopAll} style={{ ...btn(false, "#e63946"), width: "auto", padding: "6px 16px", color: "#e63946", borderColor: "#e63946" }}>■ STOP ALL</button>
        {isRecordingSupported() && (
          <button onClick={toggleRec} style={{ ...btn(recording, "#e63946"), width: "auto", padding: "6px 16px", color: recording ? "#fff" : "#e63946", borderColor: "#e63946" }}>
            {recording ? "● REC… ⏹ Стоп+WAV" : "● REC (WAV)"}
          </button>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: lc }}>
          BPM
          <input type="number" min={40} max={300} value={bpm} onChange={e => setBpm(Math.max(40, Number(e.target.value)))}
            style={{ width: 56, fontSize: 12, padding: "3px 4px", borderRadius: 4, background: inputBg, color: "var(--text-primary)", border: `1px solid ${bd}` }} />
        </label>
        <button onClick={saveProject} style={{ ...btn(false, "#7d5fff"), width: "auto", padding: "6px 14px", color: "#7d5fff", borderColor: "#7d5fff" }}>💾 Проект</button>
        <button onClick={() => fileInputRef.current?.click()} style={{ ...btn(false, "#0077b6"), width: "auto", padding: "6px 14px", color: "#0077b6", borderColor: "#0077b6" }}>📂 Загрузить</button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) loadProject(f); e.target.value = ""; }} />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: lc }}>MASTER</span>
          <canvas ref={masterRef} width={28} height={40} style={{ borderRadius: 3, background: stripBg }} />
          <input type="range" min={0} max={100} value={master} onChange={e => onMaster(Number(e.target.value))} style={{ width: 120, accentColor: "#e63946" }} />
          <span style={{ fontSize: 11, color: lc, width: 32 }}>{Math.round(master)}%</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, alignItems: "start" }}>
        {channels.map((ch, i) => {
          const dim = anySolo && !ch.solo;
          const rep = ch.preset.repeat;
          const nb = burst(i);
          return (
            <div key={i} style={{
              background: stripBg, border: `1px solid ${ch.playing ? "#2dd36f" : bd}`, borderRadius: 8, padding: 8,
              display: "flex", flexDirection: "column", gap: 6, opacity: dim ? 0.5 : 1, transition: "opacity .15s, border-color .15s",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: lc }}>CH {i + 1}</span>
                <span style={{ fontSize: 10, color: ch.playing ? "#2dd36f" : lc }}>{ch.playing ? "● LIVE" : "○"}</span>
              </div>

              <select value={ch.presetKey} onChange={e => pickPreset(i, e.target.value)} style={inp}>
                {grouped.map(g => (
                  <optgroup key={g.id} label={g.label}>
                    {g.keys.map(k => <option key={k} value={k}>{allPresets[k].name || k}</option>)}
                  </optgroup>
                ))}
              </select>

              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="number" value={Math.round(ch.hz * 100) / 100} step={0.01} onChange={e => setHz(i, Number(e.target.value))} style={inp} />
                <span style={{ fontSize: 10, color: lc, minWidth: 28, textAlign: "right" }}>{hzToNote(ch.hz)}</span>
              </div>

              <div style={{ display: "flex", gap: 6, height: 86 }}>
                <input type="range" min={0} max={150} value={Math.round(ch.volume * 100)} onChange={e => vol(i, Number(e.target.value) / 100)}
                  style={{ writingMode: "vertical-lr", direction: "rtl", width: 22, accentColor: "#2dd36f" } as React.CSSProperties} />
                <canvas ref={el => { meterRefs.current[i] = el; }} width={12} height={86} style={{ borderRadius: 3, background: inputBg }} />
                <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 }}>
                  <span style={{ fontSize: 10, color: lc, textAlign: "center" }}>{Math.round(ch.volume * 100)}</span>
                  <div>
                    <div style={{ fontSize: 9, color: lc, textAlign: "center" }}>PAN</div>
                    <input type="range" min={-100} max={100} value={Math.round(ch.pan * 100)} onChange={e => pan(i, Number(e.target.value) / 100)} style={{ width: "100%", accentColor: "#0077b6" }} />
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => mute(i)} style={btn(ch.mute, "#e6a23c")}>M</button>
                <button onClick={() => solo(i)} style={btn(ch.solo, "#0077b6")}>S</button>
                <button onClick={() => patch(i, { expanded: !ch.expanded })} style={btn(ch.expanded, "#7d5fff")} title="Редактор инструмента">⚙</button>
              </div>

              <button onClick={() => playStop(i)} style={btn(ch.playing, ch.playing ? "#e63946" : "#2dd36f")}>
                {ch.playing ? "■ STOP" : "▶ PLAY"}
              </button>

              {/* ── Per-channel instrument editor (replicated from the console) ── */}
              {ch.expanded && (
                <div style={{ background: editBg, border: `1px solid ${bd}`, borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 10, marginTop: 2 }}>
                  {/* SEQUENCER */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#ffb347", marginBottom: 4 }}>СЕКВЕНСОР</div>
                    <label style={{ ...row, justifyContent: "flex-start", gap: 6, marginBottom: 4 }}>
                      <input type="checkbox" checked={rep?.enabled || false}
                        onChange={e => editPreset(i, p => { p.repeat = { ...(p.repeat || { intervalSec: 1 }), enabled: e.target.checked } as any; })} />
                      Авто-повтор (ритм)
                    </label>
                    <div style={{ opacity: rep?.enabled ? 1 : 0.4, pointerEvents: rep?.enabled ? "auto" : "none", display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={row}>Интервал, c
                        <input type="number" step={0.05} min={0.05} value={rep?.intervalSec ?? 1} style={{ ...inp, width: 56 }}
                          onChange={e => editPreset(i, p => { p.repeat = { ...(p.repeat || { enabled: true }), intervalSec: Number(e.target.value) } as any; })} /></label>
                      <label style={row}>Джиттер, c
                        <input type="number" step={0.05} min={0} value={rep?.timingJitterSec ?? 0} style={{ ...inp, width: 56 }}
                          onChange={e => editPreset(i, p => { p.repeat = { ...(p.repeat || { enabled: true, intervalSec: 1 }), timingJitterSec: Number(e.target.value) } as any; })} /></label>
                      <label style={{ ...row, justifyContent: "flex-start", gap: 6 }}>
                        <input type="checkbox" checked={rep?.doubleStrike?.enabled || false}
                          onChange={e => editPreset(i, p => { const r: any = { ...(p.repeat || { enabled: true, intervalSec: 1 }) }; r.doubleStrike = { ...(r.doubleStrike || { delaySec: 0.1, gain: 0.5 }), enabled: e.target.checked }; p.repeat = r; })} />
                        Двойной удар
                      </label>
                    </div>
                  </div>

                  {/* FILTERS */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#ffd166", marginBottom: 4 }}>ФИЛЬТРЫ</div>
                    <label style={row}>LPF, Гц
                      <input type="number" step={50} value={ch.preset.lowpassHz ?? 20000} style={{ ...inp, width: 64 }}
                        onChange={e => editPreset(i, p => { p.lowpassHz = Number(e.target.value); })} /></label>
                    <label style={row}>HPF, Гц
                      <input type="number" step={10} value={ch.preset.highpassHz ?? 20} style={{ ...inp, width: 64 }}
                        onChange={e => editPreset(i, p => { p.highpassHz = Number(e.target.value); })} /></label>
                    <label style={row}>Волна
                      <select value={ch.preset.waveform} style={{ ...inp, width: 80 }}
                        onChange={e => editPreset(i, p => { p.waveform = e.target.value as OscillatorType; })}>
                        <option value="sine">sine</option><option value="triangle">triangle</option>
                        <option value="sawtooth">saw</option><option value="square">square</option>
                      </select></label>
                  </div>

                  {/* IMPACT (hit) */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#e63946", marginBottom: 4 }}>УДАР (IMPACT)</div>
                    <label style={row}>Тип
                      <select value={nb?.type ?? "pink"} style={{ ...inp, width: 80 }}
                        onChange={e => editPreset(i, p => { const b = firstBurst(p.noiseBurst) || { type: "pink", attackSec: 0.005, decaySec: 0.3, gain: 0 } as NoiseBurst; p.noiseBurst = { ...b, type: e.target.value as NoiseBurst["type"] }; })}>
                        <option value="white">white</option><option value="pink">pink</option>
                      </select></label>
                    <label style={row}>Громкость удара
                      <input type="range" min={0} max={200} value={Math.round((nb?.gain ?? 0) * 100)} style={{ width: 80, accentColor: "#e63946" }}
                        onChange={e => editPreset(i, p => { const b = firstBurst(p.noiseBurst) || { type: "pink", attackSec: 0.005, decaySec: 0.3, gain: 0 } as NoiseBurst; p.noiseBurst = { ...b, gain: Number(e.target.value) / 100 }; })} /></label>
                    <label style={row}>Спад удара, c
                      <input type="number" step={0.05} min={0.02} value={nb?.decaySec ?? 0.3} style={{ ...inp, width: 56 }}
                        onChange={e => editPreset(i, p => { const b = firstBurst(p.noiseBurst) || { type: "pink", attackSec: 0.005, decaySec: 0.3, gain: 0 } as NoiseBurst; p.noiseBurst = { ...b, decaySec: Number(e.target.value) }; })} /></label>
                  </div>

                  {/* REVERB + harmonics count */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#05d9e8", marginBottom: 4 }}>ПРОСТРАНСТВО</div>
                    <label style={row}>Reverb wet
                      <input type="range" min={0} max={100} value={Math.round((ch.preset.reverb?.wet ?? 0) * 100)} style={{ width: 80, accentColor: "#05d9e8" }}
                        onChange={e => editPreset(i, p => { p.reverb = { ...(p.reverb || { decaySec: 4, preDelayMs: 20 }), wet: Number(e.target.value) / 100 } as any; })} /></label>
                    <div style={{ ...row, marginTop: 4 }}>Гармоник (партиалов): <b style={{ color: "var(--text-primary)" }}>{ch.preset.harmonics?.length ?? 0}</b></div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Timeline
        theme={theme}
        lanes={channels.map((c, i) => ({ label: `CH${i + 1} · ${allPresets[c.presetKey]?.name || c.presetKey}` }))}
        arrangement={arrangement}
        setArrangement={setArrangement}
        duration={tlDuration}
        setDuration={setTlDuration}
        bpm={bpm}
        loop={tlLoop}
        setLoop={setTlLoop}
        onEnter={tlEnter}
        onExit={tlExit}
      />

      <DrumMachine
        theme={theme}
        bpm={bpm}
        pattern={drumPattern}
        setPattern={setDrumPattern}
        vols={drumVols}
        setVols={setDrumVols}
        mutes={drumMutes}
        setMutes={setDrumMutes}
        busVol={drumBusVol}
        setBusVol={setDrumBusVol}
      />
    </div>
  );
}
