#!/usr/bin/env python3
"""
Channel Splitter — GUI (strict dark mixer).

Routes one or more stereo SOURCES to two separate output devices
(e.g. two Bluetooth speakers = LEFT speaker / RIGHT speaker).

Per source:  volume + balance (← LEFT speaker … RIGHT speaker →) + mute.
Per output:  volume.  Plus a master volume.  All adjustable live.

A source contributes its LEFT channel to the LEFT speaker and its RIGHT
channel to the RIGHT speaker; the balance knob shifts emphasis between the
two speakers. Each output is its own WASAPI stream with per-source ring
buffers so independent (Bluetooth) clocks don't click.
"""

import math
import queue
import tkinter as tk
from tkinter import ttk, messagebox

import numpy as np
import sounddevice as sd

HOSTAPI_PREF = ["Windows WASAPI", "MME", "Windows DirectSound", "Windows WDM-KS"]
SR = 48000
BLOCK = 480
MAXBUF = 32
MIN_DB = -48.0
MAX_DB = 3.0
SEGS = 30


def hostapi_name(i):
    return sd.query_hostapis()[i]["name"]


def refresh_portaudio():
    try:
        sd._terminate(); sd._initialize()
    except Exception:
        pass


def devices(want_output):
    out = []
    for i, d in enumerate(sd.query_devices()):
        ch = d["max_output_channels"] if want_output else d["max_input_channels"]
        if ch > 0:
            out.append((i, f"{d['name']} · {hostapi_name(d['hostapi'])}"))
    return out


def find_default(sub, want_output):
    sub = sub.lower()
    cands = []
    for i, d in enumerate(sd.query_devices()):
        ch = d["max_output_channels"] if want_output else d["max_input_channels"]
        if ch > 0 and sub in d["name"].lower():
            cands.append((i, d))
    if not cands:
        return None
    cands.sort(key=lambda it: HOSTAPI_PREF.index(hostapi_name(it[1]["hostapi"])) if hostapi_name(it[1]["hostapi"]) in HOSTAPI_PREF else 9)
    return cands[0][0]


def lr_gains(bal):  # bal in [-1, 1]; -1 = only LEFT speaker, +1 = only RIGHT speaker
    return (1.0 if bal <= 0 else 1.0 - bal), (1.0 if bal >= 0 else 1.0 + bal)


def bal_text(x):  # x in -100..100
    n = int(round(x))
    return "C" if n == 0 else (f"L{-n}" if n < 0 else f"R{n}")


class Source:
    _n = 0

    def __init__(self, idx, name):
        Source._n += 1
        self.id = Source._n
        self.idx = idx
        self.name = name
        self.vol = 1.0
        self.bal = 0.0
        self.mute = False
        # runtime
        self.qL = None
        self.qR = None
        self.bufL = np.zeros(0, dtype=np.float32)
        self.bufR = np.zeros(0, dtype=np.float32)
        self.stream = None


