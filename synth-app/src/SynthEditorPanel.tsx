"use client";

import { useState, useEffect } from "react";
import {
  playFrequency, stopFrequency, isAudioSupported, PRESETS,
  startSequence, stopSequence, isSequencePlaying, stopAllSequences, updateSequencePreset,
  getAnalyzer, getStereoAnalyzers, SYSTEM_CATEGORIES, updateActiveOutputGain
} from "./frequency-synth";
import type { SynthPreset, Harmonic, ReverbConfig } from "./frequency-synth";
import AnalogNeedleGauge from "./AnalogNeedleGauge";
import AudioVisualizer from "./AudioVisualizer";

const STORAGE_KEY = "synth_custom_presets";
const ORIGINAL_KEYS = [
  "crystal_bowl", "tibetan_bowl", "bells", "dramyen", "drum", 
  "monastery", "dungchen", "synthesizer", "lingm", "gong", "tibetan_bowl_low"
];
const DEFAULT_PRESET_KEYS = new Set(ORIGINAL_KEYS);

function loadCustomPresets(): Record<string, SynthPreset> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}
function saveCustomPresets(p: Record<string, SynthPreset>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

// --- Console Components ---

const VerticalFader = ({ label, value, min, max, step, onChange, unit, color, height = 150 }: any) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", width: "50px" }}>
      <div style={{ fontSize: "13px", color: color, fontFamily: "monospace", fontWeight: "bold", textShadow: `0 0 5px ${color}` }}>
        {Number(value).toFixed(step < 1 ? 2 : 0)}{unit}
      </div>
      <div style={{ position: "relative", height: `${height}px`, width: "20px", background: "#111", borderRadius: "4px", border: "1px solid #333", display: "flex", justifyContent: "center" }}>
        <input 
          type="range" 
          min={min} max={max} step={step} 
          value={value} 
          onChange={e => onChange(Number(e.target.value))}
          style={{
            position: "absolute",
            width: `${height}px`,
            height: "20px",
            top: `${height / 2 - 10}px`,
            left: `${-height / 2 + 10}px`,
            transform: "rotate(-90deg)",
            appearance: "none",
            background: "transparent",
            cursor: "pointer",
            margin: 0
          }}
        />
        {/* Track line */}
        <div style={{ position: "absolute", width: "2px", height: "100%", background: "#222", zIndex: 0 }} />
        {/* Fader Cap (Visual only, actual input handles interaction) */}
        <div style={{ 
          position: "absolute", 
          bottom: `${((value - min) / (max - min)) * (height - 20)}px`,
          width: "24px", height: "20px", background: "#333", border: `1px solid ${color}`, borderRadius: "2px", zIndex: 1, pointerEvents: "none",
          boxShadow: `0 0 5px ${color}`
        }} />
      </div>
      <div style={{ fontSize: "11px", color: "#aaa", textAlign: "center", fontWeight: "bold", lineHeight: "1.2" }}>
        {label.split(' ').map((l: string, i: number) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
};

const Knob = ({ label, value, min, max, step, onChange, color }: any) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", width: "44px" }}>
      <div style={{ fontSize: "11px", color: color, fontFamily: "monospace", fontWeight: "bold" }}>{Number(value).toFixed(step < 1 ? 2 : 0)}</div>
      <input 
        type="range" 
        min={min} max={max} step={step} 
        value={value} 
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "36px", accentColor: color }}
      />
      <div style={{ fontSize: "10px", color: "#aaa", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%" }}>
        {label}
      </div>
    </div>
  );
};

