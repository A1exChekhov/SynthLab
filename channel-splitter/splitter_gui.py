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

import queue
import tkinter as tk
from tkinter import ttk, messagebox

import numpy as np
import sounddevice as sd

HOSTAPI_PREF = ["Windows WASAPI", "MME", "Windows DirectSound", "Windows WDM-KS"]
SR = 48000
BLOCK = 480
MAXBUF = 32


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
                tt = (self._ph[ch_idx] + np.arange(frames)) / SR
                self._ph[ch_idx] += frames
                mix = (0.2 * np.sin(2 * np.pi * self.tone[ch_idx] * tt)).astype(np.float32)
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
FONT = ("Consolas", 9)
FONT_B = ("Consolas", 10, "bold")


class App:
    def __init__(self, root):
        self.root = root
        self.engine = Engine()
        self.sources = []          # list[Source]
        self.src_rows = []         # list of widget dicts
        self.out_devs = devices(True)
        self.in_devs = devices(False)
        self._meter_disp = [0.0, 0.0]

        root.title("CHANNEL SPLITTER")
        root.configure(bg=BG)
        root.geometry("680x560")
        root.minsize(640, 480)
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
        s.configure("TCombobox", fieldbackground=PANEL, background=PANEL, foreground=FG, arrowcolor=FG)
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

        # ── Outputs (two speakers) ──
        out = ttk.Frame(self.root, style="Panel.TFrame")
        out.pack(fill="x", padx=10, pady=4)
        ttk.Label(out, text="ВЫХОДЫ (КОЛОНКИ)", style="Sub.TLabel").grid(row=0, column=0, columnspan=4, sticky="w", padx=8, pady=(6, 2))

        ttk.Label(out, text="ЛЕВАЯ", background=PANEL, foreground=ACC).grid(row=1, column=0, sticky="w", padx=8)
        self.left_cb = ttk.Combobox(out, values=self._out_labels(), state="readonly", width=46, font=FONT)
        self.left_cb.grid(row=1, column=1, sticky="we", padx=4, pady=3)
        self.busL_var = tk.DoubleVar(value=100)
        ttk.Scale(out, from_=0, to=150, variable=self.busL_var, orient="horizontal",
                  command=lambda v: setattr(self.engine, "busL", float(v) / 100)).grid(row=1, column=2, sticky="we", padx=4)
        self.busL_lbl = ttk.Label(out, text="100%", background=PANEL, foreground=SUB, width=5)
        self.busL_lbl.grid(row=1, column=3, padx=4)

        ttk.Label(out, text="ПРАВАЯ", background=PANEL, foreground=ACC).grid(row=2, column=0, sticky="w", padx=8)
        self.right_cb = ttk.Combobox(out, values=self._out_labels(), state="readonly", width=46, font=FONT)
        self.right_cb.grid(row=2, column=1, sticky="we", padx=4, pady=3)
        self.busR_var = tk.DoubleVar(value=100)
        ttk.Scale(out, from_=0, to=150, variable=self.busR_var, orient="horizontal",
                  command=lambda v: setattr(self.engine, "busR", float(v) / 100)).grid(row=2, column=2, sticky="we", padx=4)
        self.busR_lbl = ttk.Label(out, text="100%", background=PANEL, foreground=SUB, width=5)
        self.busR_lbl.grid(row=2, column=3, padx=4)

        # meters
        mfr = ttk.Frame(out, style="Panel.TFrame")
        mfr.grid(row=3, column=0, columnspan=4, sticky="we", padx=8, pady=(2, 8))
        ttk.Label(mfr, text="L", background=PANEL, foreground=SUB).pack(side="left")
        self.meterL = tk.Canvas(mfr, height=8, bg=BD, highlightthickness=0)
        self.meterL.pack(side="left", fill="x", expand=True, padx=(4, 12))
        ttk.Label(mfr, text="R", background=PANEL, foreground=SUB).pack(side="left")
        self.meterR = tk.Canvas(mfr, height=8, bg=BD, highlightthickness=0)
        self.meterR.pack(side="left", fill="x", expand=True, padx=4)
        out.columnconfigure(1, weight=1)
        out.columnconfigure(2, weight=1)

        # default speaker selection
        self._select_default(self.left_cb, self.out_devs, "Bob")
        self._select_default(self.right_cb, self.out_devs, "JBL")

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
        ttk.Button(tr, text="Тест тоны", command=self.test_tones).pack(side="left", padx=6)
        ttk.Button(tr, text="⟳ Устройства", command=self.refresh_devices).pack(side="left")
        ttk.Label(tr, text="МАСТЕР", foreground=SUB, background=BG).pack(side="left", padx=(16, 4))
        self.master_var = tk.DoubleVar(value=100)
        ttk.Scale(tr, from_=0, to=150, variable=self.master_var, orient="horizontal", length=140,
                  command=lambda v: setattr(self.engine, "master", float(v) / 100)).pack(side="left")
        self.status = ttk.Label(tr, text="остановлено", foreground=SUB, background=BG)
        self.status.pack(side="right")

        # one source by default
        self.add_source_row(default_sub="CABLE Output")

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
        ttk.Scale(row, from_=0, to=150, variable=vol, orient="horizontal", length=90,
                  command=lambda v, s=src: setattr(s, "vol", float(v) / 100)).pack(side="left", padx=2)

        bal = tk.DoubleVar(value=0)
        ttk.Scale(row, from_=-100, to=100, variable=bal, orient="horizontal", length=130,
                  command=lambda v, s=src: setattr(s, "bal", float(v) / 100)).pack(side="left", padx=2)

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

    def test_tones(self):
        left = self._combo_idx(self.left_cb, self.out_devs)
        right = self._combo_idx(self.right_cb, self.out_devs)
        if left is None or right is None:
            messagebox.showerror("Splitter", "Выбери обе колонки.")
            return
        try:
            self.engine.start([], left, right, test=True)
        except Exception as e:
            messagebox.showerror("Splitter", f"Ошибка теста:\n{e}")
            return
        self.start_btn.config(text="■ СТОП")
        self.status.config(text="тест: L=440Гц R=660Гц")

    def _draw_meter(self, canvas, level):
        canvas.delete("all")
        w = canvas.winfo_width() or 200
        h = canvas.winfo_height() or 8
        fill = ACC if level < 0.7 else ("#ffd166" if level < 0.92 else RED)
        canvas.create_rectangle(0, 0, int(w * min(1.0, level)), h, fill=fill, width=0)

    def _tick(self):
        self.busL_lbl.config(text=f"{int(self.busL_var.get())}%")
        self.busR_lbl.config(text=f"{int(self.busR_var.get())}%")
        # smooth meter decay
        self._meter_disp[0] = max(self.engine.peakL, self._meter_disp[0] * 0.82)
        self._meter_disp[1] = max(self.engine.peakR, self._meter_disp[1] * 0.82)
        self._draw_meter(self.meterL, self._meter_disp[0])
        self._draw_meter(self.meterR, self._meter_disp[1])
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