class Engine:
    def __init__(self):
        self.sources = []
        self.streams = []
        self.running = False
        self.test = False
        self.test_left = True
        self.test_right = True
        self.master = 1.0
        self.busL = 1.0
        self.busR = 1.0
        self.peakL = 0.0
        self.peakR = 0.0
        self._ph = [0, 0]
        self.tone = [440.0, 660.0]

    def _pull(self, src, left, frames):
        q = src.qL if left else src.qR
        b = src.bufL if left else src.bufR
        while b.shape[0] < frames:
            try:
                b = np.concatenate([b, q.get_nowait()])
            except queue.Empty:
                b = np.concatenate([b, np.zeros(frames - b.shape[0], dtype=np.float32)])
                break
        block = b[:frames]
        if left:
            src.bufL = b[frames:]
        else:
            src.bufR = b[frames:]
        return block

    def _out_cb(self, left):
        ch_idx = 0 if left else 1

        def cb(outdata, frames, _t, _s):
            if self.test:
                on = self.test_left if left else self.test_right
                if on:
                    tt = (self._ph[ch_idx] + np.arange(frames)) / SR
                    self._ph[ch_idx] += frames
                    mix = (0.2 * np.sin(2 * np.pi * self.tone[ch_idx] * tt)).astype(np.float32)
                else:
                    mix = np.zeros(frames, dtype=np.float32)
            else:
                mix = np.zeros(frames, dtype=np.float32)
                for src in self.sources:
                    if src.mute:
                        # still drain to keep latency bounded
                        self._pull(src, left, frames)
                        continue
                    block = self._pull(src, left, frames)
                    lg, rg = lr_gains(src.bal)
                    g = src.vol * (lg if left else rg)
                    if g:
                        mix += block * g
            mix = mix * (self.busL if left else self.busR) * self.master
            peak = float(np.max(np.abs(mix))) if mix.size else 0.0
            if left:
                self.peakL = peak
            else:
                self.peakR = peak
            outdata[:] = np.repeat(mix.reshape(-1, 1), outdata.shape[1], axis=1)

        return cb

    def start(self, sources, left_idx, right_idx, test=False):
        self.stop()
        self.sources = sources
        self.test = test
        self._ph = [0, 0]
        streams = []
        try:
            if not test:
                for src in sources:
                    src.qL = queue.Queue(MAXBUF)
                    src.qR = queue.Queue(MAXBUF)
                    src.bufL = np.zeros(0, dtype=np.float32)
                    src.bufR = np.zeros(0, dtype=np.float32)

                    def make_in(s):
                        def in_cb(indata, frames, _t, _st):
                            L = indata[:, 0].astype(np.float32).copy()
                            R = indata[:, 1].astype(np.float32).copy() if indata.shape[1] > 1 else L.copy()
                            for q, d in ((s.qL, L), (s.qR, R)):
                                try:
                                    q.put_nowait(d)
                                except queue.Full:
                                    try:
                                        q.get_nowait(); q.put_nowait(d)
                                    except queue.Empty:
                                        pass
                        return in_cb

                    src.stream = sd.InputStream(device=src.idx, channels=2, samplerate=SR,
                                                blocksize=BLOCK, dtype="float32", callback=make_in(src))
                    streams.append(src.stream)
            outL = sd.OutputStream(device=left_idx, channels=2, samplerate=SR, blocksize=BLOCK,
                                   dtype="float32", callback=self._out_cb(True))
            outR = sd.OutputStream(device=right_idx, channels=2, samplerate=SR, blocksize=BLOCK,
                                   dtype="float32", callback=self._out_cb(False))
            streams += [outL, outR]
            for s in streams:
                s.start()
        except Exception as e:
            for s in streams:
                try:
                    s.close()
                except Exception:
                    pass
            raise e
        self.streams = streams
        self.running = True

    def stop(self):
        for s in self.streams:
            try:
                s.stop(); s.close()
            except Exception:
                pass
        for src in self.sources:
            src.stream = None
        self.streams = []
        self.running = False
        self.peakL = self.peakR = 0.0


# ───────────────────────── GUI ─────────────────────────

BG = "#15181d"; PANEL = "#1b1f26"; FG = "#e0e0e0"; SUB = "#8b94a0"
BD = "#2a2f37"; ACC = "#2dd36f"; ACC2 = "#0077b6"; RED = "#e63946"
FONT = ("Segoe UI", 10)
FONT_B = ("Segoe UI", 11, "bold")