export default function SynthEditorPanel() {
  const [customPresets, setCustomPresets] = useState<Record<string, SynthPreset>>(loadCustomPresets);
  const allPresets = { ...PRESETS, ...customPresets };
  
  const [activeGlobalTab, setActiveGlobalTab] = useState<"default" | "custom" | "systems">("default");
  const [activeSystemId, setActiveSystemId] = useState<string>("solfeggio");

  const presetKeys = Object.keys(allPresets);
  const filteredPresetKeys = presetKeys.filter(key => {
    if (activeGlobalTab === "default") return DEFAULT_PRESET_KEYS.has(key);
    if (activeGlobalTab === "custom") return Object.prototype.hasOwnProperty.call(customPresets, key);
    if (activeGlobalTab === "systems") {
      const sysId = allPresets[key].systemId || "uncategorized";
      return sysId === activeSystemId;
    }
    return true;
  });

  const [activePresetKey, setActivePresetKey] = useState<string>(presetKeys[0] || "");
  const [playingIds, setPlayingIds] = useState<Set<string>>(new Set());
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [analyzer, setAnalyzer] = useState<AnalyserNode | null>(null);

  // Stereo Metering State
  const [stereoL, setStereoL] = useState(0);
  const [stereoR, setStereoR] = useState(0);

  const [testHz, setTestHz] = useState<number>(136.1);
  const [testLoop] = useState<boolean>(false);
  const [testDuration] = useState<number>(4.0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => { 
    setSupported(isAudioSupported());
    setAnalyzer(getAnalyzer());

    // Stereo Metering Loop
    let animationId: number;
    const updateMeters = () => {
      animationId = requestAnimationFrame(updateMeters);
      const stereoAnalyzers = getStereoAnalyzers();
      if (stereoAnalyzers) {
        const { L, R } = stereoAnalyzers;
        const dataL = new Float32Array(L.fftSize);
        const dataR = new Float32Array(R.fftSize);
        L.getFloatTimeDomainData(dataL);
        R.getFloatTimeDomainData(dataR);

        // Calculate RMS (Root Mean Square)
        let sumL = 0, sumR = 0;
        for (let i = 0; i < dataL.length; i++) {
          sumL += dataL[i] * dataL[i];
          sumR += dataR[i] * dataR[i];
        }
        
        const rmsL = Math.sqrt(sumL / dataL.length);
        const rmsR = Math.sqrt(sumR / dataR.length);

        // Convert to percentage for gauge (rough mapping, RMS 0.5 is very loud)
        setStereoL(Math.min(100, rmsL * 300));
        setStereoR(Math.min(100, rmsR * 300));
      }
    };
    updateMeters();

    return () => cancelAnimationFrame(animationId);
  }, []);

  const [editedPreset, setEditedPreset] = useState<SynthPreset | null>(null);

  useEffect(() => {
    const p = allPresets[activePresetKey];
    if (p) {
      setEditedPreset(JSON.parse(JSON.stringify(p)));
      if (p.baseHz) setTestHz(p.baseHz);
    }
  }, [activePresetKey]);

  useEffect(() => {
    if (!editedPreset) return;
    if (playingIds.has(activePresetKey) && isSequencePlaying(activePresetKey)) {
      updateSequencePreset(activePresetKey, { ...editedPreset, masterVolume: volumes[activePresetKey] ?? editedPreset.masterVolume ?? 1.0 }, testHz);
    }
  }, [editedPreset, testHz]);

  const toggleCard = (key: string) => {
    const p = allPresets[key];
    if (!p) return;
    if (playingIds.has(key)) {
      stopSequence(key);
      setPlayingIds(prev => { const s = new Set(prev); s.delete(key); return s; });
    } else {
      const vol = volumes[key] ?? 1.0;
      startSequence(key, { ...p, masterVolume: vol }, p.baseHz ?? testHz);
      setPlayingIds(prev => new Set(prev).add(key));
    }
  };

  const setVolume = (key: string, vol: number) => {
    setVolumes(prev => ({ ...prev, [key]: vol }));
    if (isSequencePlaying(key)) {
      const p = allPresets[key];
      if (p) {
        stopSequence(key);
        startSequence(key, { ...p, masterVolume: vol }, p.baseHz ?? testHz);
      }
    }
  };

  const stopAll = () => {
    stopAllSequences();
    stopFrequency();
    setPlayingIds(new Set());
    setIsPlaying(false);
    setIsAutoPlaying(false);
  };

  const saveAsCustom = () => {
    if (!editedPreset) return;
    const name = prompt("Название нового пресета:", editedPreset.name ?? activePresetKey + "_copy");
    if (!name) return;
    const group = prompt("Папка (группа):", editedPreset.groupId || "");
    if (group === null) return;

    const key = name.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now().toString().slice(-4);
    const newPreset = { ...editedPreset, name, groupId: group.trim() || undefined };
    const updated = { ...customPresets, [key]: newPreset };
    setCustomPresets(updated);
    saveCustomPresets(updated);
    setActivePresetKey(key);
  };

  const updateCustomPreset = () => {
    if (!editedPreset) return;
    let finalPreset = { ...editedPreset };
    const systemOrig = PRESETS[activePresetKey];
    if (systemOrig && systemOrig.baseHz) finalPreset.baseHz = systemOrig.baseHz;
    const updated = { ...customPresets, [activePresetKey]: finalPreset };
    setCustomPresets(updated);
    saveCustomPresets(updated);
  };

  const handlePlay = () => {
    if (!editedPreset) return;
    if (editedPreset.repeat?.enabled) {
      startSequence("__test_seq__", editedPreset, testHz);
      setIsAutoPlaying(true);
      return;
    }
    stopFrequency();
    const success = playFrequency(testHz, { 
      ...editedPreset,
      loop: testLoop,
      durationSec: testDuration,
      preset: undefined
    });
    if (success) setIsPlaying(true);
  };

  const handleStop = () => {
    if (isAutoPlaying) stopSequence("__test_seq__");
    setIsAutoPlaying(false);
    stopFrequency();
    setIsPlaying(false);
  };

  const triggerRestart = (newPreset: SynthPreset) => {
    if (isPlaying) {
      setTimeout(() => {
        stopFrequency();
        playFrequency(testHz, { ...newPreset, loop: testLoop, durationSec: testDuration, preset: undefined });
      }, 50);
    } else if (isAutoPlaying) {
      updateSequencePreset("__test_seq__", newPreset, testHz);
    }
  };

  const updateGlobal = (field: keyof SynthPreset, value: any, skipRestart: boolean = false) => {
    if (!editedPreset) return;
    const newPreset = { ...editedPreset };
    if (value === "" || value === undefined) delete newPreset[field];
    else newPreset[field] = value as never;
    setEditedPreset(newPreset);
    if (!skipRestart) triggerRestart(newPreset);
  };

  const updateHarmonic = (index: number, field: keyof Harmonic, value: any) => {
    if (!editedPreset) return;
    const newHarmonics = [...editedPreset.harmonics];
    newHarmonics[index] = { ...newHarmonics[index], [field]: typeof value === "number" ? value : Number(value) };
    const newPreset = { ...editedPreset, harmonics: newHarmonics };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const removeHarmonic = (index: number) => {
    if (!editedPreset) return;
    const newHarmonics = editedPreset.harmonics.filter((_, i) => i !== index);
    const newPreset = { ...editedPreset, harmonics: newHarmonics };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const addHarmonic = () => {
    if (!editedPreset) return;
    const newHarmonics = [...editedPreset.harmonics, { multiple: 1, gainRatio: 0.5, gainL: 0.5, gainR: 0.5 }];
    const newPreset = { ...editedPreset, harmonics: newHarmonics };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateNoiseBurst = (field: keyof any, value: any) => {
    if (!editedPreset) return;
    let nb: any = editedPreset.noiseBurst ? { ...editedPreset.noiseBurst } : { type: "pink", attackSec: 0.01, decaySec: 0.5, gain: 1 };
    nb[field] = value;
    const newPreset = { ...editedPreset, noiseBurst: nb };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateRepeat = (field: keyof any, value: any) => {
    if (!editedPreset) return;
    let rep: any = editedPreset.repeat ? { ...editedPreset.repeat } : { enabled: false, intervalSec: 1.0 };
    if (field === "doubleStrike") {
      rep.doubleStrike = { ...(rep.doubleStrike || { enabled: false, delaySec: 0.1, gain: 0.5 }), ...value };
    } else {
      rep[field] = value;
    }
    const newPreset = { ...editedPreset, repeat: rep };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateReverb = (field: keyof ReverbConfig, value: any) => {
    if (!editedPreset) return;
    let newReverb: ReverbConfig = editedPreset.reverb ? { ...editedPreset.reverb } : { wet: 0, decaySec: 4.0, preDelayMs: 20 };
    (newReverb as any)[field] = value;
    const newPreset = { ...editedPreset, reverb: newReverb };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  // --- STYLES & UI ---
  const colors = {
    bg: "#050508",
    panel: "rgba(20, 20, 30, 0.9)",
    accent: "#ff2a6d",
    accentCyan: "#05d9e8",
    accentAmber: "#ffb347",
    text: "#e0e0e0",
    textSecondary: "#8a8a8a",
    border: "#333344"
  };

  const buttonStyle = (active: boolean, color = colors.accent) => ({
    background: active ? color : "transparent",
    border: `1px solid ${color}`,
    color: active ? "#000" : color,
    padding: "6px 14px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    boxShadow: active ? `0 0 10px ${color}` : "none",
    transition: "all 0.2s"
  });

  const inputStyle = {
    background: "#11111a",
    border: "1px solid #333344",
    color: colors.accentCyan,
    padding: "4px 8px",
    borderRadius: "4px",
    fontSize: "12px",
    fontFamily: "monospace",
    outline: "none"
  };

  const renderPresetCard = (key: string) => {
    const preset = allPresets[key];
    const isActive = activePresetKey === key;
    const isPlaying = playingIds.has(key);
    const vol = volumes[key] ?? 1.0;
    return (
      <div key={key} style={{
        background: isActive ? "rgba(255, 42, 109, 0.05)" : "rgba(255, 255, 255, 0.02)",
        border: `1px solid ${isActive ? colors.accent : colors.border}`,
        boxShadow: isPlaying ? `0 0 10px ${colors.accent}` : "none",
        borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px",
        transition: "all 0.2s"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span onClick={() => setActivePresetKey(key)} style={{ fontSize: "14px", fontWeight: 600, color: isActive ? colors.accent : colors.text, cursor: "pointer" }}>
            {preset.name ?? key}
          </span>
          {isPlaying && <span style={{ color: colors.accent, fontSize: "10px" }}>● LIVE</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input type="range" min="0" max="1" step="0.05" value={vol}
            onChange={e => setVolume(key, Number(e.target.value))}
            style={{ flex: 1, accentColor: colors.accent }} />
          <span style={{ fontSize: "10px", width: "24px" }}>{Math.round(vol * 100)}%</span>
        </div>
        <button onClick={() => toggleCard(key)} style={buttonStyle(isPlaying, colors.accentCyan)}>
          {isPlaying ? "STOP" : "PLAY"}
        </button>
      </div>
    );
  };

  if (!supported) return <div style={{ color: colors.accent, padding: "20px" }}>Web Audio API not supported.</div>;

  return (
    <div style={{ minHeight: "100vh", background: colors.bg, color: colors.text, padding: "24px", fontFamily: "monospace" }}>
      <div style={{ width: "100%", display: "grid", gridTemplateColumns: "350px 1fr", gap: "24px" }}>
        
        {/* Sidebar: Presets */}
        <div style={{ background: colors.panel, padding: "20px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "20px" }}>
          <h2 style={{ fontSize: "18px", color: colors.accent, borderBottom: `1px solid ${colors.border}`, paddingBottom: "10px", margin: 0 }}>INSTRUMENT RACK</h2>
          
          <div style={{ display: "flex", gap: "4px" }}>
            <button onClick={() => setActiveGlobalTab("default")} style={buttonStyle(activeGlobalTab === "default", colors.accentCyan)}>FACTORY</button>
            <button onClick={() => setActiveGlobalTab("custom")} style={buttonStyle(activeGlobalTab === "custom", colors.accent)}>USER</button>
            <button onClick={() => setActiveGlobalTab("systems")} style={buttonStyle(activeGlobalTab === "systems", colors.accentCyan)}>SYSTEM</button>
          </div>

          {activeGlobalTab === "systems" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {SYSTEM_CATEGORIES.map(cat => (
                <button 
                  key={cat.id} 
                  onClick={() => setActiveSystemId(cat.id)}
                  style={{
                    ...buttonStyle(activeSystemId === cat.id, colors.accentCyan),
                    fontSize: "10px",
                    padding: "4px 8px",
                    flex: "1 1 auto",
                    whiteSpace: "nowrap"
                  }}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px", maxHeight: "70vh", overflowY: "auto", paddingRight: "5px" }}>
            {filteredPresetKeys.map(renderPresetCard)}
          </div>

          <button onClick={stopAll} style={{ ...buttonStyle(true, "#ff0000"), width: "100%", marginTop: "auto" }}>EMERGENCY STOP</button>
        </div>

        {/* Main: Editor */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          
          {/* Top Bar: Visual Feedback */}
          <div style={{ background: colors.panel, padding: "24px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", justifyContent: "space-around", alignItems: "center", gap: "20px" }}>
            
            {/* Left Channel Monitor */}
            <AnalogNeedleGauge label="LEFT CH" value={stereoL} unit="%" color={colors.accent} />
            
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
              <AudioVisualizer analyzer={analyzer} color={colors.accentCyan} height={80} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "24px", color: colors.accentCyan, fontWeight: "bold", textShadow: "0 0 10px rgba(5, 217, 232, 0.5)" }}>
                  {testHz.toFixed(1)} <span style={{ fontSize: "14px" }}>Hz</span>
                </div>
                <div style={{ marginTop: "8px", display: "flex", gap: "8px", justifyContent: "center" }}>
                  <button onClick={handlePlay} style={buttonStyle(isPlaying || isAutoPlaying)}>LIVE TEST</button>
                  <button onClick={handleStop} style={buttonStyle(false, "#666")}>OFF</button>
                </div>
              </div>
            </div>

            {/* Right Channel Monitor */}
            <AnalogNeedleGauge label="RIGHT CH" value={stereoR} unit="%" color={colors.accent} />
          </div>

          {/* --- MIXING CONSOLE --- */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", background: "#0a0a0f", padding: "24px", borderRadius: "12px", border: `2px solid #222`, boxShadow: "inset 0 0 20px rgba(0,0,0,0.8)" }}>
            
            {/* MASTER & GLOBAL FX ROW */}
            <div style={{ display: "flex", gap: "20px", borderBottom: "1px solid #222", paddingBottom: "20px", overflowX: "auto" }}>
              {/* MASTER STRIP */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "16px", background: "linear-gradient(180deg, #151520 0%, #0d0d14 100%)", borderRadius: "8px", border: "1px solid #333", minWidth: "120px", alignItems: "center" }}>
                <h3 style={{ margin: 0, fontSize: "12px", color: colors.accent, borderBottom: `1px solid ${colors.accent}`, paddingBottom: "4px", width: "100%", textAlign: "center" }}>MASTER</h3>
                <VerticalFader 
                  label="OUTPUT GAIN" value={editedPreset?.outputGain ?? 2.0} min={0.1} max={10.0} step={0.1} unit="x" color={colors.accent} height={120}
                  onChange={(v: number) => {
                    updateActiveOutputGain(v);
                    updateGlobal("outputGain", v, true);
                  }} 
                />
              </div>

              {/* GLOBAL FX */}
              <div style={{ display: "flex", gap: "16px", padding: "16px", background: "linear-gradient(180deg, #151520 0%, #0d0d14 100%)", borderRadius: "8px", border: "1px solid #333", flex: 1 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                   <h3 style={{ margin: 0, fontSize: "12px", color: colors.accentCyan }}>REVERB</h3>
                   <div style={{ display: "flex", gap: "12px" }}>
                     <Knob label="WET" value={editedPreset?.reverb?.wet || 0} min={0} max={1} step={0.05} color={colors.accentCyan} onChange={(v: number) => updateReverb("wet", v)} />
                     <Knob label="DECAY" value={editedPreset?.reverb?.decaySec || 4} min={0.1} max={20} step={0.1} color={colors.accentCyan} onChange={(v: number) => updateReverb("decaySec", v)} />
                     <Knob label="PREDELAY" value={editedPreset?.reverb?.preDelayMs || 20} min={0} max={200} step={1} color={colors.accentCyan} onChange={(v: number) => updateReverb("preDelayMs", v)} />
                   </div>
                </div>
                <div style={{ width: "1px", background: "#333", margin: "0 10px" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                   <h3 style={{ margin: 0, fontSize: "12px", color: colors.accentAmber }}>FILTERS & SPATIAL</h3>
                   <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
                     <Knob label="LPF HZ" value={editedPreset?.lowpassHz || 20000} min={200} max={20000} step={100} color={colors.accentAmber} onChange={(v: number) => updateGlobal("lowpassHz", v)} />
                     <Knob label="HPF HZ" value={editedPreset?.highpassHz || 20} min={20} max={5000} step={10} color={colors.accentAmber} onChange={(v: number) => updateGlobal("highpassHz", v)} />
                     <Knob label="SPREAD" value={editedPreset?.stereoSpread || 0} min={0} max={1} step={0.01} color={colors.text} onChange={(v: number) => updateGlobal("stereoSpread", v)} />
                     <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", color: colors.textSecondary, marginLeft: "10px" }}>
                        WAVEFORM
                        <select value={editedPreset?.waveform || "sine"} onChange={e => updateGlobal("waveform", e.target.value)} style={{ ...inputStyle, width: "90px", fontSize: "11px", padding: "3px" }}>
                          <option value="sine">SINE</option>
                          <option value="triangle">TRIANGLE</option>
                          <option value="sawtooth">SAWTOOTH</option>
                          <option value="square">SQUARE</option>
                        </select>
                     </label>
                     <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", color: colors.textSecondary, marginLeft: "10px" }}>
                        PAN TYPE
                        <select value={editedPreset?.pannerType || "stereo"} onChange={e => updateGlobal("pannerType", e.target.value)} style={{ ...inputStyle, width: "90px", fontSize: "11px", padding: "3px" }}>
                          <option value="stereo">STEREO</option>
                          <option value="3d">3D SPATIAL</option>
                        </select>
                     </label>
                     <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", color: colors.textSecondary, marginLeft: "10px" }}>
                        TEMPLATE
                        <select value="" onChange={e => {
                          if (!e.target.value || !editedPreset) return;
                          const tpl = allPresets[e.target.value];
                          if (!tpl) return;
                          const preserved = { name: editedPreset.name, baseHz: editedPreset.baseHz, systemId: editedPreset.systemId };
                          setEditedPreset({ ...JSON.parse(JSON.stringify(tpl)), ...preserved });
                        }} style={{ ...inputStyle, width: "130px", fontSize: "11px", padding: "3px" }}>
                          <option value="">-- Select --</option>
                          {Object.keys(PRESETS).filter(k => DEFAULT_PRESET_KEYS.has(k)).map(k => (
                            <option key={k} value={k}>{PRESETS[k].name ?? k}</option>
                          ))}
                        </select>
                     </label>
                   </div>
                </div>
              </div>

              {/* SEQUENCER (Moved to top row) */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "16px", background: "linear-gradient(180deg, #1a1a15 0%, #12120d 100%)", borderRadius: "8px", border: "1px solid #443", flex: 1 }}>
                 <h3 style={{ margin: 0, fontSize: "12px", color: colors.accentAmber }}>SEQUENCER (MEDITATION)</h3>
                 <label style={{ display: "flex", gap: "8px", fontSize: "10px", color: colors.text, alignItems: "center" }}>
                   <input type="checkbox" checked={editedPreset?.repeat?.enabled || false} onChange={e => updateRepeat("enabled", e.target.checked)} />
                   ENABLE AUTO-PLAY
                 </label>
                 <div style={{ display: "flex", gap: "12px", opacity: editedPreset?.repeat?.enabled ? 1 : 0.3, pointerEvents: editedPreset?.repeat?.enabled ? "auto" : "none" }}>
                   <Knob label="INTERVAL" value={editedPreset?.repeat?.intervalSec || 1} min={0.1} max={20} step={0.1} color={colors.accentAmber} onChange={(v: number) => updateRepeat("intervalSec", v)} />
                   <Knob label="JITTER" value={editedPreset?.repeat?.timingJitterSec || 0} min={0} max={5} step={0.1} color={colors.accentAmber} onChange={(v: number) => updateRepeat("timingJitterSec", v)} />
                   
                   <div style={{ width: "1px", background: "#333", margin: "0 10px" }} />
                   
                   <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "center" }}>
                     <label style={{ display: "flex", gap: "4px", fontSize: "10px", color: colors.textSecondary }}>
                       <input type="checkbox" checked={editedPreset?.repeat?.doubleStrike?.enabled || false} onChange={e => updateRepeat("doubleStrike", { enabled: e.target.checked })} /> DUAL STRIKE
                     </label>
                     <div style={{ display: "flex", gap: "8px", opacity: editedPreset?.repeat?.doubleStrike?.enabled ? 1 : 0.3 }}>
                       <Knob label="DELAY" value={editedPreset?.repeat?.doubleStrike?.delaySec || 0.1} min={0.01} max={1} step={0.01} color={colors.accentAmber} onChange={(v: number) => updateRepeat("doubleStrike", { delaySec: v })} />
                       <Knob label="GAIN" value={editedPreset?.repeat?.doubleStrike?.gain || 0.5} min={0} max={1} step={0.01} color={colors.accentAmber} onChange={(v: number) => updateRepeat("doubleStrike", { gain: v })} />
                     </div>
                   </div>
                 </div>
              </div>

            </div>

            {/* CHANNEL STRIPS (Generators) */}
            <div style={{ display: "flex", gap: "12px", overflowX: "auto", paddingBottom: "10px" }}>
              
              {/* NOISE BURST (IMPACT) CHANNEL */}
              <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "16px", background: "linear-gradient(180deg, #1a1515 0%, #120d0d 100%)", borderRadius: "8px", border: "1px solid #422", minWidth: "160px", alignItems: "center" }}>
                <h3 style={{ margin: 0, fontSize: "12px", color: "#f44", borderBottom: `1px solid #f44`, paddingBottom: "4px", width: "100%", textAlign: "center" }}>IMPACT (NOISE)</h3>
                <label style={{ display: "flex", gap: "4px", fontSize: "11px", color: colors.textSecondary, width: "100%", justifyContent: "space-between" }}>
                  TYPE:
                  <select value={editedPreset?.noiseBurst?.type || "pink"} onChange={e => updateNoiseBurst("type", e.target.value)} style={{ ...inputStyle, width: "70px", fontSize: "11px", padding: "2px" }}>
                    <option value="white">WHITE</option>
                    <option value="pink">PINK</option>
                    <option value="brown">BROWN</option>
                  </select>
                </label>
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
                  <Knob label="ATTACK" value={editedPreset?.noiseBurst?.attackSec || 0.01} min={0} max={1} step={0.01} color="#f44" onChange={(v: number) => updateNoiseBurst("attackSec", v)} />
                  <Knob label="DECAY" value={editedPreset?.noiseBurst?.decaySec || 0.5} min={0.1} max={5} step={0.1} color="#f44" onChange={(v: number) => updateNoiseBurst("decaySec", v)} />
                  <Knob label="FILTER" value={editedPreset?.noiseBurst?.bandpassHz || 1000} min={100} max={10000} step={100} color="#f44" onChange={(v: number) => updateNoiseBurst("bandpassHz", v)} />
                </div>
                <VerticalFader label="IMPACT GAIN" value={editedPreset?.noiseBurst?.gain || 0} min={0} max={2} step={0.01} unit="" color="#f44" height={100} onChange={(v: number) => updateNoiseBurst("gain", v)} />
              </div>

              {/* HARMONIC CHANNELS */}
              {editedPreset?.harmonics.map((h, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "16px", background: "linear-gradient(180deg, #151a20 0%, #0d1214 100%)", borderRadius: "8px", border: "1px solid #234", minWidth: "180px", alignItems: "center" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", width: "100%", borderBottom: `1px solid ${colors.accentCyan}`, paddingBottom: "4px", alignItems: "baseline" }}>
                     <h3 style={{ margin: 0, fontSize: "13px", color: colors.accentCyan }}>CH {i+1}</h3>
                     <span style={{ fontSize: "12px", color: colors.accent, fontWeight: "bold" }}>{h.absoluteHz ? h.absoluteHz : (testHz * h.multiple).toFixed(1)} Hz</span>
                     <button onClick={() => removeHarmonic(i)} style={{ background: "transparent", border: "none", color: "#f44", cursor: "pointer", fontSize: "12px" }}>✕</button>
                  </div>
                  
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%" }}>
                    <label style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: colors.textSecondary }}>
                      MULT: <input type="number" step="0.01" value={h.multiple} onChange={e => updateHarmonic(i, "multiple", e.target.value)} style={{ ...inputStyle, width: "65px", fontSize: "11px", padding: "2px" }} />
                    </label>
                    <label style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: colors.textSecondary }}>
                      ABS HZ: <input type="number" step="1" value={h.absoluteHz || 0} onChange={e => updateHarmonic(i, "absoluteHz", e.target.value)} style={{ ...inputStyle, width: "65px", fontSize: "11px", padding: "2px" }} />
                    </label>
                  </div>

                  {/* ADSR & Detune Knobs */}
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
                    <Knob label="ATK" value={h.attackSec ?? editedPreset.attackSec} min={0} max={5} step={0.01} color={colors.accentCyan} onChange={(v: number) => updateHarmonic(i, "attackSec", v)} />
                    <Knob label="REL" value={h.releaseSec ?? editedPreset.releaseSec} min={0.1} max={10} step={0.1} color={colors.accentCyan} onChange={(v: number) => updateHarmonic(i, "releaseSec", v)} />
                    <Knob label="DETUNE" value={h.detuneCentsRange || 0} min={0} max={100} step={1} color={colors.accentCyan} onChange={(v: number) => updateHarmonic(i, "detuneCentsRange", v)} />
                    <Knob label="PAN" value={h.pan || 0} min={-1} max={1} step={0.01} color={colors.accentCyan} onChange={(v: number) => updateHarmonic(i, "pan", v)} />
                  </div>

                  {/* Dual Faders */}
                  <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                    <VerticalFader label="L GAIN" value={h.gainL ?? h.gainRatio} min={0} max={1} step={0.01} unit="" color={colors.accentCyan} height={100} onChange={(v: number) => updateHarmonic(i, "gainL", v)} />
                    <VerticalFader label="R GAIN" value={h.gainR ?? h.gainRatio} min={0} max={1} step={0.01} unit="" color={colors.accentCyan} height={100} onChange={(v: number) => updateHarmonic(i, "gainR", v)} />
                  </div>
                </div>
              ))}
              
              {/* ADD CHANNEL BUTTON */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", minWidth: "60px", border: "1px dashed #345", borderRadius: "8px", cursor: "pointer" }} onClick={addHarmonic}>
                <span style={{ color: colors.accentCyan, fontSize: "24px" }}>+</span>
              </div>
            </div>

            {/* Action Bar */}
            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end", marginTop: "10px" }}>
               <button onClick={saveAsCustom} style={buttonStyle(false, colors.accentCyan)}>SAVE PRESET</button>
               <button onClick={updateCustomPreset} style={buttonStyle(true, colors.accent)}>OVERWRITE</button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
