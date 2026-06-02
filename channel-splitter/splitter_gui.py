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

import json
import math
import os
import queue
import tkinter as tk
from tkinter import ttk, messagebox, simpledialog

import numpy as np
import sounddevice as sd
from scipy.signal import sosfilt

HOSTAPI_PREF = ["Windows WASAPI", "MME", "Windows DirectSound", "Windows WDM-KS"]
SR = 48000
BLOCK = 960          # ~20 ms blocks — fewer glitches with Bluetooth
MAXBUF = 60          # deeper ring buffer to absorb clock drift
MIN_DB = -48.0
MAX_DB = 3.0
SEGS = 30

# Graphic EQ (12 bands incl. 20 Hz and 20 kHz)
EQ_FREQS = [20, 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 20000]
EQ_Q = 1.4
EQ_RANGE = 12.0  # +/- dB
EQ_EDGES = []
for _i, _f in enumerate(EQ_FREQS):
    _lo = (EQ_FREQS[_i - 1] * _f) ** 0.5 if _i > 0 else _f / 1.3
    _hi = (EQ_FREQS[_i + 1] * _f) ** 0.5 if _i < len(EQ_FREQS) - 1 else min(_f * 1.3, SR / 2 - 1)
    EQ_EDGES.append((_lo, _hi))
# +3 dB/oct display tilt (relative to 250 Hz) so the spectrum bars are visually balanced
EQ_TILT = [(_f / 250.0) ** 0.5 for _f in EQ_FREQS]
SPEC_FLOOR = -60.0   # dB shown as empty bar
SPEC_CEIL = -6.0     # dB shown as full bar


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


def eq_flabel(f):
    return f"{f // 1000}k" if f >= 1000 else str(f)


def chan_text(v):  # per-output balance label: v in -100..100
    n = int(round(v))
    if n <= -98:
        return "Л"
    if n >= 98:
        return "П"
    if -2 <= n <= 2:
        return "микс"
    return f"{n:+d}"


def _peaking_sos(f0, q, gain_db, fs):
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * f0 / fs
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2.0 * q)
    b0 = 1 + alpha * A
    b1 = -2 * cw
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cw
    a2 = 1 - alpha / A
    return [b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]


def _lowshelf_sos(f0, gain_db, fs, S=0.7):
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * f0 / fs
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / 2.0 * np.sqrt((A + 1 / A) * (1 / S - 1) + 2)
    tsa = 2.0 * np.sqrt(A) * alpha
    b0 = A * ((A + 1) - (A - 1) * cw + tsa)
    b1 = 2 * A * ((A - 1) - (A + 1) * cw)
    b2 = A * ((A + 1) - (A - 1) * cw - tsa)
    a0 = (A + 1) + (A - 1) * cw + tsa
    a1 = -2 * ((A - 1) + (A + 1) * cw)
    a2 = (A + 1) + (A - 1) * cw - tsa
    return [b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]