class App:
    def __init__(self, root):
        self.root = root
        self.engine = Engine()
        self.sources = []          # list[Source]
        self.src_rows = []         # list of widget dicts
        self.out_devs = devices(True)
        self.in_devs = devices(False)
        self._meter_disp = [0.0, 0.0]
        self._meter_hold = [0.0, 0.0]
        self._test_token = 0

        root.title("CHANNEL SPLITTER")
        root.configure(bg=BG)
        root.geometry("700x640")
        root.minsize(660, 560)
        self._style()
        self._build()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self._tick()

    def _style(self):
        s = ttk.Style()
        try:
            s.theme_use("clam")
        except Exception:
            pass
        s.configure(".", background=BG, foreground=FG, fieldbackground=PANEL, font=FONT)
        s.configure("TFrame", background=BG)
        s.configure("Panel.TFrame", background=PANEL)
        s.configure("TLabel", background=BG, foreground=FG)
        s.configure("Sub.TLabel", background=PANEL, foreground=SUB)
        s.configure("Head.TLabel", background=BG, foreground=ACC, font=FONT_B)
        s.configure("TButton", background=PANEL, foreground=FG, borderwidth=1, focuscolor=BG)
        s.map("TButton", background=[("active", BD)])
        s.configure("TCheckbutton", background=PANEL, foreground=FG)
        s.map("TCheckbutton", background=[("active", PANEL)])
        s.configure("TCombobox", fieldbackground=PANEL, background=PANEL, foreground=FG, arrowcolor=FG, padding=4)
        s.map("TCombobox",
              fieldbackground=[("readonly", PANEL), ("disabled", PANEL)],
              foreground=[("readonly", FG), ("disabled", SUB)],
              selectbackground=[("readonly", PANEL)],
              selectforeground=[("readonly", FG)])
        s.configure("Horizontal.TScale", background=PANEL, troughcolor=BD)
        self.root.option_add("*TCombobox*Listbox.background", PANEL)
        self.root.option_add("*TCombobox*Listbox.foreground", FG)
        self.root.option_add("*TCombobox*Listbox.selectBackground", ACC2)
        self.root.option_add("*TCombobox*Listbox.font", FONT)

    def _out_labels(self):
        return [lbl for _, lbl in self.out_devs]

    def _in_labels(self):
        return [lbl for _, lbl in self.in_devs]

    def _build(self):
        pad = dict(padx=10, pady=6)

        head = ttk.Frame(self.root)
        head.pack(fill="x", **pad)
        ttk.Label(head, text="CHANNEL SPLITTER", style="Head.TLabel").pack(side="left")
        ttk.Label(head, text="L/R → две колонки · мультиисточник · баланс", foreground=SUB, background=BG).pack(side="left", padx=10)

        # ── Outputs: LEFT strip | meters | RIGHT strip (Voicemeeter-style) ──
        out = ttk.Frame(self.root, style="Panel.TFrame")
        out.pack(fill="x", padx=10, pady=4)
        ttk.Label(out, text="ВЫХОДЫ — КОЛОНКИ", style="Sub.TLabel").grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=(6, 2))

        self.busL_var = tk.DoubleVar(value=100)
        self.busR_var = tk.DoubleVar(value=100)
        self.left_cb, self.busL_lbl = self._build_out_strip(out, 1, 0, "🔊  ЛЕВАЯ  (A)", "Bob", self.busL_var, "busL", "L")

        mfr = ttk.Frame(out, style="Panel.TFrame")
        mfr.grid(row=1, column=1, padx=6, pady=4)
        self.meters = tk.Canvas(mfr, width=150, height=210, bg=PANEL, highlightthickness=0)
        self.meters.pack()

        self.right_cb, self.busR_lbl = self._build_out_strip(out, 1, 2, "🔊  ПРАВАЯ  (B)", "JBL", self.busR_var, "busR", "R")

        out.columnconfigure(0, weight=1)
        out.columnconfigure(2, weight=1)

        # ── Sources ──
        srchead = ttk.Frame(self.root)
        srchead.pack(fill="x", padx=10, pady=(8, 0))
        ttk.Label(srchead, text="ИСТОЧНИКИ", style="Head.TLabel").pack(side="left")
        ttk.Button(srchead, text="+ Источник", command=self.add_source_row).pack(side="right")

        self.src_container = ttk.Frame(self.root, style="Panel.TFrame")
        self.src_container.pack(fill="both", expand=True, padx=10, pady=4)
        hdr = ttk.Frame(self.src_container, style="Panel.TFrame")
        hdr.pack(fill="x", padx=8, pady=(6, 0))
        for txt, w in (("Устройство", 34), ("Громк.", 12), ("Баланс ←L  R→", 18), ("", 6)):
            ttk.Label(hdr, text=txt, style="Sub.TLabel", width=w, anchor="w").pack(side="left", padx=2)

        # ── Transport ──
        tr = ttk.Frame(self.root)
        tr.pack(fill="x", padx=10, pady=8)
        self.start_btn = ttk.Button(tr, text="▶ СТАРТ", command=self.toggle)
        self.start_btn.pack(side="left")
        ttk.Button(tr, text="Тест обе", command=lambda: self.test_side("both")).pack(side="left", padx=6)
        ttk.Button(tr, text="⟳ Устройства", command=self.refresh_devices).pack(side="left")
        ttk.Label(tr, text="МАСТЕР", foreground=SUB, background=BG).pack(side="left", padx=(16, 4))
        self.master_var = tk.DoubleVar(value=100)
        ttk.Scale(tr, from_=0, to=150, variable=self.master_var, orient="horizontal", length=140,
                  command=lambda v: setattr(self.engine, "master", float(v) / 100)).pack(side="left")
        self.status = ttk.Label(tr, text="остановлено", foreground=SUB, background=BG)
        self.status.pack(side="right")

        # one source by default
        self.add_source_row(default_sub="CABLE Output")

    def _build_out_strip(self, parent, row, col, title, default_sub, vol_var, bus_attr, side):
        f = ttk.Frame(parent, style="Panel.TFrame")
        f.grid(row=row, column=col, sticky="nsew", padx=4, pady=4)
        ttk.Label(f, text=title, background=PANEL, foreground=ACC, font=FONT_B).pack(anchor="w")
        cb = ttk.Combobox(f, values=self._out_labels(), state="readonly", font=FONT)
        cb.pack(fill="x", pady=(4, 6))
        self._select_default(cb, self.out_devs, default_sub)
        vr = ttk.Frame(f, style="Panel.TFrame")
        vr.pack(fill="x")
        ttk.Label(vr, text="ГРОМК.", background=PANEL, foreground=SUB).pack(side="left")
        ttk.Scale(vr, from_=0, to=150, variable=vol_var, orient="horizontal",
                  command=lambda v, a=bus_attr: setattr(self.engine, a, float(v) / 100)).pack(side="left", fill="x", expand=True, padx=4)
        lbl = ttk.Label(vr, text="100%", background=PANEL, foreground=SUB, width=5)
        lbl.pack(side="left")
        ttk.Button(f, text="🔊 Тест этой колонки", command=lambda s=side: self.test_side(s)).pack(fill="x", pady=(8, 2))
        return cb, lbl

    def _select_default(self, cb, devlist, sub):
        idx = find_default(sub, want_output=(devlist is self.out_devs))
        if idx is not None:
            for k, (i, lbl) in enumerate(devlist):
                if i == idx:
                    cb.current(k)
                    return
        if devlist:
            cb.current(0)

    def _combo_idx(self, cb, devlist):
        k = cb.current()
        if k < 0 or k >= len(devlist):
            return None
        return devlist[k][0]

    def add_source_row(self, default_sub=None):
        src = Source(0, "")
        self.sources.append(src)
        row = ttk.Frame(self.src_container, style="Panel.TFrame")
        row.pack(fill="x", padx=8, pady=3)

        cb = ttk.Combobox(row, values=self._in_labels(), state="readonly", width=34, font=FONT)
        cb.pack(side="left", padx=2)
        if default_sub:
            self._select_default(cb, self.in_devs, default_sub)
        elif self.in_devs:
            cb.current(0)

        vol = tk.DoubleVar(value=100)
        vlbl = ttk.Label(row, text="100%", background=PANEL, foreground=FG, width=5)
        ttk.Scale(row, from_=0, to=150, variable=vol, orient="horizontal", length=90,
                  command=lambda *_a, s=src, var=vol, lbl=vlbl: (setattr(s, "vol", var.get() / 100), lbl.config(text=f"{int(var.get())}%"))).pack(side="left", padx=2)
        vlbl.pack(side="left", padx=(0, 6))

        bal = tk.DoubleVar(value=0)
        blbl = ttk.Label(row, text="C", background=PANEL, foreground=FG, width=5)
        ttk.Scale(row, from_=-100, to=100, variable=bal, orient="horizontal", length=130,
                  command=lambda *_a, s=src, var=bal, lbl=blbl: (setattr(s, "bal", var.get() / 100), lbl.config(text=bal_text(var.get())))).pack(side="left", padx=2)
        blbl.pack(side="left", padx=(0, 6))

        mute = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="M", variable=mute,
                        command=lambda s=src, m=mute: setattr(s, "mute", m.get())).pack(side="left", padx=2)

        ttk.Button(row, text="✕", width=2, command=lambda: self.remove_source(src, row)).pack(side="left", padx=2)

        self.src_rows.append({"src": src, "cb": cb, "row": row})

    def remove_source(self, src, row):
        if src in self.sources:
            self.sources.remove(src)
        self.src_rows = [r for r in self.src_rows if r["src"] is not src]
        row.destroy()

    def refresh_devices(self):
        refresh_portaudio()
        self.out_devs = devices(True)
        self.in_devs = devices(False)
        self.left_cb["values"] = self._out_labels()
        self.right_cb["values"] = self._out_labels()
        self._select_default(self.left_cb, self.out_devs, "Bob")
        self._select_default(self.right_cb, self.out_devs, "JBL")
        for r in self.src_rows:
            r["cb"]["values"] = self._in_labels()
        self.status.config(text="устройства обновлены")

    def _resolve_sources(self):
        ok = []
        for r in self.src_rows:
            idx = self._combo_idx(r["cb"], self.in_devs)
            if idx is None:
                continue
            r["src"].idx = idx
            r["src"].name = r["cb"].get()
            ok.append(r["src"])
        return ok

    def toggle(self):
        self._test_token += 1  # cancel any pending test auto-stop
        if self.engine.running:
            self.engine.stop()
            self.start_btn.config(text="▶ СТАРТ")
            self.status.config(text="остановлено")
            return
        left = self._combo_idx(self.left_cb, self.out_devs)
        right = self._combo_idx(self.right_cb, self.out_devs)
        if left is None or right is None:
            messagebox.showerror("Splitter", "Выбери обе колонки (ЛЕВАЯ/ПРАВАЯ).")
            return
        srcs = self._resolve_sources()
        if not srcs:
            messagebox.showerror("Splitter", "Добавь хотя бы один источник.")
            return
        try:
            self.engine.start(srcs, left, right, test=False)
        except Exception as e:
            messagebox.showerror("Splitter", f"Не удалось запустить:\n{e}\n\nПопробуй другой источник/колонку или ⟳ Устройства.")
            return
        self.start_btn.config(text="■ СТОП")
        self.status.config(text="играет")

    def test_side(self, side):
        left = self._combo_idx(self.left_cb, self.out_devs)
        right = self._combo_idx(self.right_cb, self.out_devs)
        if left is None or right is None:
            messagebox.showerror("Splitter", "Выбери обе колонки.")
            return
        self.engine.test_left = side in ("L", "both")
        self.engine.test_right = side in ("R", "both")
        try:
            self.engine.start([], left, right, test=True)
        except Exception as e:
            messagebox.showerror("Splitter", f"Ошибка теста:\n{e}")
            return
        self.start_btn.config(text="■ СТОП")
        txt = {"L": "ТЕСТ → только ЛЕВАЯ (440 Гц)",
               "R": "ТЕСТ → только ПРАВАЯ (660 Гц)",
               "both": "ТЕСТ → L=440 / R=660"}[side]
        self.status.config(text=txt)
        # auto-stop the short test beep
        self._test_token += 1
        tok = self._test_token
        self.root.after(1800, lambda: self._auto_stop_test(tok))

    def _auto_stop_test(self, tok):
        if tok == self._test_token and self.engine.running and self.engine.test:
            self.engine.stop()
            self.start_btn.config(text="▶ СТАРТ")
            self.status.config(text="остановлено")

    @staticmethod
    def _to_db(lvl):
        if lvl <= 1e-6:
            return MIN_DB
        return max(MIN_DB, min(MAX_DB, 20.0 * math.log10(lvl)))

    @staticmethod
    def _frac(db):
        return (db - MIN_DB) / (MAX_DB - MIN_DB)

    def _draw_meters(self):
        c = self.meters
        c.delete("all")
        W = c.winfo_width() or 150
        H = c.winfo_height() or 210
        top, bot = 18, H - 24
        barH = bot - top
        barW = 30
        cx = W / 2
        gutter = 46
        xL = cx - gutter / 2 - barW
        xR = cx + gutter / 2

        # dB scale in the centre gutter
        for db in (0, -6, -12, -18, -24, -36, -48):
            y = bot - self._frac(db) * barH
            c.create_text(cx, y, text=str(db), fill=SUB, font=("Consolas", 7))
            c.create_line(xL + barW, y, xL + barW + 4, y, fill=BD)
            c.create_line(xR - 4, y, xR, y, fill=BD)

        bars = ((xL, self._meter_disp[0], self._meter_hold[0], "A", "ЛЕВАЯ"),
                (xR, self._meter_disp[1], self._meter_hold[1], "B", "ПРАВАЯ"))
        for x, lvl, hold, name, cap in bars:
            db = self._to_db(lvl)
            litf = self._frac(db)
            for k in range(SEGS):
                segf = (k + 0.5) / SEGS
                seg_db = MIN_DB + segf * (MAX_DB - MIN_DB)
                y0 = bot - (k + 1) / SEGS * barH
                y1 = bot - k / SEGS * barH
                if segf <= litf:
                    col = RED if seg_db >= -3 else ("#ffd166" if seg_db >= -12 else ACC)
                else:
                    col = "#10141a"
                c.create_rectangle(x, y0 + 1, x + barW, y1 - 1, fill=col, width=0)
            # peak-hold marker
            yh = bot - self._frac(self._to_db(hold)) * barH
            c.create_line(x, yh, x + barW, yh, fill="#ffffff", width=1)
            # captions + numeric dB
            c.create_text(x + barW / 2, top - 8, text=("-inf" if db <= MIN_DB else f"{db:.1f}"), fill=FG, font=("Consolas", 8, "bold"))
            c.create_text(x + barW / 2, bot + 7, text=name, fill=ACC, font=("Consolas", 9, "bold"))
            c.create_text(x + barW / 2, bot + 16, text=cap, fill=SUB, font=("Consolas", 7))

    def _tick(self):
        self.busL_lbl.config(text=f"{int(self.busL_var.get())}%")
        self.busR_lbl.config(text=f"{int(self.busR_var.get())}%")
        for i, pk in enumerate((self.engine.peakL, self.engine.peakR)):
            self._meter_disp[i] = max(pk, self._meter_disp[i] * 0.80)
            self._meter_hold[i] = pk if pk >= self._meter_hold[i] else max(pk, self._meter_hold[i] - 0.006)
        self._draw_meters()
        self.root.after(60, self._tick)

    def on_close(self):
        try:
            self.engine.stop()
        finally:
            self.root.destroy()


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
