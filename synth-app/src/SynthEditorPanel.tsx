"use client";

import { useState, useEffect } from "react";
import {
  playFrequency, stopFrequency, isAudioSupported, PRESETS,
  startSequence, stopSequence, isSequencePlaying, stopAllSequences, updateSequencePreset,
  SYSTEM_CATEGORIES, clearAudioCache
} from "./frequency-synth";
import type { SynthPreset, Harmonic, NoiseBurst, ReverbConfig } from "./frequency-synth";
import AnalogNeedleGauge from "./AnalogNeedleGauge";

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

  const customGroups = Array.from(new Set(
    Object.keys(customPresets)
      .map(k => customPresets[k].groupId || "Без группы")
  )).sort();

  const [activePresetKey, setActivePresetKey] = useState<string>(presetKeys[0] || "");
  const [playingIds, setPlayingIds] = useState<Set<string>>(new Set());
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const [testHz, setTestHz] = useState<number>(136.1);
  const [testLoop, setTestLoop] = useState<boolean>(false);
  const [testDuration, setTestDuration] = useState<number>(4.0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => { setSupported(isAudioSupported()); }, []);

  const [editedPreset, setEditedPreset] = useState<SynthPreset | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>("");

  const toggleGroup = (group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

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

  const deleteCustom = (key: string) => {
    const updated = { ...customPresets };
    delete updated[key];
    setCustomPresets(updated);
    saveCustomPresets(updated);
    if (activePresetKey === key) setActivePresetKey(presetKeys[0] ?? "");
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

  const applyTemplate = (templateKey: string) => {
    if (!editedPreset || !templateKey) return;
    const template = PRESETS[templateKey];
    if (!template) return;
    const newPreset = {
      ...editedPreset,
      waveform: template.waveform,
      harmonics: JSON.parse(JSON.stringify(template.harmonics)),
      auxTones: template.auxTones ? JSON.parse(JSON.stringify(template.auxTones)) : undefined,
      attackSec: template.attackSec,
      decaySec: template.decaySec,
      sustainRatio: template.sustainRatio,
      releaseSec: template.releaseSec,
      masterVolume: template.masterVolume ?? 1.0,
      highpassHz: template.highpassHz ?? undefined,
      lowpassHz: template.lowpassHz ?? undefined,
      stereoSpread: template.stereoSpread ?? 0,
      reverb: template.reverb ? JSON.parse(JSON.stringify(template.reverb)) : undefined,
      noiseBurst: template.noiseBurst ? JSON.parse(JSON.stringify(template.noiseBurst)) : undefined,
      repeat: template.repeat ? JSON.parse(JSON.stringify(template.repeat)) : undefined,
    };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
    setSelectedTemplateKey(templateKey);
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

  const updateGlobal = (field: keyof SynthPreset, value: any) => {
    if (!editedPreset) return;
    const newPreset = { ...editedPreset };
    if (value === "" || value === undefined) delete newPreset[field];
    else newPreset[field] = value as never;
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateHarmonic = (index: number, field: keyof Harmonic, value: any) => {
    if (!editedPreset) return;
    const newHarmonics = [...editedPreset.harmonics];
    newHarmonics[index] = { ...newHarmonics[index], [field]: typeof value === "number" ? value : Number(value) };
    const newPreset = { ...editedPreset, harmonics: newHarmonics };
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
    text: "#e0e0e0",
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
      <div style={{ maxWidth: "1400px", margin: "0 auto", display: "grid", gridTemplateColumns: "350px 1fr", gap: "24px" }}>
        
        {/* Sidebar: Presets */}
        <div style={{ background: colors.panel, padding: "20px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "20px" }}>
          <h2 style={{ fontSize: "18px", color: colors.accent, borderBottom: `1px solid ${colors.border}`, paddingBottom: "10px", margin: 0 }}>INSTRUMENT RACK</h2>
          
          <div style={{ display: "flex", gap: "4px" }}>
            <button onClick={() => setActiveGlobalTab("default")} style={buttonStyle(activeGlobalTab === "default", colors.accentCyan)}>FACTORY</button>
            <button onClick={() => setActiveGlobalTab("custom")} style={buttonStyle(activeGlobalTab === "custom", colors.accent)}>USER</button>
            <button onClick={() => setActiveGlobalTab("systems")} style={buttonStyle(activeGlobalTab === "systems", colors.accentCyan)}>SYSTEM</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px", maxHeight: "70vh", overflowY: "auto", paddingRight: "5px" }}>
            {filteredPresetKeys.map(renderPresetCard)}
          </div>

          <button onClick={stopAll} style={{ ...buttonStyle(true, "#ff0000"), width: "100%", marginTop: "auto" }}>EMERGENCY STOP</button>
        </div>

        {/* Main: Editor */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          
          {/* Top Bar: Visual Feedback */}
          <div style={{ background: colors.panel, padding: "24px", border: `1px solid ${colors.border}`, borderRadius: "12px", display: "flex", justifyContent: "space-around", alignItems: "center" }}>
            <AnalogNeedleGauge label="MASTER VOL" value={(volumes[activePresetKey] ?? 1) * 100} unit="%" color={colors.accent} />
            
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "24px", color: colors.accentCyan, fontWeight: "bold", textShadow: "0 0 10px rgba(5, 217, 232, 0.5)" }}>
                {testHz.toFixed(1)} <span style={{ fontSize: "14px" }}>Hz</span>
              </div>
              <div style={{ fontSize: "10px", color: "#666", marginTop: "4px" }}>ACTIVE FREQUENCY</div>
              <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                <button onClick={handlePlay} style={buttonStyle(isPlaying || isAutoPlaying)}>LIVE TEST</button>
                <button onClick={handleStop} style={buttonStyle(false, "#666")}>OFF</button>
              </div>
            </div>

            <AnalogNeedleGauge label="BASE FREQ" value={testHz} min={0} max={1000} unit="Hz" color={colors.accentCyan} />
          </div>

          {/* Controls Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            
            {/* ADSR & Waveform */}
            <div style={{ background: colors.panel, padding: "20px", border: `1px solid ${colors.border}`, borderRadius: "12px" }}>
              <h3 style={{ fontSize: "14px", color: colors.accentCyan, marginBottom: "20px" }}>OSCILLATOR & ENVELOPE</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px" }}>
                  WAVEFORM
                  <select value={editedPreset?.waveform} onChange={e => updateGlobal("waveform", e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                    <option value="sine">SINE</option>
                    <option value="triangle">TRIANGLE</option>
                    <option value="sawtooth">SAWTOOTH</option>
                    <option value="square">SQUARE</option>
                  </select>
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px", flex: 1 }}>
                    ATTACK
                    <input type="number" step="0.01" value={editedPreset?.attackSec} onChange={e => updateGlobal("attackSec", Number(e.target.value))} style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px", flex: 1 }}>
                    RELEASE
                    <input type="number" step="0.1" value={editedPreset?.releaseSec} onChange={e => updateGlobal("releaseSec", Number(e.target.value))} style={inputStyle} />
                  </label>
                </div>
              </div>
            </div>

            {/* Effects */}
            <div style={{ background: colors.panel, padding: "20px", border: `1px solid ${colors.border}`, borderRadius: "12px" }}>
              <h3 style={{ fontSize: "14px", color: colors.accentCyan, marginBottom: "20px" }}>SPATIAL & FX</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px" }}>
                  PAN TYPE
                  <select value={editedPreset?.pannerType || "stereo"} onChange={e => updateGlobal("pannerType", e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                    <option value="stereo">STEREO</option>
                    <option value="3d">3D SPATIAL</option>
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px" }}>
                  REVERB WET
                  <input type="number" step="0.05" value={editedPreset?.reverb?.wet || 0} onChange={e => updateReverb("wet", Number(e.target.value))} style={inputStyle} />
                </label>
              </div>
            </div>

          </div>

          {/* Harmonics Table (Simplified for Retro) */}
          <div style={{ background: colors.panel, padding: "20px", border: `1px solid ${colors.border}`, borderRadius: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ fontSize: "14px", color: colors.accentCyan, margin: 0 }}>HARMONIC LAYERS</h3>
              <button onClick={() => {}} style={buttonStyle(false, colors.accentCyan)}>+ ADD LAYER</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {editedPreset?.harmonics.map((h, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "30px 1fr 1fr 1fr 1fr 1fr 30px", gap: "10px", alignItems: "center", background: "rgba(255,255,255,0.03)", padding: "8px", borderRadius: "4px" }}>
                  <span style={{ fontSize: "10px", color: colors.accent }}>#{i+1}</span>
                  <label style={{ fontSize: "9px" }}>MULT <input type="number" step="0.01" value={h.multiple} onChange={e => updateHarmonic(i, "multiple", e.target.value)} style={{ ...inputStyle, width: "100%" }} /></label>
                  <label style={{ fontSize: "9px" }}>GAIN <input type="number" step="0.05" value={h.gainRatio} onChange={e => updateHarmonic(i, "gainRatio", e.target.value)} style={{ ...inputStyle, width: "100%" }} /></label>
                  <label style={{ fontSize: "9px" }}>DETUNE <input type="number" step="1" value={h.detuneCentsRange || 0} onChange={e => updateHarmonic(i, "detuneCentsRange", e.target.value)} style={{ ...inputStyle, width: "100%" }} /></label>
                  <label style={{ fontSize: "9px" }}>PAN <input type="number" step="0.1" value={h.pan || 0} onChange={e => updateHarmonic(i, "pan", e.target.value)} style={{ ...inputStyle, width: "100%" }} /></label>
                  <label style={{ fontSize: "9px" }}>WOBBLE <input type="number" step="0.01" value={h.wobbleHz || 0} onChange={e => updateHarmonic(i, "wobbleHz", e.target.value)} style={{ ...inputStyle, width: "100%" }} /></label>
                  <button onClick={() => {}} style={{ background: "transparent", border: "none", color: "#666", cursor: "pointer" }}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Action Bar */}
          <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
             <button onClick={saveAsCustom} style={buttonStyle(false, colors.accentCyan)}>SAVE PRESET</button>
             <button onClick={updateCustomPreset} style={buttonStyle(true, colors.accent)}>OVERWRITE</button>
             <button onClick={() => {}} style={buttonStyle(false, "#666")}>EXPORT CODE</button>
          </div>

        </div>
      </div>
    </div>
  );
}