def _highshelf_sos(f0, gain_db, fs, S=0.7):
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * f0 / fs
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / 2.0 * np.sqrt((A + 1 / A) * (1 / S - 1) + 2)
    tsa = 2.0 * np.sqrt(A) * alpha
    b0 = A * ((A + 1) + (A - 1) * cw + tsa)
    b1 = -2 * A * ((A - 1) + (A + 1) * cw)
    b2 = A * ((A + 1) + (A - 1) * cw - tsa)
    a0 = (A + 1) - (A - 1) * cw + tsa
    a1 = 2 * ((A - 1) - (A + 1) * cw)
    a2 = (A + 1) - (A - 1) * cw - tsa
    return [b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]


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
        # routing
        self.width = 0.0   # 0 = channels separate (L->left, R->right); 1 = full mono
        self.inv = False   # invert phase of the RIGHT channel
        self.in_peakL = 0.0
        self.in_peakR = 0.0
        # runtime (each queue holds stereo blocks)
        self.qA = None     # feeds LEFT output
        self.qB = None     # feeds RIGHT output
        self.bufA = np.zeros((0, 2), dtype=np.float32)
        self.bufB = np.zeros((0, 2), dtype=np.float32)
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
        # EQ + effects (each effect has its own on/off)
        self.eq_on = False
        self.eq_gains = [0.0] * len(EQ_FREQS)
        self.bass_on = False; self.bass = 0.0          # low-shelf 110 Hz (Bass Boost)
        self.spatial_on = False; self.spatial = 1.0    # stereo width factor (1..2)
        self.threeD_on = False; self.threeD = 0.0      # 3D depth 0..1 (crossfeed/Haas)
        self.surround_on = False; self.surround = 0.0  # pseudo 7.1 surround 0..1 (early reflections)
        self._spat_maxd = int(SR * 0.08) + 1
        self.spectrum = np.zeros(len(EQ_FREQS), dtype=np.float64)
        self.eq_sos = None
        self.build_eq()
        # per-output channel balance: -1 = play LEFT input channel, +1 = play RIGHT, 0 = mono mix
        self.balL = -1.0   # left speaker  -> left channel by default
        self.balR = 1.0    # right speaker -> right channel by default
        self.busL = 1.0
        self.busR = 1.0
        self.peakL = 0.0
        self.peakR = 0.0
        self._ph = [0, 0]
        self.tone = [440.0, 660.0]

    def build_eq(self):
        rows = []
        if self.eq_on:
            rows += [_peaking_sos(f, EQ_Q, g, SR) for f, g in zip(EQ_FREQS, self.eq_gains)]
        if self.bass_on and self.bass > 0:
            rows.append(_lowshelf_sos(110.0, self.bass, SR))
        self.eq_sos = np.array(rows, dtype=np.float64) if rows else None

    def _apply_spatial(self, st, sumL, sumR, frames):
        if not (self.spatial_on or self.threeD_on or self.surround_on):
            return sumL, sumR
        MAXD = self._spat_maxd
        if st.get("tL") is None or st["tL"].shape[0] != MAXD:
            st["tL"] = np.zeros(MAXD, dtype=np.float32)
            st["tR"] = np.zeros(MAXD, dtype=np.float32)
        extL = np.concatenate([st["tL"], sumL.astype(np.float32)])
        extR = np.concatenate([st["tR"], sumR.astype(np.float32)])

        def d(ext, ms):
            dly = int(SR * ms / 1000.0)
            return ext[MAXD - dly: MAXD - dly + frames]

        outL = sumL.copy()
        outR = sumR.copy()
        if self.spatial_on and self.spatial != 1.0:
            w = self.spatial
            mid = (outL + outR) * 0.5
            side = (outL - outR) * 0.5 * w
            outL = mid + side
            outR = mid - side
        if self.threeD_on and self.threeD > 0:
            a = self.threeD
            outL = outL + a * 0.6 * d(extR, 12.0)
            outR = outR + a * 0.6 * d(extL, 12.0)
        if self.surround_on and self.surround > 0:
            a = self.surround
            mext = (extL + extR) * 0.5

            def dm(ms):
                dly = int(SR * ms / 1000.0)
                return mext[MAXD - dly: MAXD - dly + frames]

            outL = outL + a * (0.45 * dm(19) + 0.35 * dm(29) + 0.28 * dm(41) + 0.22 * dm(57))
            outR = outR + a * (0.45 * dm(23) + 0.33 * dm(33) + 0.26 * dm(47) + 0.20 * dm(61))
        st["tL"] = extL[-MAXD:]
        st["tR"] = extR[-MAXD:]
        return outL.astype(np.float32), outR.astype(np.float32)

    def _update_spectrum(self, x):
        n = x.shape[0]
        if n < 16:
            return
        mag = np.abs(np.fft.rfft(x * np.hanning(n))) / (n * 0.5)
        freqs = np.fft.rfftfreq(n, 1.0 / SR)
        sp = self.spectrum
        for i, (lo, hi) in enumerate(EQ_EDGES):
            m = (freqs >= lo) & (freqs < hi)
            sp[i] = (float(mag[m].mean()) * EQ_TILT[i]) if m.any() else 0.0

    def _pull(self, src, left, frames):
        q = src.qA if left else src.qB
        b = src.bufA if left else src.bufB
        while b.shape[0] < frames:
            try:
                b = np.concatenate([b, q.get_nowait()])
            except queue.Empty:
                b = np.concatenate([b, np.zeros((frames - b.shape[0], 2), dtype=np.float32)])
                break
        block = b[:frames]
        if left:
            src.bufA = b[frames:]
        else:
            src.bufB = b[frames:]
        return block  # (frames, 2)

    def _out_cb(self, left):
        ch_idx = 0 if left else 1
        state = {"zi": None}

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
                sumL = np.zeros(frames, dtype=np.float32)
                sumR = np.zeros(frames, dtype=np.float32)
                for src in self.sources:
                    block = self._pull(src, left, frames)  # (frames, 2)
                    if src.mute:
                        continue
                    lg, rg = lr_gains(src.bal)
                    v = src.vol
                    sumL = sumL + block[:, 0] * (v * lg)
                    sumR = sumR + (-block[:, 1] if src.inv else block[:, 1]) * (v * rg)
                sumL, sumR = self._apply_spatial(state, sumL, sumR, frames)
                b = self.balL if left else self.balR   # -1 = L channel, +1 = R channel, 0 = mono
                mix = sumL * (0.5 - b * 0.5) + sumR * (0.5 + b * 0.5)
            mix = mix * (self.busL if left else self.busR) * self.master
            sos = self.eq_sos
            if sos is not None and sos.shape[0] > 0:
                if state["zi"] is None or state["zi"].shape[0] != sos.shape[0]:
                    state["zi"] = np.zeros((sos.shape[0], 2))
                mix, state["zi"] = sosfilt(sos, mix, zi=state["zi"])
            mix = mix.astype(np.float32)
            if left:
                self._update_spectrum(mix)
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
                    src.qA = queue.Queue(MAXBUF)
                    src.qB = queue.Queue(MAXBUF)
                    src.bufA = np.zeros((0, 2), dtype=np.float32)
                    src.bufB = np.zeros((0, 2), dtype=np.float32)

                    def make_in(s):
                        def in_cb(indata, frames, _t, _st):
                            if indata.shape[1] > 1:
                                blk = indata[:, :2].astype(np.float32).copy()
                            else:
                                mono = indata[:, 0].astype(np.float32)
                                blk = np.column_stack([mono, mono])
                            s.in_peakL = float(np.max(np.abs(blk[:, 0]))) if frames else 0.0
                            s.in_peakR = float(np.max(np.abs(blk[:, 1]))) if frames else 0.0
                            for q in (s.qA, s.qB):
                                try:
                                    q.put_nowait(blk)
                                except queue.Full:
                                    try:
                                        q.get_nowait(); q.put_nowait(blk)
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

