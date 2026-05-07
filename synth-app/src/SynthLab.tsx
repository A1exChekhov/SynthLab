"use client";

import { useState } from "react";
import { playFrequency, stopFrequency, type Harmonic } from "./frequency-synth";

export default function SynthLab() {
  // Базовые настройки
  const [baseHz, setBaseHz] = useState<number>(167);
  const [waveform, setWaveform] = useState<OscillatorType>("sine");
  const [attackSec, setAttackSec] = useState<number>(0.1);
  const [releaseSec, setReleaseSec] = useState<number>(4.5);
  const [lowpassHz, setLowpassHz] = useState<number | "">("");

  // Массив обертонов (по умолчанию загрузим базу гонга)
  const [harmonics, setHarmonics] = useState<Harmonic[]>([
    { multiple: 1.00, gainRatio: 0.85, detuneCentsRange: 8 },
    { multiple: 1.34, gainRatio: 0.65, detuneCentsRange: 8, wobbleHz: 0.3 },
  ]);

  const [isPlaying, setIsPlaying] = useState(false);

  // Управление воспроизведением
  const handlePlay = () => {
    stopFrequency();
    const options = {
      waveform,
      attackSec,
      releaseSec,
      durationSec: 60, // Длинный сустейн для тестов
      lowpassHz: lowpassHz === "" ? undefined : Number(lowpassHz),
      harmonics,
    };
    playFrequency(baseHz, options);
    setIsPlaying(true);
  };

  const handleStop = () => {
    stopFrequency();
    setIsPlaying(false);
  };

  // Управление массивом обертонов
  const addHarmonic = () => {
    setHarmonics([...harmonics, { multiple: 2.0, gainRatio: 0.5 }]);
  };

  const removeHarmonic = (index: number) => {
    setHarmonics(harmonics.filter((_, i) => i !== index));
  };

  const updateHarmonic = (index: number, field: keyof Harmonic, value: number | "") => {
    const newHarmonics = [...harmonics];
    if (value === "") {
      delete newHarmonics[index][field]; // Удаляем опциональные поля (LFO, Detune) если пусто
    } else {
      newHarmonics[index] = { ...newHarmonics[index], [field]: Number(value) };
    }
    setHarmonics(newHarmonics);
    
    // Перезапуск звука на лету, если он сейчас играет
    if (isPlaying) {
      setTimeout(() => {
        stopFrequency();
        playFrequency(baseHz, {
          waveform, attackSec, releaseSec, durationSec: 60,
          lowpassHz: lowpassHz === "" ? undefined : Number(lowpassHz),
          harmonics: newHarmonics
        });
      }, 50);
    }
  };

  // Экспорт пресета
  const exportPreset = () => {
    const presetCode = `
my_custom_preset: {
  waveform: "${waveform}",
  attackSec: ${attackSec},
  releaseSec: ${releaseSec},
  ${lowpassHz !== "" ? `lowpassHz: ${lowpassHz},` : ""}
  harmonics: ${JSON.stringify(harmonics, null, 4).replace(/"([^"]+)":/g, '$1:')}
},`;
    navigator.clipboard.writeText(presetCode);
    alert("Код пресета скопирован в буфер обмена! Вставьте его в PRESETS в frequency-synth.ts");
  };

  // --- Стили ---
  const inputStyle = { background: "#1a1a24", border: "1px solid #333", color: "#fff", padding: "6px", borderRadius: "4px", width: "100px" };
  const labelStyle = { display: "flex", flexDirection: "column" as const, gap: "4px", fontSize: "12px", color: "#888" };

  return (
    <div style={{ padding: "30px", background: "#0a0a0f", color: "#e0d6c8", fontFamily: "monospace", minHeight: "100vh" }}>
      <div style={{ maxWidth: "900px", margin: "0 auto" }}>
        
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #333", paddingBottom: "20px", marginBottom: "20px" }}>
          <h2>Лаборатория Синтеза</h2>
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={isPlaying ? handleStop : handlePlay} style={{ background: isPlaying ? "#8b0000" : "#d4a83a", color: isPlaying ? "#fff" : "#000", padding: "10px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}>
              {isPlaying ? "Остановить (Stop)" : "Слушать (Play)"}
            </button>
            <button onClick={exportPreset} style={{ background: "transparent", border: "1px solid #d4a83a", color: "#d4a83a", padding: "10px 20px", borderRadius: "6px", cursor: "pointer" }}>
              📋 Скопировать пресет
            </button>
          </div>
        </div>

        {/* Глобальные настройки */}
        <div style={{ background: "#14141c", padding: "20px", borderRadius: "8px", marginBottom: "20px", border: "1px solid #2a2a35" }}>
          <h3 style={{ marginTop: 0, color: "#d4a83a" }}>Глобальная огибающая (Envelope)</h3>
          <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
            <label style={labelStyle}>Базовая частота (Hz)
              <input type="number" value={baseHz} onChange={e => setBaseHz(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>Форма волны
              <select value={waveform} onChange={e => setWaveform(e.target.value as OscillatorType)} style={inputStyle}>
                <option value="sine">Sine (Синус)</option>
                <option value="triangle">Triangle (Треугольник)</option>
                <option value="sawtooth">Sawtooth (Пила)</option>
                <option value="square">Square (Квадрат)</option>
              </select>
            </label>
            <label style={labelStyle}>Атака (сек)
              <input type="number" step="0.1" value={attackSec} onChange={e => setAttackSec(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>Затухание (сек)
              <input type="number" step="0.1" value={releaseSec} onChange={e => setReleaseSec(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>Срез фильтра (Lowpass Hz)
              <input type="number" placeholder="Выкл" value={lowpassHz} onChange={e => setLowpassHz(e.target.value ? Number(e.target.value) : "")} style={inputStyle} />
            </label>
          </div>
        </div>

        {/* Редактор Обертонов */}
        <div style={{ background: "#14141c", padding: "20px", borderRadius: "8px", border: "1px solid #2a2a35" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ margin: 0, color: "#d4a83a" }}>Гармоники (Обертона)</h3>
            <button onClick={addHarmonic} style={{ background: "#2a2a35", color: "#fff", border: "none", padding: "6px 12px", borderRadius: "4px", cursor: "pointer" }}>+ Добавить слой</button>
          </div>

          {harmonics.map((h, i) => (
            <div key={i} style={{ display: "flex", gap: "16px", alignItems: "flex-end", background: "#1a1a24", padding: "12px", borderRadius: "6px", marginBottom: "10px", border: "1px solid #333" }}>
              <div style={{ color: "#666", width: "20px" }}>#{i+1}</div>
              
              <label style={labelStyle}>Множитель (Multiple)
                <input type="number" step="0.01" value={h.multiple} onChange={e => updateHarmonic(i, "multiple", e.target.value === "" ? "" : Number(e.target.value))} style={inputStyle} title="1 = База. 2 = Октава. Дробные (1.34) создают металл." />
              </label>
              
              <label style={labelStyle}>Громкость (Gain 0..1)
                <input type="number" step="0.05" value={h.gainRatio} onChange={e => updateHarmonic(i, "gainRatio", e.target.value === "" ? "" : Number(e.target.value))} style={inputStyle} />
              </label>

              <label style={labelStyle}>LFO Пульсация (Hz)
                <input type="number" step="0.1" placeholder="Выкл" value={h.wobbleHz || ""} onChange={e => updateHarmonic(i, "wobbleHz", e.target.value === "" ? "" : Number(e.target.value))} style={inputStyle} title="Скорость эффекта 'туда-сюда' (например, 0.5)" />
              </label>

              <label style={labelStyle}>Микро-сдвиг (Cents)
                <input type="number" step="1" placeholder="Выкл" value={h.detuneCentsRange || ""} onChange={e => updateHarmonic(i, "detuneCentsRange", e.target.value === "" ? "" : Number(e.target.value))} style={inputStyle} title="Шумовое искривление для живости (например, 5)" />
              </label>

              <button onClick={() => removeHarmonic(i)} style={{ background: "transparent", color: "#8b0000", border: "1px solid #8b0000", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", height: "32px" }}>
                Удалить
              </button>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}