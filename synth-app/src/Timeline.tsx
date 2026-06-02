"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeTransport, toggleTransport, stopTransport, isTransportPlaying } from "./frequency-synth";

export type Clip = { enter: number; exit: number; enabled: boolean };

type Props = {
  lanes: { label: string }[];
  arrangement: Clip[];
  setArrangement: React.Dispatch<React.SetStateAction<Clip[]>>;
  duration: number;
  setDuration: (d: number) => void;
  bpm: number;
  loop: boolean;
  setLoop: (b: boolean) => void;
  onEnter: (i: number) => void;
  onExit: (i: number) => void;
  theme?: "dark" | "light";
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function Timeline({ lanes, arrangement, setArrangement, duration, setDuration, bpm, loop, setLoop, onEnter, onExit, theme = "dark" }: Props) {
  const [playing, setPlaying] = useState(isTransportPlaying());
  const [head, setHead] = useState(0);

  const onSetRef = useRef<Set<number>>(new Set());
  const arrRef = useRef(arrangement); arrRef.current = arrangement;
  const durRef = useRef(duration); durRef.current = duration;
  const loopRef = useRef(loop); loopRef.current = loop;
  const onEnterRef = useRef(onEnter); onEnterRef.current = onEnter;
  const onExitRef = useRef(onExit); onExitRef.current = onExit;

  const applyAt = (t: number) => {
    arrRef.current.forEach((c, i) => {
      const should = c.enabled && t >= c.enter && t < c.exit;
      const on = onSetRef.current.has(i);
      if (should && !on) { onEnterRef.current(i); onSetRef.current.add(i); }
      else if (!should && on) { onExitRef.current(i); onSetRef.current.delete(i); }
    });
  };
  const disarmAll = () => { onSetRef.current.forEach(i => onExitRef.current(i)); onSetRef.current.clear(); };

  // Follow the shared transport clock (synced with the drum machine).
  useEffect(() => {
    const unsub = subscribeTransport(pos => {
      if (pos < 0) { setPlaying(false); disarmAll(); setHead(0); return; }
      setPlaying(true);
      let t = pos;
      if (t >= durRef.current) {
        if (loopRef.current) { t = t % durRef.current; }
        else { stopTransport(); return; }
      }
      applyAt(t);
      setHead(t);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── drag to move / resize clips ──
  const drag = (e: React.PointerEvent, i: number, mode: "move" | "l" | "r") => {
    e.preventDefault(); e.stopPropagation();
    const laneEl = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement | null;
    if (!laneEl) return;
    const rect = laneEl.getBoundingClientRect();
    const startX = e.clientX;
    const a0 = arrRef.current[i];
    const pxToSec = durRef.current / rect.width;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) * pxToSec;
      setArrangement(prev => prev.map((a, idx) => {
        if (idx !== i) return a;
        let enter = a0.enter, exit = a0.exit;
        if (mode === "move") { const len = exit - enter; enter = Math.max(0, Math.min(durRef.current - len, a0.enter + d)); exit = enter + len; }
        else if (mode === "r") { exit = Math.max(enter + 0.5, Math.min(durRef.current, a0.exit + d)); }
        else { enter = Math.min(exit - 0.5, Math.max(0, a0.enter + d)); }
        return { ...a, enter, exit };
      }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const isLight = theme === "light";
  const bg = isLight ? "#f4f5f7" : "#15181d";
  const bd = isLight ? "#dadde2" : "#2a2f37";
  const lc = isLight ? "#555" : "#9aa3ad";
  const laneBg = isLight ? "#e9ebef" : "#1b1f26";

  const btn = (active: boolean, color: string): React.CSSProperties => ({
    padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 700,
    border: `1px solid ${active ? color : bd}`, background: active ? color : "transparent",
    color: active ? "#fff" : color, transition: "all .15s",
  });

  const secPerBeat = 60 / bpm;
  const beatLines = Array.from({ length: Math.floor(duration / secPerBeat) + 1 }, (_, k) => k * secPerBeat);
  const ticks = Array.from({ length: Math.floor(duration / 4) + 1 }, (_, k) => k * 4);

  return (
    <div style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 10, padding: 14, marginTop: 18, color: "var(--text-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 1 }}>🎞️ ТАЙМЛАЙН</span>
        <button onClick={toggleTransport} style={btn(playing, playing ? "#e63946" : "#2dd36f")}>{playing ? "■ Стоп" : "▶ Play"}</button>
        <button onClick={() => setLoop(!loop)} style={btn(loop, "#0077b6")}>🔁 Loop</button>
        <span style={{ fontSize: 12, color: lc, fontVariantNumeric: "tabular-nums" }}>{fmt(head)} / {fmt(duration)} · BPM {bpm}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: lc, marginLeft: "auto" }}>
          Длина, c
          <input type="number" min={4} max={600} value={duration} onChange={e => setDuration(Math.max(4, Number(e.target.value)))}
            style={{ width: 64, fontSize: 12, padding: "3px 4px", borderRadius: 4, background: isLight ? "#fff" : "#0f1216", color: "var(--text-primary)", border: `1px solid ${bd}` }} />
        </label>
      </div>

      <div style={{ display: "flex", marginLeft: 96, position: "relative", height: 14, marginBottom: 2 }}>
        {ticks.map(t => (
          <div key={t} style={{ position: "absolute", left: `${(t / duration) * 100}%`, fontSize: 9, color: lc, transform: "translateX(-50%)" }}>{t}s</div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}>
        {lanes.map((lane, i) => {
          const c = arrangement[i];
          const left = (c.enter / duration) * 100;
          const width = ((c.exit - c.enter) / duration) * 100;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => setArrangement(prev => prev.map((a, idx) => idx === i ? { ...a, enabled: !a.enabled } : a))}
                title="Вкл/выкл в аранжировке"
                style={{ width: 90, textAlign: "left", fontSize: 11, fontWeight: 600, color: c.enabled ? "var(--text-primary)" : lc, background: "transparent", border: "none", cursor: "pointer", opacity: c.enabled ? 1 : 0.45, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {lane.label}
              </button>
              <div data-lane style={{ position: "relative", flex: 1, height: 22, background: laneBg, borderRadius: 4, overflow: "hidden" }}>
                {/* beat grid */}
                {beatLines.map((b, k) => (
                  <div key={k} style={{ position: "absolute", left: `${(b / duration) * 100}%`, top: 0, bottom: 0, width: 1, background: k % 4 === 0 ? "rgba(125,125,125,0.35)" : "rgba(125,125,125,0.15)" }} />
                ))}
                <div onPointerDown={e => drag(e, i, "move")} style={{
                  position: "absolute", left: `${left}%`, width: `${width}%`, top: 2, bottom: 2,
                  background: c.enabled ? "linear-gradient(180deg,#2dd36f,#16a34a)" : "#4b5563",
                  borderRadius: 3, cursor: "grab", opacity: c.enabled ? 0.95 : 0.5, touchAction: "none",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div onPointerDown={e => drag(e, i, "l")} style={{ width: 6, height: "100%", cursor: "ew-resize", background: "rgba(0,0,0,0.25)" }} />
                  <div onPointerDown={e => drag(e, i, "r")} style={{ width: 6, height: "100%", cursor: "ew-resize", background: "rgba(0,0,0,0.25)" }} />
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ position: "absolute", left: `calc(96px + (100% - 96px) * ${head / duration})`, top: 0, bottom: 0, width: 2, background: "#e63946", pointerEvents: "none", display: playing || head > 0 ? "block" : "none" }} />
      </div>
      <div style={{ fontSize: 10, color: lc, marginTop: 8 }}>Тяни блок — сдвиг входа/выхода; края — длина. Клик по названию — вкл/выкл канал. Play синхронизирован с драм-машиной (общий BPM/клок).</div>
    </div>
  );
}
