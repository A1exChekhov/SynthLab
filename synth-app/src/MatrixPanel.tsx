"use client";

import { useState, useEffect } from "react";
import { playPreset, stopFrequency, isAudioSupported } from "./frequency-synth"; // Укажите правильный путь

// Матрица соответствий: Планета -> Частота -> Пресет
const MATRIX_DATA = [
  { id: "sun", name: "Солнце", symbol: "☉", hz: 528.0, preset: "bowl", desc: "Хрустальная чаша" },
  { id: "moon", name: "Луна", symbol: "☽", hz: 210.42, preset: "singing_bowl", desc: "Тибетская чаша" },
  { id: "mercury", name: "Меркурий", symbol: "☿", hz: 141.27, preset: "bell", desc: "Колокольчики" },
  { id: "venus", name: "Венера", symbol: "♀", hz: 639.0, preset: "harp", desc: "Арфа" },
  { id: "mars", name: "Марс", symbol: "♂", hz: 144.72, preset: "drum", desc: "Фрейм-драм" },
  { id: "jupiter", name: "Юпитер", symbol: "♃", hz: 183.58, preset: "organ", desc: "Орган" },
  { id: "saturn", name: "Сатурн", symbol: "♄", hz: 147.85, preset: "bass", desc: "Контрабас" },
  { id: "manipura", name: "Манипура", symbol: "❂", hz: 167.0, preset: "gong", desc: "Астрологический гонг" },
];

export default function MatrixPanel() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(isAudioSupported());
  }, []);

  const handlePlay = (id: string, hz: number, preset: string) => {
    // Если нажимаем на ту же самую кнопку — останавливаем
    if (activeId === id) {
      stopFrequency();
      setActiveId(null);
      return;
    }
    
    // Запускаем новую частоту (stopFrequency внутри playFrequency сработает автоматически)
    const success = playPreset(preset, hz, { durationSec: 30 }); // Задаем длинный цикл для сессии
    if (success) {
      setActiveId(id);
    }
  };

  const handleStopAll = () => {
    stopFrequency();
    setActiveId(null);
  };

  if (!supported) {
    return <div style={{ color: "red" }}>Ваш браузер не поддерживает Web Audio API.</div>;
  }

  return (
    <div style={{
      padding: "24px",
      background: "#0a0a0f",
      color: "#e0d6c8",
      fontFamily: "system-ui, sans-serif",
      minHeight: "100vh"
    }}>
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "32px" }}>
          <h2 style={{ fontSize: "24px", fontWeight: 400, letterSpacing: "0.05em", color: "#d4a83a" }}>
            Энергетическая Матрица
          </h2>
          {activeId && (
            <button
              onClick={handleStopAll}
              style={{
                background: "transparent",
                border: "1px solid #d4a83a",
                color: "#d4a83a",
                padding: "8px 16px",
                borderRadius: "6px",
                cursor: "pointer",
                transition: "all 0.2s"
              }}
            >
              Остановить поток
            </button>
          )}
        </div>

        {/* Сетка планет */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "16px"
        }}>
          {MATRIX_DATA.map((item) => {
            const isActive = activeId === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handlePlay(item.id, item.hz, item.preset)}
                style={{
                  background: isActive ? "linear-gradient(145deg, #2a2515 0%, #1a170d 100%)" : "#14141c",
                  border: isActive ? "1px solid #C5960C" : "1px solid #2a2a35",
                  borderRadius: "12px",
                  padding: "20px",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.3s ease",
                  boxShadow: isActive ? "0 0 20px rgba(197, 150, 12, 0.15)" : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                  <span style={{ fontSize: "28px", color: isActive ? "#d4a83a" : "#666" }}>
                    {item.symbol}
                  </span>
                  <span style={{ 
                    fontSize: "14px", 
                    fontWeight: 600, 
                    color: isActive ? "#d4a83a" : "#888",
                    fontFamily: "monospace"
                  }}>
                    {item.hz} Hz
                  </span>
                </div>
                
                <div>
                  <div style={{ fontSize: "18px", fontWeight: 500, color: isActive ? "#fff" : "#ccc" }}>
                    {item.name}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
                    {item.desc}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

      </div>
    </div>
  );
}