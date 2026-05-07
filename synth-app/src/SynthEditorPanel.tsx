"use client";

import { useState, useEffect } from "react";
import {
  playFrequency, stopFrequency, isAudioSupported, PRESETS,
  startSequence, stopSequence, isSequencePlaying, stopAllSequences, updateSequencePreset,
  SYSTEM_CATEGORIES, clearAudioCache
} from "./frequency-synth";
import type { SynthPreset, Harmonic, NoiseBurst, ReverbConfig } from "./frequency-synth";

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

  // When switching preset, sync testHz from preset.baseHz
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

  // Live-update: when editor params change and the active preset is playing, restart it
  useEffect(() => {
    if (!editedPreset) return;
    if (playingIds.has(activePresetKey) && isSequencePlaying(activePresetKey)) {
      updateSequencePreset(activePresetKey, { ...editedPreset, masterVolume: volumes[activePresetKey] ?? editedPreset.masterVolume ?? 1.0 }, testHz);
    }
  }, [editedPreset, testHz]);

  // Per-card play toggle — use playingIds (React state) as source of truth to avoid engine/state divergence
  const toggleCard = (key: string) => {
    const p = allPresets[key];
    if (!p) return;
    if (playingIds.has(key)) {
      // Always stop: safe even if engine already cleaned up
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
    // if already playing, restart with new volume
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

  // Save current edited preset as custom
  const saveAsCustom = () => {
    if (!editedPreset) return;
    const name = prompt("Название нового пресета:", editedPreset.name ?? activePresetKey + "_copy");
    if (!name) return;
    
    const groupMsg = customGroups.length > 0 
      ? `Назовите папку (группу) для сохранения.\nВаши текущие папки: ${customGroups.join(", ")}`
      : "Назовите новую папку (группу) для сохранения:";
    
    const group = prompt(groupMsg, editedPreset.groupId || "");
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

  const renameCustom = (key: string) => {
    if (!renameVal.trim()) return;
    const newKey = renameVal.trim().toLowerCase().replace(/\s+/g, "_");
    const preset = customPresets[key];
    if (!preset) return;
    const updated = { ...customPresets };
    delete updated[key];
    updated[newKey] = { ...preset, name: renameVal.trim() };
    setCustomPresets(updated);
    saveCustomPresets(updated);
    setRenaming(null);
    if (activePresetKey === key) setActivePresetKey(newKey);
  };

  const updateCustomPreset = () => {
    if (!editedPreset) return;
    let finalPreset = { ...editedPreset };
    
    // For system presets, always preserve the original frequency when updating/overriding
    const systemOrig = PRESETS[activePresetKey];
    if (systemOrig && systemOrig.baseHz) {
      finalPreset.baseHz = systemOrig.baseHz;
    }

    const updated = { ...customPresets, [activePresetKey]: finalPreset };
    setCustomPresets(updated);
    saveCustomPresets(updated);
  };

  const applyTemplate = (templateKey: string) => {
    if (!editedPreset || !templateKey) return;
    const template = PRESETS[templateKey];
    if (!template) return;
    
    // Apply structural settings but keep identity
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
      waveform: editedPreset.waveform,
      harmonics: editedPreset.harmonics,
      auxTones: editedPreset.auxTones,
      attackSec: editedPreset.attackSec,
      decaySec: editedPreset.decaySec,
      sustainRatio: editedPreset.sustainRatio,
      releaseSec: editedPreset.releaseSec,
      lowpassHz: editedPreset.lowpassHz,
      highpassHz: editedPreset.highpassHz,
      stereoSpread: editedPreset.stereoSpread,
      noiseBurst: editedPreset.noiseBurst,
      reverb: editedPreset.reverb,
      loop: testLoop,
      durationSec: testDuration,
      preset: undefined
    });
    
    if (success) {
      setIsPlaying(true);
    }
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
        playFrequency(testHz, { 
          ...newPreset,
          loop: testLoop,
          durationSec: testDuration,
          preset: undefined
        });
      }, 50);
    } else if (isAutoPlaying) {
      updateSequencePreset("__test_seq__", newPreset, testHz);
    }
  };

  const updateGlobal = (field: keyof SynthPreset, value: any) => {
    if (!editedPreset) return;
    const newPreset = { ...editedPreset };
    if (value === "" || value === undefined) {
      delete newPreset[field];
    } else {
      newPreset[field] = value as never;
    }
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateRepeat = (field: string, value: any, isDoubleStrike = false) => {
    if (!editedPreset) return;
    let newRepeat = editedPreset.repeat ? JSON.parse(JSON.stringify(editedPreset.repeat)) : { enabled: true, intervalSec: 5 };
    
    if (isDoubleStrike) {
      newRepeat.doubleStrike = newRepeat.doubleStrike || { enabled: false, delaySec: 0.1, gain: 0.5 };
      if (value === undefined) delete newRepeat.doubleStrike[field];
      else newRepeat.doubleStrike[field] = value;
    } else {
      if (value === undefined) delete newRepeat[field];
      else newRepeat[field] = value;
    }
    
    const newPreset = { ...editedPreset, repeat: newRepeat };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateHarmonic = (index: number, field: keyof Harmonic, value: any) => {
    if (!editedPreset) return;
    const newHarmonics = [...editedPreset.harmonics];
    if (value === "") {
      delete newHarmonics[index][field];
    } else {
      newHarmonics[index] = { ...newHarmonics[index], [field]: typeof value === "number" ? value : Number(value) };
    }
    const newPreset = { ...editedPreset, harmonics: newHarmonics };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const addHarmonic = () => {
    if (!editedPreset) return;
    const newHarmonics = [...editedPreset.harmonics, { multiple: 2.0, gainRatio: 0.5, decaySec: 2.0, sustainRatio: 0 }];
    setEditedPreset({ ...editedPreset, harmonics: newHarmonics });
  };

  const removeHarmonic = (index: number) => {
    if (!editedPreset) return;
    const newHarmonics = editedPreset.harmonics.filter((_, i) => i !== index);
    setEditedPreset({ ...editedPreset, harmonics: newHarmonics });
  };

  const updateAuxTone = (index: number, field: keyof Harmonic, value: any) => {
    if (!editedPreset) return;
    const currentAux = editedPreset.auxTones || [];
    const newAux = [...currentAux];
    if (value === "") {
      delete newAux[index][field];
    } else {
      newAux[index] = { ...newAux[index], [field]: typeof value === "number" ? value : Number(value) };
    }
    const newPreset = { ...editedPreset, auxTones: newAux };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const addAuxTone = () => {
    if (!editedPreset) return;
    const currentAux = editedPreset.auxTones || [];
    const newAux = [...currentAux, { multiple: 0.5, gainRatio: 0.5, decaySec: 2.0, sustainRatio: 0 }];
    setEditedPreset({ ...editedPreset, auxTones: newAux });
  };

  const removeAuxTone = (index: number) => {
    if (!editedPreset) return;
    const currentAux = editedPreset.auxTones || [];
    const newAux = currentAux.filter((_, i) => i !== index);
    setEditedPreset({ ...editedPreset, auxTones: newAux });
  };

  const updateNoise = (field: keyof NoiseBurst, value: any) => {
    if (!editedPreset) return;
    let newNoise: NoiseBurst = editedPreset.noiseBurst ? { ...editedPreset.noiseBurst } : { type: "pink", attackSec: 0.01, decaySec: 0.05, bandpassHz: 4000, gain: 0 };
    if (value === "") {
      delete newNoise[field as keyof NoiseBurst];
    } else {
      (newNoise as any)[field] = value;
    }
    const newPreset = { ...editedPreset, noiseBurst: newNoise };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const updateReverb = (field: keyof ReverbConfig, value: any) => {
    if (!editedPreset) return;
    let newReverb: ReverbConfig = editedPreset.reverb ? { ...editedPreset.reverb } : { wet: 0, decaySec: 4.0, preDelayMs: 20 };
    if (value === "") {
      delete newReverb[field as keyof ReverbConfig];
    } else {
      (newReverb as any)[field] = value;
    }
    const newPreset = { ...editedPreset, reverb: newReverb };
    setEditedPreset(newPreset);
    triggerRestart(newPreset);
  };

  const exportCode = () => {
    if (!editedPreset) return;
    
    // Helper to clear undefineds
    const cleanObj = (obj: any) => JSON.parse(JSON.stringify(obj));
    const cleanPreset = cleanObj(editedPreset);

    const code = `
  ${activePresetKey}: {
    name: "${cleanPreset.name || activePresetKey}",
    ${cleanPreset.baseHz ? `baseHz: ${cleanPreset.baseHz},` : ""}
    ${cleanPreset.systemId ? `systemId: "${cleanPreset.systemId}",` : ""}
    ${cleanPreset.groupId ? `groupId: "${cleanPreset.groupId}",` : ""}
    waveform: "${cleanPreset.waveform}",
    harmonics: ${JSON.stringify(cleanPreset.harmonics, null, 6).replace(/"([^"]+)":/g, '$1:')},
    ${cleanPreset.auxTones && cleanPreset.auxTones.length > 0 ? `auxTones: ${JSON.stringify(cleanPreset.auxTones, null, 6).replace(/"([^"]+)":/g, '$1:')},` : ""}
    attackSec: ${cleanPreset.attackSec},
    ${cleanPreset.decaySec !== undefined ? `decaySec: ${cleanPreset.decaySec},` : ""}
    ${cleanPreset.sustainRatio !== undefined ? `sustainRatio: ${cleanPreset.sustainRatio},` : ""}
    releaseSec: ${cleanPreset.releaseSec},
    ${cleanPreset.highpassHz ? `highpassHz: ${cleanPreset.highpassHz},` : ""}
    ${cleanPreset.lowpassHz ? `lowpassHz: ${cleanPreset.lowpassHz},` : ""}
    ${cleanPreset.stereoSpread ? `stereoSpread: ${cleanPreset.stereoSpread},` : ""}
    ${cleanPreset.noiseBurst ? `noiseBurst: ${JSON.stringify(cleanPreset.noiseBurst).replace(/"([^"]+)":/g, '$1:')},` : ""}
    ${cleanPreset.reverb ? `reverb: ${JSON.stringify(cleanPreset.reverb).replace(/"([^"]+)":/g, '$1:')},` : ""}
    ${cleanPreset.repeat ? `repeat: ${JSON.stringify(cleanPreset.repeat).replace(/"([^"]+)":/g, '$1:')},` : ""}
  },`;
    
    // removing empty lines
    const finalCode = code.replace(/^\s*[\r\n]/gm, '');
    navigator.clipboard.writeText(finalCode);
    alert("Код пресета скопирован! Вы можете вставить его в объект PRESETS в файле frequency-synth.ts");
  };

  if (!supported) {
    return <div style={{ color: "#d73a49", padding: "16px" }}>Ваш браузер не поддерживает Web Audio API.</div>;
  }

  // --- COMPACT LIGHT THEME STYLES ---
  const cardActiveStyle = {
    background: "#ffffff",
    border: "1px solid #0366d6",
    boxShadow: "0 2px 8px rgba(3, 102, 214, 0.15)",
  };
  const cardInactiveStyle = {
    background: "#ffffff",
    border: "1px solid #e1e4e8",
    boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
  };

  const inputStyle = {
    background: "#f6f8fa",
    border: "1px solid #d1d5da",
    color: "#24292e",
    padding: "0 6px",
    borderRadius: "4px",
    width: "100%",
    outline: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: "12px",
    height: "24px",
    transition: "border-color 0.2s",
    boxSizing: "border-box" as const
  };

  const selectStyle = {
    ...inputStyle,
    padding: "0 4px",
  };

  const labelStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
    fontSize: "11px",
    color: "#586069",
    fontWeight: 400,
  };

  const header3Style = {
    fontSize: "14px", 
    color: "#24292e", 
    marginTop: 0, 
    marginBottom: "12px", 
    fontWeight: 500 
  };

  const panelStyle = {
    ...cardInactiveStyle,
    padding: "16px",
    borderRadius: "6px"
  };

  const renderPresetCard = (key: string) => {
    const preset = allPresets[key];
    const isActive = activePresetKey === key;
    const isPlaying = playingIds.has(key);
    const isUserPreset = Object.prototype.hasOwnProperty.call(customPresets, key);
    const vol = volumes[key] ?? 1.0;
    return (
      <div key={key} style={{
        ...(isActive ? cardActiveStyle : cardInactiveStyle),
        ...(isPlaying ? { borderColor: "#28a745", boxShadow: "0 0 0 2px rgba(40,167,69,0.2)" } : {}),
        borderRadius: "6px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "4px",
        transition: "all 0.2s ease", position: "relative"
      }}>
        {/* Name row */}
        {renaming === key ? (
          <div style={{ display: "flex", gap: "4px" }}>
            <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") renameCustom(key); if (e.key === "Escape") setRenaming(null); }}
              style={{ ...inputStyle, flex: 1, fontSize: "12px" }} />
            <button onClick={() => renameCustom(key)} style={{ background: "#0366d6", color: "#fff", border: "none", borderRadius: "3px", cursor: "pointer", fontSize: "11px", padding: "0 6px" }}>✓</button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "4px" }}>
            <span onClick={() => setActivePresetKey(key)} style={{ fontSize: "13px", fontWeight: 500, color: isActive ? "#0366d6" : "#24292e", cursor: "pointer", lineHeight: 1.3, flex: 1 }}>
              {preset.name ?? key}
            </span>
            {isUserPreset && activeGlobalTab === "custom" && (
              <div style={{ display: "flex", gap: "2px", flexShrink: 0 }}>
                <select 
                  value={preset.groupId || ""}
                  onChange={e => {
                    let val = e.target.value;
                    if (val === "__new__") {
                      val = prompt("Название новой папки/группы:") || "";
                      if (!val) return;
                    }
                    const updated = { ...customPresets, [key]: { ...preset, groupId: val } };
                    setCustomPresets(updated);
                    saveCustomPresets(updated);
                  }}
                  style={{ ...selectStyle, width: "60px", fontSize: "9px", height: "18px" }}
                >
                  <option value="">Без гр.</option>
                  {customGroups.filter(g => g !== "Без группы").map(g => <option key={g} value={g}>{g}</option>)}
                  <option value="__new__">+ Нов...</option>
                </select>
                <button onClick={() => { setRenaming(key); setRenameVal(preset.name ?? key); }} title="Переименовать"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#586069", fontSize: "12px", padding: "0 2px" }}>✏️</button>
                <button onClick={() => { if (confirm("Удалить?")) deleteCustom(key); }} title="Удалить"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#d73a49", fontSize: "12px", padding: "0 2px" }}>×</button>
              </div>
            )}
          </div>
        )}
        {/* Hz + editing badge */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span onClick={() => setActivePresetKey(key)} style={{ fontSize: "11px", color: "#586069", cursor: "pointer" }}>
            {preset.baseHz ? `${preset.baseHz} Hz` : `${preset.harmonics?.length ?? 0} слоев`}
          </span>
          {isActive && activeGlobalTab === "custom" && (
            <span style={{ fontSize: "9px", background: "#0366d6", color: "#fff", padding: "1px 5px", borderRadius: "3px", fontWeight: 600, letterSpacing: "0.3px" }}>✎ РЕД</span>
          )}
        </div>
        {/* Volume */}
        <input type="range" min="0" max="1" step="0.05" value={vol}
          onChange={e => setVolume(key, Number(e.target.value))}
          style={{ width: "100%", height: "3px", accentColor: isPlaying ? "#28a745" : "#0366d6", cursor: "pointer" }} />
        {/* Play/Stop */}
        <button onClick={() => toggleCard(key)} style={{
          background: isPlaying ? "#28a745" : "transparent",
          border: `1px solid ${isPlaying ? "#28a745" : "#d1d5da"}`,
          color: isPlaying ? "#fff" : "#24292e",
          borderRadius: "4px", padding: "2px 0", cursor: "pointer", fontSize: "11px",
          fontWeight: 500, transition: "all 0.15s"
        }}>
          {isPlaying ? "⏹ Стоп" : "▶ Играть"}
        </button>
      </div>
    );
  };

  return (
    <div style={{ padding: "16px", background: "#f8f9fa", color: "#24292e", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", minHeight: "100vh" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <div>
            <h2 style={{ fontSize: "20px", fontWeight: 300, color: "#24292e", margin: "0 0 4px 0" }}>
              Визуальный Редактор Синтеза
            </h2>
            <div style={{ color: "#586069", fontSize: "12px" }}>Настройка параметров движка frequency-synth.ts</div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => { clearAudioCache(); alert("Кэш звука очищен!"); }} style={{ background: "transparent", border: "1px solid #d1d5da", color: "#586069", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", transition: "all 0.2s" }}>
              🧹 Очистить кэш
            </button>
            <button onClick={stopAll} style={{ background: "#d73a49", color: "#fff", border: "1px solid #d73a49", padding: "6px 14px", borderRadius: "4px", cursor: "pointer", fontWeight: 500, fontSize: "13px", transition: "all 0.2s" }}>
              ⏹ Остановить всё
            </button>
             <button
              onClick={(isPlaying || isAutoPlaying) ? handleStop : handlePlay}
              style={{
                background: (isPlaying || isAutoPlaying) ? "transparent" : "#0366d6",
                border: "1px solid #0366d6",
                color: (isPlaying || isAutoPlaying) ? "#0366d6" : "#ffffff",
                padding: "6px 16px", borderRadius: "4px", cursor: "pointer",
                fontWeight: 500, fontSize: "13px", transition: "all 0.2s",
                boxShadow: isPlaying ? "none" : "0 1px 3px rgba(3,102,214,0.3)"
              }}
            >
            { (isPlaying || isAutoPlaying) ? "Остановить" : (editedPreset?.repeat?.enabled ? "Тест удара" : "Слушать пресет") }
            </button>
            {!DEFAULT_PRESET_KEYS.has(activePresetKey) && (
              <button onClick={updateCustomPreset} style={{ background: "#28a745", color: "#fff", border: "1px solid #28a745", padding: "6px 14px", borderRadius: "4px", cursor: "pointer", fontWeight: 500, fontSize: "13px", transition: "all 0.2s" }}>
                Обновить
              </button>
            )}
            <button onClick={saveAsCustom} style={{ background: "transparent", border: "1px solid #28a745", color: "#28a745", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "13px", transition: "all 0.2s" }}>
              Сохранить
            </button>
            <button onClick={exportCode} style={{ background: "transparent", border: "1px solid #d1d5da", color: "#24292e", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "13px", transition: "all 0.2s" }}>
              Копировать код
            </button>
          </div>

        </div>

        {/* Global Tabs */}
        <div style={{ display: "flex", gap: "2px", marginBottom: "16px", borderBottom: "1px solid #e1e4e8", paddingBottom: "8px" }}>
          <button 
            onClick={() => setActiveGlobalTab("default")}
            style={{ padding: "8px 16px", background: activeGlobalTab === "default" ? "#0366d6" : "transparent", color: activeGlobalTab === "default" ? "#fff" : "#586069", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 500, transition: "all 0.2s" }}
          >
            Дефолт пресеты
          </button>
          <button 
            onClick={() => setActiveGlobalTab("custom")}
            style={{ padding: "8px 16px", background: activeGlobalTab === "custom" ? "#28a745" : "transparent", color: activeGlobalTab === "custom" ? "#fff" : "#586069", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 500, transition: "all 0.2s" }}
          >
            Мои пресеты
          </button>
          <button 
            onClick={() => setActiveGlobalTab("systems")}
            style={{ padding: "8px 16px", background: activeGlobalTab === "systems" ? "#0366d6" : "transparent", color: activeGlobalTab === "systems" ? "#fff" : "#586069", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 500, transition: "all 0.2s" }}
          >
            Системы частот
          </button>
        </div>

        {/* System Categories List (only visible in "systems" tab) */}
        {activeGlobalTab === "systems" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "24px" }}>
            {SYSTEM_CATEGORIES.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveSystemId(cat.id)}
                style={{
                  padding: "6px 12px",
                  background: activeSystemId === cat.id ? "#e1e4e8" : "#ffffff",
                  border: "1px solid #d1d5da",
                  borderRadius: "20px",
                  fontSize: "12px",
                  cursor: "pointer",
                  color: "#24292e",
                  fontWeight: activeSystemId === cat.id ? 600 : 400
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>
        )}

        {/* Instrument Grid */}
        <div style={{ marginBottom: "24px" }}>
          {activeGlobalTab === "custom" ? (
             Object.keys(customPresets).length === 0 ? (
               <div style={{ color: "#586069", fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>У вас пока нет сохраненных пресетов. Сохраните любой пресет, чтобы он появился здесь.</div>
             ) : (() => {
               const buildGroupTree = (keys: string[]) => {
                 const root: any = { presets: [], subgroups: {} };
                 keys.forEach(key => {
                   const pathStr = customPresets[key].groupId || "Без группы";
                   const parts = pathStr.split("/").map(p => p.trim()).filter(Boolean);
                   let current = root;
                   parts.forEach(part => {
                     if (!current.subgroups[part]) {
                       current.subgroups[part] = { presets: [], subgroups: {} };
                     }
                     current = current.subgroups[part];
                   });
                   current.presets.push(key);
                 });
                 return root;
               };

               const renderNode = (name: string, node: any, path: string = "", depth: number = 0) => {
                 const fullPath = path ? `${path}/${name}` : name;
                 const isCollapsed = collapsedGroups.has(fullPath);
                 // const hasSub = Object.keys(node.subgroups).length > 0;
                 const hasPresets = node.presets.length > 0;
                 
                 return (
                   <div key={fullPath} style={{ marginLeft: depth > 0 ? "16px" : "0", marginBottom: "4px" }}>
                     <div 
                       onClick={() => toggleGroup(fullPath)}
                       style={{ 
                         display: "flex", alignItems: "center", gap: "8px", cursor: "pointer",
                         padding: "4px 10px", background: isCollapsed ? "#f6f8fa" : "#f1f8ff",
                         border: "1px solid", borderColor: isCollapsed ? "#e1e4e8" : "#c8e1ff",
                         borderRadius: "4px", transition: "all 0.15s"
                       }}
                     >
                       <span style={{ fontSize: "9px", color: isCollapsed ? "#6a737d" : "#0366d6", width: "10px" }}>
                         {isCollapsed ? "▶" : "▼"}
                       </span>
                       <span style={{ fontSize: "13px", fontWeight: 600, color: "#24292e" }}>
                         📁 {name}
                       </span>
                       <span style={{ fontSize: "11px", color: "#6a737d", marginLeft: "auto" }}>
                         {node.presets.length + Object.values(node.subgroups).reduce((acc: number, n: any) => acc + n.presets.length, 0)} прес.
                       </span>
                     </div>
                     
                     {!isCollapsed && (
                       <div style={{ borderLeft: "1px solid #e1e4e8", paddingLeft: "8px", marginTop: "4px" }}>
                         {Object.keys(node.subgroups).sort().map(sub => renderNode(sub, node.subgroups[sub], fullPath, depth + 1))}
                         {hasPresets && (
                           <div style={{ 
                             display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", 
                             gap: "8px", paddingTop: "8px", paddingBottom: "8px"
                           }}>
                             {node.presets.map((key: string) => renderPresetCard(key))}
                           </div>
                         )}
                       </div>
                     )}
                   </div>
                 );
               };

               const tree = buildGroupTree(Object.keys(customPresets));
               return Object.keys(tree.subgroups).sort().map(name => renderNode(name, tree.subgroups[name]));
             })()
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "8px" }}>
              {filteredPresetKeys.map(key => renderPresetCard(key))}
            </div>
          )}
        </div>

        {editedPreset && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Editor identity bar */}
            <div style={{ background: "#f1f8ff", border: "1px solid #c8e1ff", borderRadius: "6px", padding: "8px 14px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "11px", color: "#586069", fontWeight: 500 }}>РЕДАКТИРОВАНИЕ:</span>
              <span style={{ fontSize: "14px", fontWeight: 600, color: "#0366d6" }}>{editedPreset.name ?? activePresetKey}</span>
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#586069" }}>База:</span>
                <input 
                  type="number" 
                  step="0.1" 
                  value={editedPreset.baseHz || ""} 
                  onChange={e => {
                    const val = Number(e.target.value);
                    updateGlobal("baseHz", val);
                    setTestHz(val); // Sync test frequency too
                  }} 
                  style={{ ...inputStyle, width: "60px", height: "20px" }} 
                />
                <span style={{ fontSize: "12px", color: "#586069" }}>Hz</span>
              </div>
              
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "11px", color: "#586069" }}>Взять образец (Шаблон):</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                    <select 
                      value={selectedTemplateKey}
                      onChange={e => applyTemplate(e.target.value)}
                      style={{ ...selectStyle, width: "auto", minWidth: "150px", borderColor: "#0366d6" }}
                    >
                      <option value="">-- Выберите образец --</option>
                      {ORIGINAL_KEYS.map(key => (
                        <option key={key} value={key}>{PRESETS[key].name}</option>
                      ))}
                    </select>
                    {selectedTemplateKey && (
                      <button 
                        onClick={() => applyTemplate(selectedTemplateKey)}
                        title="Переприменить/Обновить из файла"
                        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "14px", padding: "0 4px" }}
                      >
                        🔄
                      </button>
                    )}
                  </div>
                </div>

                <button 
                  onClick={(isPlaying || isAutoPlaying) ? handleStop : handlePlay}
                  style={{ 
                    background: (isPlaying || isAutoPlaying) ? "#d73a49" : "#28a745", 
                    color: "#fff", border: "none", padding: "6px 16px", 
                    borderRadius: "4px", cursor: "pointer", fontWeight: 600, fontSize: "13px",
                    display: "flex", alignItems: "center", gap: "6px", boxShadow: "0 2px 4px rgba(40,167,69,0.3)"
                  }}
                >
                  <span style={{ fontSize: "16px" }}>{(isPlaying || isAutoPlaying) ? "⏹" : "▶"}</span> 
                  {(isPlaying || isAutoPlaying) ? "Остановить" : "Прослушать"}
                </button>

                <button 
                  onClick={updateCustomPreset} 
                  style={{ 
                    background: "#28a745", color: "#fff", border: "none", padding: "6px 14px", 
                    borderRadius: "4px", cursor: "pointer", fontWeight: 600, fontSize: "13px",
                    boxShadow: "0 2px 4px rgba(40,167,69,0.2)"
                  }}
                >
                  Обновить
                </button>
                
                <button 
                  onClick={saveAsCustom} 
                  style={{ 
                    background: "transparent", border: "1px solid #28a745", color: "#28a745", 
                    padding: "6px 16px", borderRadius: "4px", cursor: "pointer", 
                    fontSize: "13px", fontWeight: 600
                  }}
                >
                  Сохранить
                </button>
              </div>

              {playingIds.has(activePresetKey) && (
                <span style={{ fontSize: "11px", background: "#e1f5fe", color: "#0288d1", padding: "2px 8px", borderRadius: "4px", border: "1px solid #b3e5fc" }}>
                  ● Живой эфир
                </span>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              {/* Global ADSR & Testing */}
              <div style={panelStyle}>
                 <h3 style={header3Style}>Глобальная огибающая & Тест</h3>
                 
                 <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", paddingBottom: "16px", marginBottom: "16px", borderBottom: "1px solid #e1e4e8" }}>
                    <label style={labelStyle}>Частота теста (Hz)
                      <input type="number" step="0.1" value={testHz} onChange={e => setTestHz(Number(e.target.value))} style={inputStyle} />
                    </label>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <label style={{...labelStyle, flexDirection: "row", alignItems: "center", gap: "8px", marginTop: "16px"}}>
                        <input type="checkbox" checked={testLoop} disabled={editedPreset.repeat?.enabled} onChange={e => setTestLoop(e.target.checked)} style={{ margin: 0 }} />
                        Loop
                      </label>
                      <label style={{ ...labelStyle, opacity: (testLoop && !editedPreset.repeat?.enabled) ? 0.4 : 1 }}>Длительность
                        <input type="number" step="0.5" value={testDuration} disabled={testLoop && !editedPreset.repeat?.enabled} onChange={e => setTestDuration(Number(e.target.value))} style={inputStyle} />
                      </label>
                    </div>
                 </div>

                 <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "12px" }}>
                    <label style={labelStyle}>Волна
                      <select value={editedPreset.waveform} onChange={e => updateGlobal("waveform", e.target.value)} style={selectStyle}>
                        <option value="sine">Sine</option>
                        <option value="triangle">Tri</option>
                        <option value="sawtooth">Saw</option>
                        <option value="square">Sqr</option>
                      </select>
                    </label>
                    <label style={labelStyle}>Attack (с)
                      <input type="number" step="0.01" value={editedPreset.attackSec} onChange={e => updateGlobal("attackSec", Number(e.target.value))} style={inputStyle} />
                    </label>
                    <label style={labelStyle}>Decay (с)
                      <input type="number" step="0.1" placeholder="Выкл" value={editedPreset.decaySec ?? ""} onChange={e => updateGlobal("decaySec", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                    </label>
                    <label style={labelStyle}>Sustain
                      <input type="number" step="0.1" placeholder="1.0" value={editedPreset.sustainRatio ?? ""} onChange={e => updateGlobal("sustainRatio", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                    </label>
                    <label style={labelStyle}>Release (с)
                      <input type="number" step="0.1" value={editedPreset.releaseSec} onChange={e => updateGlobal("releaseSec", Number(e.target.value))} style={inputStyle} />
                    </label>
                 </div>
              </div>

              {/* Effects & Space */}
              <div style={{ ...panelStyle, display: "flex", flexDirection: "column", gap: "16px" }}>
                 
                 <div>
                   <h3 style={header3Style}>Фильтры и Панорама</h3>
                   <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                      <label style={labelStyle}>Highpass Hz
                        <input type="number" placeholder="Выкл" value={editedPreset.highpassHz || ""} onChange={e => updateGlobal("highpassHz", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                      </label>
                      <label style={labelStyle}>Lowpass Hz
                        <input type="number" placeholder="Выкл" value={editedPreset.lowpassHz || ""} onChange={e => updateGlobal("lowpassHz", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                      </label>
                      <label style={labelStyle}>Стерео-спред
                        <input type="number" step="0.1" placeholder="0" value={editedPreset.stereoSpread || ""} onChange={e => updateGlobal("stereoSpread", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                      </label>
                   </div>
                   <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
                      <label style={labelStyle}>Тип панорамы
                        <select value={editedPreset.pannerType || "stereo"} onChange={e => updateGlobal("pannerType", e.target.value)} style={selectStyle}>
                          <option value="stereo">Standard Stereo</option>
                          <option value="3d">3D Spatial (HRTF)</option>
                        </select>
                      </label>
                      <label style={labelStyle}>3D Вращение (Hz)
                        <input type="number" step="0.01" placeholder="Выкл" value={editedPreset.spatialRotationHz || ""} onChange={e => updateGlobal("spatialRotationHz", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                      </label>
                   </div>
                 </div>

                 <div style={{ borderTop: "1px solid #e1e4e8", paddingTop: "16px" }}>
                   <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                     <h3 style={{...header3Style, margin: 0}}>Реверберация (Plate)</h3>
                     {editedPreset.reverb 
                       ? <button onClick={() => updateGlobal("reverb", undefined)} style={{ background: "transparent", color: "#d73a49", border: "none", cursor: "pointer", fontSize: "11px" }}>Выключить</button>
                       : <button onClick={() => updateGlobal("reverb", { wet: 0.3, decaySec: 4.0, preDelayMs: 20 })} style={{ background: "transparent", color: "#0366d6", border: "none", cursor: "pointer", fontSize: "11px" }}>Включить</button>
                     }
                   </div>
                   {editedPreset.reverb && (
                     <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                        <label style={labelStyle}>Wet (0..1)
                          <input type="number" step="0.05" placeholder="0.3" value={editedPreset.reverb.wet ?? ""} onChange={e => updateReverb("wet", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                        </label>
                        <label style={labelStyle}>Decay (с)
                          <input type="number" step="0.5" placeholder="4" value={editedPreset.reverb.decaySec ?? ""} onChange={e => updateReverb("decaySec", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                        </label>
                        <label style={labelStyle}>Pre-delay (мс)
                          <input type="number" step="5" placeholder="20" value={editedPreset.reverb.preDelayMs ?? ""} onChange={e => updateReverb("preDelayMs", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                        </label>
                     </div>
                   )}
                  </div>

               </div>
            </div>

            {/* Repeat / Sequencer */}
            <div style={{ ...panelStyle, background: editedPreset.repeat?.enabled ? "#f0f8ff" : "#ffffff", borderColor: editedPreset.repeat?.enabled ? "#c8e1ff" : "#e1e4e8" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: editedPreset.repeat?.enabled ? "12px" : "0" }}>
                <h3 style={{...header3Style, margin: 0, color: editedPreset.repeat?.enabled ? "#0366d6" : "#24292e"}}>Генератор секвенций (Медитация)</h3>
                {editedPreset.repeat?.enabled 
                  ? <button onClick={() => updateGlobal("repeat", undefined)} style={{ background: "transparent", color: "#d73a49", border: "none", cursor: "pointer", fontSize: "11px" }}>Выключить</button>
                  : <button onClick={() => updateGlobal("repeat", { enabled: true, intervalSec: 5, timingJitterSec: 0.25, gainJitter: 0.08, alternatePan: true, doubleStrike: { enabled: true, delaySec: 0.12, gain: 0.55 } })} style={{ background: "transparent", color: "#0366d6", border: "none", cursor: "pointer", fontSize: "11px" }}>Включить</button>
                }
              </div>
              {editedPreset.repeat?.enabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "12px" }}>
                      <label style={labelStyle}>Интервал (с)
                        <input type="number" step="0.5" value={editedPreset.repeat.intervalSec} onChange={e => updateRepeat("intervalSec", Number(e.target.value))} style={inputStyle} />
                      </label>
                      <label style={labelStyle}>Jitter вр. (с)
                        <input type="number" step="0.05" value={editedPreset.repeat.timingJitterSec ?? ""} onChange={e => updateRepeat("timingJitterSec", e.target.value ? Number(e.target.value) : undefined)} style={inputStyle} />
                      </label>
                      <label style={labelStyle}>Jitter гром. (0-1)
                        <input type="number" step="0.01" value={editedPreset.repeat.gainJitter ?? ""} onChange={e => updateRepeat("gainJitter", e.target.value ? Number(e.target.value) : undefined)} style={inputStyle} />
                      </label>
                      <label style={{...labelStyle, flexDirection: "row", alignItems: "center", gap: "8px", marginTop: "16px"}}>
                        <input type="checkbox" checked={editedPreset.repeat.alternatePan ?? false} onChange={e => updateRepeat("alternatePan", e.target.checked)} style={{ margin: 0 }} />
                        Чередовать Pan
                      </label>
                  </div>
                  
                  <div style={{ borderTop: "1px solid #c8e1ff", paddingTop: "12px" }}>
                    <label style={{...labelStyle, flexDirection: "row", alignItems: "center", gap: "8px", marginBottom: "8px"}}>
                      <input type="checkbox" checked={editedPreset.repeat.doubleStrike?.enabled ?? false} onChange={e => updateRepeat("enabled", e.target.checked, true)} style={{ margin: 0 }} />
                      <span style={{ fontWeight: 500 }}>Двойной удар (Tingsha)</span>
                    </label>
                    {editedPreset.repeat.doubleStrike?.enabled && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", marginLeft: "24px" }}>
                        <label style={labelStyle}>Задержка (с)
                          <input type="number" step="0.01" value={editedPreset.repeat.doubleStrike.delaySec} onChange={e => updateRepeat("delaySec", Number(e.target.value), true)} style={inputStyle} />
                        </label>
                        <label style={labelStyle}>Уровень (Gain)
                          <input type="number" step="0.05" value={editedPreset.repeat.doubleStrike.gain} onChange={e => updateRepeat("gain", Number(e.target.value), true)} style={inputStyle} />
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Noise Burst */}
            <div style={panelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: editedPreset.noiseBurst ? "12px" : "0" }}>
                <h3 style={{...header3Style, margin: 0}}>Удар / Transient (Noise Burst)</h3>
                {editedPreset.noiseBurst 
                  ? <button onClick={() => updateGlobal("noiseBurst", undefined)} style={{ background: "transparent", color: "#d73a49", border: "none", cursor: "pointer", fontSize: "11px" }}>Выключить</button>
                  : <button onClick={() => updateGlobal("noiseBurst", { type: "pink", attackSec: 0.01, decaySec: 0.05, bandpassHz: 4000, gain: 0.05 })} style={{ background: "transparent", color: "#0366d6", border: "none", cursor: "pointer", fontSize: "11px" }}>Включить</button>
                }
              </div>
              {editedPreset.noiseBurst && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "12px" }}>
                    <label style={labelStyle}>Тип шума
                      <select value={editedPreset.noiseBurst.type || "pink"} onChange={e => updateNoise("type", e.target.value)} style={selectStyle}>
                        <option value="pink">Pink</option>
                        <option value="white">White</option>
                      </select>
                    </label>
                    <label style={labelStyle}>Атака (с)
                      <input type="number" step="0.001" placeholder="0.001" value={editedPreset.noiseBurst.attackSec ?? ""} onChange={e => updateNoise("attackSec", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                    </label>
                    <label style={labelStyle}>Decay (с)
                      <input type="number" step="0.01" placeholder="0.05" value={editedPreset.noiseBurst.decaySec ?? ""} onChange={e => updateNoise("decaySec", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                    </label>
                    <label style={labelStyle}>Bandpass Hz
                      <input type="number" step="100" placeholder="4000" value={editedPreset.noiseBurst.bandpassHz ?? ""} onChange={e => updateNoise("bandpassHz", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                    </label>
                    <label style={labelStyle}>Gain
                      <input type="number" step="0.01" placeholder="0.05" value={editedPreset.noiseBurst.gain ?? ""} onChange={e => updateNoise("gain", e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
                    </label>
                </div>
              )}
            </div>

            {/* Harmonics Grid */}
            <div style={panelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <h3 style={{...header3Style, margin: 0}}>Основные Гармоники</h3>
                <button 
                  onClick={addHarmonic}
                  style={{ background: "#f6f8fa", color: "#24292e", border: "1px solid #d1d5da", padding: "4px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", transition: "background 0.2s" }}
                >
                  + Добавить
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {editedPreset.harmonics.map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: "8px", alignItems: "end", background: "#f6f8fa", padding: "6px 8px", borderRadius: "4px", border: "1px solid #e1e4e8" }}>
                     <div style={{ width: "36px", color: "#6a737d", paddingBottom: "4px", fontSize: "10px", fontWeight: 500, lineHeight: 1.3, flexShrink: 0 }}>
                       <div>#{i+1}</div>
                       <div style={{ color: "#0366d6", fontWeight: 600 }}>{(testHz * h.multiple).toFixed(1)}</div>
                     </div>
                    
                    <label style={{...labelStyle, flex: 0.6}}>Mult<input type="number" step="0.01" value={h.multiple} onChange={e => updateHarmonic(i, "multiple", e.target.value)} style={inputStyle} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Gain<input type="number" step="0.05" value={h.gainRatio} onChange={e => updateHarmonic(i, "gainRatio", e.target.value)} style={inputStyle} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Atk(s)<input type="number" step="0.01" placeholder="Глоб" value={h.attackSec ?? ""} onChange={e => updateHarmonic(i, "attackSec", e.target.value)} style={inputStyle} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Dec(s)<input type="number" step="0.1" placeholder="Глоб" value={h.decaySec ?? ""} onChange={e => updateHarmonic(i, "decaySec", e.target.value)} style={inputStyle} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Sus<input type="number" step="0.1" placeholder="Глоб" value={h.sustainRatio ?? ""} onChange={e => updateHarmonic(i, "sustainRatio", e.target.value)} style={inputStyle} /></label>
                    <div style={{...labelStyle, flex: 1.0}}>
                      <span>LFO Rate Hz</span>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <input type="number" step="0.01" min="0" max="8" placeholder="Выкл" value={h.wobbleHz || ""} onChange={e => updateHarmonic(i, "wobbleHz", e.target.value)} style={{...inputStyle, flex: 1}} />
                        {[0.03,0.05,0.1,0.3,1].map(r => <button key={r} onClick={() => updateHarmonic(i, "wobbleHz", r)} style={{ background: h.wobbleHz === r ? "#0366d6" : "#f6f8fa", color: h.wobbleHz === r ? "#fff" : "#586069", border: "1px solid #d1d5da", borderRadius: "3px", fontSize: "9px", padding: "0 2px", cursor: "pointer", flexShrink: 0, height: "24px" }}>{r}</button>)}
                      </div>
                    </div>
                    <label style={{...labelStyle, flex: 0.6}}>Depth ¢<input type="number" step="0.5" min="0" max="100" placeholder="3" value={h.wobbleDepthCents ?? ""} onChange={e => updateHarmonic(i, "wobbleDepthCents", e.target.value)} style={inputStyle} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Detune<input type="number" step="1" placeholder="Выкл" value={h.detuneCentsRange || ""} onChange={e => updateHarmonic(i, "detuneCentsRange", e.target.value)} style={inputStyle} /></label>
                    <div style={{ display: "flex", flex: 1.2, gap: "2px" }}>
                      <label style={{...labelStyle, flex: 1}}>Pan<input type="number" step="0.1" placeholder="Авто" value={h.pan ?? ""} onChange={e => updateHarmonic(i, "pan", e.target.value)} style={inputStyle} /></label>
                      <label style={{...labelStyle, flex: 1}}>Bin(Hz)<input type="number" step="0.1" placeholder="0" value={h.binauralBeatHz || ""} onChange={e => updateHarmonic(i, "binauralBeatHz", e.target.value)} style={inputStyle} title="Бинауральные биения" /></label>
                    </div>
                    
                    <button onClick={() => removeHarmonic(i)} style={{ background: "#ffffff", color: "#d73a49", border: "1px solid #e1e4e8", padding: "0", width: "24px", height: "24px", borderRadius: "4px", cursor: "pointer", flexShrink: 0, fontSize: "14px" }}>×</button>
                  </div>
                ))}
              </div>
            </div>

            {/* Aux Tones Grid */}
            <div style={panelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div>
                  <h3 style={{...header3Style, margin: 0, color: "#0366d6"}}>Вспомогательные тона (Aux Tones)</h3>
                </div>
                <button 
                  onClick={addAuxTone}
                  style={{ background: "#f0f8ff", color: "#0366d6", border: "1px solid #c8e1ff", padding: "4px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", transition: "background 0.2s" }}
                >
                  + Добавить
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {(!editedPreset.auxTones || editedPreset.auxTones.length === 0) && (
                  <div style={{ fontSize: "12px", color: "#6a737d", fontStyle: "italic" }}>Нет вспомогательных тонов. Используются для саб-баса или дронов.</div>
                )}
                {(editedPreset.auxTones || []).map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: "8px", alignItems: "end", background: "#f0f8ff", padding: "6px 8px", borderRadius: "4px", border: "1px solid #c8e1ff" }}>
                    <div style={{ width: "20px", color: "#0366d6", paddingBottom: "4px", fontSize: "11px", fontWeight: 500 }}>A{i+1}</div>
                    
                    <label style={{...labelStyle, flex: 0.8}}>
                      Mult/Hz
                      <div style={{ display: "flex", gap: "2px" }}>
                        <input type="number" step="0.01" value={h.multiple} onChange={e => updateAuxTone(i, "multiple", e.target.value)} style={{...inputStyle, width: "24px", fontSize: "9px", padding: "0 2px", borderColor: "#c8e1ff"}} title="Множитель" />
                        <input type="number" step="0.1" placeholder="Hz" value={h.absoluteHz || ""} onChange={e => updateAuxTone(i, "absoluteHz", e.target.value)} style={{...inputStyle, flex: 1, borderColor: "#c8e1ff"}} title="Прямая частота" />
                      </div>
                    </label>
                    <label style={{...labelStyle, flex: 0.6}}>Gain<input type="number" step="0.05" value={h.gainRatio} onChange={e => updateAuxTone(i, "gainRatio", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Atk(s)<input type="number" step="0.01" placeholder="Глоб" value={h.attackSec ?? ""} onChange={e => updateAuxTone(i, "attackSec", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Dec(s)<input type="number" step="0.1" placeholder="Глоб" value={h.decaySec ?? ""} onChange={e => updateAuxTone(i, "decaySec", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Sus<input type="number" step="0.1" placeholder="Глоб" value={h.sustainRatio ?? ""} onChange={e => updateAuxTone(i, "sustainRatio", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                    <div style={{...labelStyle, flex: 1.0}}>
                      <span>LFO Rate Hz</span>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <input type="number" step="0.01" min="0" max="8" placeholder="Выкл" value={h.wobbleHz || ""} onChange={e => updateAuxTone(i, "wobbleHz", e.target.value)} style={{...inputStyle, flex: 1, borderColor: "#c8e1ff"}} />
                        {[0.03,0.05,0.1,0.3,1].map(r => <button key={r} onClick={() => updateAuxTone(i, "wobbleHz", r)} style={{ background: h.wobbleHz === r ? "#0366d6" : "#f0f8ff", color: h.wobbleHz === r ? "#fff" : "#586069", border: "1px solid #c8e1ff", borderRadius: "3px", fontSize: "9px", padding: "0 2px", cursor: "pointer", flexShrink: 0, height: "24px" }}>{r}</button>)}
                      </div>
                    </div>
                    <label style={{...labelStyle, flex: 0.6}}>Depth ¢<input type="number" step="0.5" min="0" max="100" placeholder="3" value={h.wobbleDepthCents ?? ""} onChange={e => updateAuxTone(i, "wobbleDepthCents", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                    <label style={{...labelStyle, flex: 0.6}}>Detune<input type="number" step="1" placeholder="Выкл" value={h.detuneCentsRange || ""} onChange={e => updateAuxTone(i, "detuneCentsRange", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                    <div style={{ display: "flex", flex: 1.2, gap: "2px" }}>
                      <label style={{...labelStyle, flex: 1}}>Pan<input type="number" step="0.1" placeholder="Авто" value={h.pan ?? ""} onChange={e => updateAuxTone(i, "pan", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} /></label>
                      <label style={{...labelStyle, flex: 1}}>Bin(Hz)<input type="number" step="0.1" placeholder="0" value={h.binauralBeatHz || ""} onChange={e => updateAuxTone(i, "binauralBeatHz", e.target.value)} style={{...inputStyle, borderColor: "#c8e1ff"}} title="Бинауральные биения" /></label>
                    </div>
                    
                    <button onClick={() => removeAuxTone(i)} style={{ background: "#ffffff", color: "#d73a49", border: "1px solid #c8e1ff", padding: "0", width: "24px", height: "24px", borderRadius: "4px", cursor: "pointer", flexShrink: 0, fontSize: "14px" }}>×</button>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