APP_VERSION = "1.0"
BRAND = "Errarium™"
DEVELOPER = "Errarium"


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
        self._spec_disp = np.zeros(len(EQ_FREQS), dtype=np.float64)
        self._test_token = 0

        root.title("CHANNEL SPLITTER")
        root.configure(bg=BG)
        root.geometry("760x650")
        root.minsize(720, 600)
        self._style()
        self._build()
        root.update_idletasks()
        root.geometry(f"760x{root.winfo_reqheight() + 4}")
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
        s.configure("Vertical.TScale", background=PANEL, troughcolor=BD)
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
        ttk.Label(head, text=f"by {BRAND}", foreground=ACC, background=BG, font=("Segoe UI", 9, "bold")).pack(side="left", padx=8)
        ttk.Label(head, text="L/R → две колонки · мультиисточник · баланс · EQ", foreground=SUB, background=BG).pack(side="left", padx=6)

        # ── Outputs: LEFT strip | meters | RIGHT strip (Voicemeeter-style) ──
        out = ttk.Frame(self.root, style="Panel.TFrame")
        out.pack(fill="x", padx=10, pady=4)
        ttk.Label(out, text="ВЫХОДЫ — КОЛОНКИ", style="Sub.TLabel").grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=(6, 2))

        self.busL_var = tk.DoubleVar(value=100)
        self.busR_var = tk.DoubleVar(value=100)
        self.left_cb, self.busL_lbl = self._build_out_strip(out, 1, 0, "🔊  ЛЕВАЯ  (A)", "Bob", self.busL_var, "busL", "L", "balL", -100)

        mfr = ttk.Frame(out, style="Panel.TFrame")
        mfr.grid(row=1, column=1, padx=6, pady=4)
        self.meters = tk.Canvas(mfr, width=150, height=168, bg=PANEL, highlightthickness=0)
        self.meters.pack()

        self.right_cb, self.busR_lbl = self._build_out_strip(out, 1, 2, "🔊  ПРАВАЯ  (B)", "JBL", self.busR_var, "busR", "R", "balR", 100)

        out.columnconfigure(0, weight=1)
        out.columnconfigure(2, weight=1)

        # ── Sources ──
        srchead = ttk.Frame(self.root)
        srchead.pack(fill="x", padx=10, pady=(8, 0))
        ttk.Label(srchead, text="ИСТОЧНИКИ", style="Head.TLabel").pack(side="left")
        ttk.Button(srchead, text="+ Источник", command=self.add_source_row).pack(side="right")

        self.src_container = ttk.Frame(self.root, style="Panel.TFrame")
        self.src_container.pack(fill="x", padx=10, pady=4)
        hdr = ttk.Frame(self.src_container, style="Panel.TFrame")
        hdr.pack(fill="x", padx=8, pady=(6, 0))
        for txt, w in (("Устройство", 26), ("Громк.", 12), ("Баланс ←Л П→", 18), ("Фаза/Mute", 12)):
            ttk.Label(hdr, text=txt, style="Sub.TLabel", width=w, anchor="w").pack(side="left", padx=2)

        # ── Equalizer (bottom) ──
        self._build_eq()

        # ── Transport ──
        tr = ttk.Frame(self.root)
        tr.pack(fill="x", padx=10, pady=8)
        self.start_btn = tk.Button(tr, text="○ OFF", command=self.toggle, bg=PANEL, fg=SUB,
                                   activebackground=BD, activeforeground=FG, relief="flat", bd=1,
                                   font=FONT_B, padx=20, pady=3, cursor="hand2")
        self.start_btn.pack(side="left")
        ttk.Button(tr, text="⟳ Устройства", command=self.refresh_devices).pack(side="left", padx=8)
        ttk.Label(tr, text="МАСТЕР", foreground=SUB, background=BG).pack(side="left", padx=(16, 4))
        self.master_var = tk.DoubleVar(value=100)
        ttk.Scale(tr, from_=0, to=150, variable=self.master_var, orient="horizontal", length=140,
                  command=lambda v: setattr(self.engine, "master", float(v) / 100)).pack(side="left")
        self.status = ttk.Label(tr, text="остановлено", foreground=SUB, background=BG)
        self.status.pack(side="right")

        # one source by default
        self.add_source_row(default_sub="CABLE Output")

        # footer / license + developer
        ttk.Label(self.root,
                  text=f"© 2026 {BRAND}  ·  Channel Splitter v{APP_VERSION}  ·  разработчик: {DEVELOPER}  ·  все права защищены",
                  background=BG, foreground=SUB, font=("Segoe UI", 8)).pack(pady=(2, 4))

    def _build_out_strip(self, parent, row, col, title, default_sub, vol_var, bus_attr, side, bal_attr, default_bal):
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

        ttk.Button(f, text="🔊 Тест этой колонки", command=lambda s=side: self.test_side(s)).pack(fill="x", pady=(6, 4))

        # per-output channel balance (under the test button): ←Л … микс … П→
        br = ttk.Frame(f, style="Panel.TFrame")
        br.pack(fill="x")
        ttk.Label(br, text="КАНАЛ", background=PANEL, foreground=SUB).pack(side="left")
        bal_var = tk.DoubleVar(value=default_bal)
        blbl = ttk.Label(br, text=chan_text(default_bal), background=PANEL, foreground=ACC, width=6)
        ttk.Scale(br, from_=-100, to=100, variable=bal_var, orient="horizontal",
                  command=lambda v, a=bal_attr, var=bal_var, lb=blbl: (setattr(self.engine, a, var.get() / 100), lb.config(text=chan_text(var.get())))).pack(side="left", fill="x", expand=True, padx=4)
        blbl.pack(side="left")
        ttk.Label(f, text="←Л   микс   П→", background=PANEL, foreground=SUB).pack(anchor="center")
        setattr(self.engine, bal_attr, default_bal / 100)
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

        cb = ttk.Combobox(row, values=self._in_labels(), state="readonly", width=24, font=FONT)
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
        blbl = ttk.Label(row, text="C", background=PANEL, foreground=FG, width=4, anchor="center")
        ttk.Scale(row, from_=-100, to=100, variable=bal, orient="horizontal", length=110,
                  command=lambda *_a, s=src, var=bal, lbl=blbl: (setattr(s, "bal", var.get() / 100), lbl.config(text=bal_text(var.get())))).pack(side="left", padx=2)
        blbl.pack(side="left", padx=(0, 6))

        inv = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="Ø фаза", variable=inv,
                        command=lambda s=src, var=inv: setattr(s, "inv", var.get())).pack(side="left", padx=6)

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

    def _build_eq(self):
        f = ttk.Frame(self.root, style="Panel.TFrame")
        f.pack(fill="x", padx=10, pady=4)

        hdr = ttk.Frame(f, style="Panel.TFrame")
        hdr.pack(fill="x", pady=(4, 0))
        ttk.Label(hdr, text="ЭКВАЛАЙЗЕР · 12 ПОЛОС", style="Head.TLabel").pack(side="left", padx=(6, 10))
        self.eq_btn = tk.Button(hdr, text="EQ ВЫКЛ", command=self._toggle_eq,
                                bg=PANEL, fg=SUB, activebackground=BD, activeforeground=FG,
                                relief="flat", bd=1, font=FONT_B, padx=16, pady=2, cursor="hand2")
        self.eq_btn.pack(side="left")
        ttk.Button(hdr, text="Сброс", command=self._eq_reset).pack(side="left", padx=8)
        self.eq_preset_mb = tk.Menubutton(hdr, text="Пресеты ▾", bg=PANEL, fg=FG,
                                          activebackground=BD, activeforeground=FG, relief="flat",
                                          bd=1, font=FONT, padx=10, pady=2, cursor="hand2")
        self.eq_preset_menu = tk.Menu(self.eq_preset_mb, tearoff=0, bg=PANEL, fg=FG, activebackground=ACC2)
        self.eq_preset_menu.configure(postcommand=self._eq_menu_post)
        self.eq_preset_mb["menu"] = self.eq_preset_menu
        self.eq_preset_mb.pack(side="left", padx=8)

        # effects row: name on top, on/off switch to the right of the name, slider + value below
        fx = ttk.Frame(f, style="Panel.TFrame")
        fx.pack(fill="x", pady=(6, 2))

        def mk(name, color, lo, hi, on_cmd, amt_cmd):
            col = ttk.Frame(fx, style="Panel.TFrame")
            col.pack(side="left", expand=True, fill="x", padx=10)
            top = ttk.Frame(col, style="Panel.TFrame")
            top.pack()
            ttk.Label(top, text=name, background=PANEL, foreground=color, font=FONT_B).pack(side="left")
            onv = tk.BooleanVar(value=False)
            ttk.Checkbutton(top, variable=onv, command=on_cmd).pack(side="left", padx=(6, 0))
            var = tk.DoubleVar(value=0)
            ttk.Scale(col, from_=lo, to=hi, variable=var, orient="horizontal", command=amt_cmd).pack(fill="x", pady=(2, 0))
            lbl = ttk.Label(col, text="0", background=PANEL, foreground=SUB)
            lbl.pack()
            return onv, var, lbl

        self.bass_onv, self.bass_var, self.bass_lbl = mk(
            "BASS", ACC, 0, 12,
            lambda: (setattr(self.engine, "bass_on", self.bass_onv.get()), self.engine.build_eq()),
            lambda v: (setattr(self.engine, "bass", self.bass_var.get()), self.engine.build_eq(),
                       self.bass_lbl.config(text=f"{int(self.bass_var.get())} dB")))
        self.spatial_onv, self.spatial_var, self.spatial_lbl = mk(
            "SPATIAL", ACC2, 0, 100,
            lambda: setattr(self.engine, "spatial_on", self.spatial_onv.get()),
            lambda v: (setattr(self.engine, "spatial", 1.0 + self.spatial_var.get() / 100.0),
                       self.spatial_lbl.config(text=f"{int(self.spatial_var.get())}%")))
        self.threeD_onv, self.threeD_var, self.threeD_lbl = mk(
            "3D", ACC, 0, 100,
            lambda: setattr(self.engine, "threeD_on", self.threeD_onv.get()),
            lambda v: (setattr(self.engine, "threeD", self.threeD_var.get() / 100.0),
                       self.threeD_lbl.config(text=f"{int(self.threeD_var.get())}%")))
        self.surround_onv, self.surround_var, self.surround_lbl = mk(
            "7.1 SURROUND", "#f78c6b", 0, 100,
            lambda: setattr(self.engine, "surround_on", self.surround_onv.get()),
            lambda v: (setattr(self.engine, "surround", self.surround_var.get() / 100.0),
                       self.surround_lbl.config(text=f"{int(self.surround_var.get())}%")))

        # bands: freq label + spectrum meter + vertical slider + fixed dB label
        band = ttk.Frame(f, style="Panel.TFrame")
        band.pack(fill="x", pady=(4, 6))
        self.eq_vars = []
        self.eq_lbls = []
        self.eq_meters = []
        for i, fr in enumerate(EQ_FREQS):
            col = ttk.Frame(band, style="Panel.TFrame")
            col.pack(side="left", expand=True, fill="x")
            ttk.Label(col, text=eq_flabel(fr), style="Sub.TLabel").pack()
            mid = ttk.Frame(col, style="Panel.TFrame")
            mid.pack()
            mtr = tk.Canvas(mid, width=7, height=130, bg=BD, highlightthickness=0)
            mtr.pack(side="left", padx=(0, 2))
            var = tk.DoubleVar(value=0)
            ttk.Scale(mid, from_=EQ_RANGE, to=-EQ_RANGE, orient="vertical", length=130, variable=var,
                      command=lambda v, i=i, var=var: self._on_eq(i, var)).pack(side="left")
            lb = ttk.Label(col, text="0", background=PANEL, foreground=FG, width=4, anchor="center")
            lb.pack()
            self.eq_vars.append(var)
            self.eq_lbls.append(lb)
            self.eq_meters.append(mtr)

    def _on_eq(self, i, var):
        v = var.get()
        self.engine.eq_gains[i] = float(v)
        self.engine.build_eq()
        n = int(round(v))
        self.eq_lbls[i].config(text=(f"{n:+d}" if n else "0"))

    # ── EQ presets ──
    def _eq_preset_path(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "eq_presets.json")

    def _load_eq_presets(self):
        try:
            with open(self._eq_preset_path(), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}

    def _save_eq_presets(self, d):
        try:
            with open(self._eq_preset_path(), "w", encoding="utf-8") as fh:
                json.dump(d, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def _eq_menu_post(self):
        m = self.eq_preset_menu
        m.delete(0, "end")
        names = list(self._load_eq_presets().keys())
        if names:
            for n in names:
                m.add_command(label=n, command=lambda nm=n: self._eq_apply_preset(nm))
        else:
            m.add_command(label="(нет пресетов)", state="disabled")
        m.add_separator()
        m.add_command(label="💾 Сохранить текущий…", command=self._eq_save_preset)
        if names:
            dm = tk.Menu(m, tearoff=0, bg=PANEL, fg=FG, activebackground=ACC2)
            for n in names:
                dm.add_command(label=n, command=lambda nm=n: self._eq_delete_preset(nm))
            m.add_cascade(label="🗑 Удалить", menu=dm)

    def _eq_save_preset(self):
        name = simpledialog.askstring("Пресет EQ", "Название пресета:", parent=self.root)
        if not name:
            return
        d = self._load_eq_presets()
        e = self.engine
        d[name] = {
            "gains": list(e.eq_gains),
            "bass_on": e.bass_on, "bass": e.bass,
            "spatial_on": e.spatial_on, "spatial": e.spatial,
            "threeD_on": e.threeD_on, "threeD": e.threeD,
            "surround_on": e.surround_on, "surround": e.surround,
        }
        self._save_eq_presets(d)

    def _eq_delete_preset(self, name):
        d = self._load_eq_presets()
        if name in d:
            del d[name]
            self._save_eq_presets(d)

    def _eq_apply_preset(self, name):
        p = self._load_eq_presets().get(name)
        if not p:
            return
        gains = p.get("gains", [0.0] * len(EQ_FREQS))
        for i, var in enumerate(self.eq_vars):
            g = gains[i] if i < len(gains) else 0.0
            var.set(g)
            self.engine.eq_gains[i] = float(g)
            n = int(round(g))
            self.eq_lbls[i].config(text=(f"{n:+d}" if n else "0"))
        e = self.engine
        bs = float(p.get("bass", 0.0)); e.bass = bs
        self.bass_var.set(bs); self.bass_lbl.config(text=f"{int(round(bs))} dB")
        e.bass_on = bool(p.get("bass_on", False)); self.bass_onv.set(e.bass_on)
        sp = float(p.get("spatial", 1.0)); e.spatial = sp
        self.spatial_var.set((sp - 1.0) * 100); self.spatial_lbl.config(text=f"{int(round((sp - 1.0) * 100))}%")
        e.spatial_on = bool(p.get("spatial_on", False)); self.spatial_onv.set(e.spatial_on)
        td = float(p.get("threeD", 0.0)); e.threeD = td
        self.threeD_var.set(td * 100); self.threeD_lbl.config(text=f"{int(round(td * 100))}%")
        e.threeD_on = bool(p.get("threeD_on", False)); self.threeD_onv.set(e.threeD_on)
        sr = float(p.get("surround", 0.0)); e.surround = sr
        self.surround_var.set(sr * 100); self.surround_lbl.config(text=f"{int(round(sr * 100))}%")
        e.surround_on = bool(p.get("surround_on", False)); self.surround_onv.set(e.surround_on)
        self.engine.build_eq()

    def _toggle_eq(self):
        self.engine.eq_on = not self.engine.eq_on
        if self.engine.eq_on:
            self.eq_btn.config(text="EQ ВКЛ", bg=ACC, fg="#06210f")
        else:
            self.eq_btn.config(text="EQ ВЫКЛ", bg=PANEL, fg=SUB)

    def _eq_reset(self):
        for i, var in enumerate(self.eq_vars):
            var.set(0)
            self.engine.eq_gains[i] = 0.0
            self.eq_lbls[i].config(text="0")
        self.engine.build_eq()

    def _set_run_btn(self, on):
        if on:
            self.start_btn.config(text="● ON", bg=ACC, fg="#06210f")
        else:
            self.start_btn.config(text="○ OFF", bg=PANEL, fg=SUB)

    def refresh_devices(self):
        # Stop streams first — terminating PortAudio with open streams hangs the app
        if self.engine.running:
            self.engine.stop()
            self._set_run_btn(False)
            self.status.config(text="остановлено")
        try:
            refresh_portaudio()
        except Exception:
            pass
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
            self._set_run_btn(False)
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
        self._set_run_btn(True)
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
        self._set_run_btn(True)
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
            self._set_run_btn(False)
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
        # EQ per-band spectrum bars (dB scale, balanced via tilt)
        sp = self.engine.spectrum
        self._spec_disp = np.maximum(sp, self._spec_disp * 0.8)
        span = SPEC_CEIL - SPEC_FLOOR
        for i, cv in enumerate(getattr(self, "eq_meters", [])):
            db = 20.0 * np.log10(self._spec_disp[i] + 1e-9)
            lvl = max(0.0, min(1.0, (db - SPEC_FLOOR) / span))
            cv.delete("all")
            h = cv.winfo_height() or 130
            w = cv.winfo_width() or 7
            bh = int(h * lvl)
            col = ACC if lvl < 0.8 else "#ffd166"
            cv.create_rectangle(0, h - bh, w, h, fill=col, width=0)
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
