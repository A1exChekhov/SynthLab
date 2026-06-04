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
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox, simpledialog

import numpy as np
import sounddevice as sd
from scipy.signal import sosfilt, butter, fftconvolve

try:
    import soundcard as _sc
    HAVE_LOOPBACK = True
except Exception:
    _sc = None
    HAVE_LOOPBACK = False


def make_chirp(dur=1.0, f0=120.0, f1=8000.0, sr=48000, amp=0.16):
    """Gentle log sweep (chirp) for latency calibration — quiet & non-piercing,
    still unique enough for robust cross-correlation against room noise."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    k = (f1 / f0) ** (1.0 / dur)
    phase = 2 * np.pi * f0 * ((k ** t - 1) / np.log(k))
    sig = np.sin(phase).astype(np.float32)
    fade = max(1, int(0.04 * sr))   # 40 ms fades — no harsh clicks
    w = np.ones(n, dtype=np.float32)
    w[:fade] = np.linspace(0, 1, fade)
    w[-fade:] = np.linspace(1, 0, fade)
    return (sig * w * amp).astype(np.float32)


def loopback_speakers():
    """Render-device names available for WASAPI loopback capture (no VB-CABLE needed)."""
    if not HAVE_LOOPBACK:
        return []
    try:
        return [s.name for s in _sc.all_speakers()]
    except Exception:
        return []

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


def mic_devices():
    """Input devices on safe host APIs only (WASAPI/MME) — WDM-KS often fails to open."""
    out = []
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and hostapi_name(d["hostapi"]) in ("Windows WASAPI", "MME"):
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
        self.inv = False   # invert phase of the RIGHT channel
        self.in_peakL = 0.0
        self.in_peakR = 0.0
        self.loopback = False   # capture system audio via WASAPI loopback (no VB-CABLE)
        self.lb_name = ""       # render-device name to loopback
        # runtime: one stereo queue per output speaker id
        self.queues = {}   # out_id -> queue.Queue
        self.bufs = {}     # out_id -> ndarray (n, 2)
        self.stream = None
        self._running = False
        self._thread = None


class OutputSpk:
    """One physical output speaker (or subwoofer) in the party rack."""
    _n = 0

    def __init__(self, idx, name):
        OutputSpk._n += 1
        self.id = OutputSpk._n
        self.idx = idx
        self.name = name
        self.bal = -1.0      # -1 = LEFT channel, 0 = mono, +1 = RIGHT channel
        self.vol = 1.0
        self.mute = False
        self.is_sub = False  # subwoofer => low-pass crossover (bass only)
        self.xover = 120.0   # crossover Hz for sub
        self.test_on = True
        self.peak = 0.0
        self.sos = None      # crossover sos
        self.stream = None
        self.delay_ms = 0.0          # latency-compensation delay
        self.delay_samples = 0

    def set_delay(self, ms):
        self.delay_ms = max(0.0, float(ms))
        self.delay_samples = int(round(self.delay_ms / 1000.0 * SR))

    def build_filter(self):
        if self.is_sub:
            fc = max(40.0, min(self.xover, SR / 2 - 1))
            self.sos = butter(4, fc / (SR / 2), btype="low", output="sos")
        else:
            self.sos = None


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
        self.outputs = []        # list[OutputSpk]
        self._spec_src = None    # output whose signal feeds the EQ spectrum

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

    def _pull(self, src, oid, frames):
        q = src.queues.get(oid)
        b = src.bufs.get(oid)
        if q is None or b is None:
            return np.zeros((frames, 2), dtype=np.float32)
        while b.shape[0] < frames:
            try:
                b = np.concatenate([b, q.get_nowait()])
            except queue.Empty:
                b = np.concatenate([b, np.zeros((frames - b.shape[0], 2), dtype=np.float32)])
                break
        block = b[:frames]
        src.bufs[oid] = b[frames:]
        return block  # (frames, 2)

    def _out_cb(self, out, tone_hz):
        state = {"eqzi": None, "xzi": None, "sp": {}, "ph": 0}

        def cb(outdata, frames, _t, _s):
            if self.test:
                if out.test_on:
                    tt = (state["ph"] + np.arange(frames)) / SR
                    state["ph"] += frames
                    mix = (0.2 * np.sin(2 * np.pi * tone_hz * tt)).astype(np.float32)
                else:
                    mix = np.zeros(frames, dtype=np.float32)
            else:
                sumL = np.zeros(frames, dtype=np.float32)
                sumR = np.zeros(frames, dtype=np.float32)
                for src in self.sources:
                    block = self._pull(src, out.id, frames)
                    if src.mute:
                        continue
                    lg, rg = lr_gains(src.bal)
                    v = src.vol
                    sumL = sumL + block[:, 0] * (v * lg)
                    sumR = sumR + (-block[:, 1] if src.inv else block[:, 1]) * (v * rg)
                sumL, sumR = self._apply_spatial(state["sp"], sumL, sumR, frames)
                b = out.bal
                mix = sumL * (0.5 - b * 0.5) + sumR * (0.5 + b * 0.5)
            # global EQ on full-range speakers only
            if not out.is_sub:
                sos = self.eq_sos
                if sos is not None and sos.shape[0] > 0:
                    if state["eqzi"] is None or state["eqzi"].shape[0] != sos.shape[0]:
                        state["eqzi"] = np.zeros((sos.shape[0], 2))
                    mix, state["eqzi"] = sosfilt(sos, mix, zi=state["eqzi"])
            # subwoofer crossover (low-pass)
            xs = out.sos
            if xs is not None:
                if state["xzi"] is None or state["xzi"].shape[0] != xs.shape[0]:
                    state["xzi"] = np.zeros((xs.shape[0], 2))
                mix, state["xzi"] = sosfilt(xs, mix, zi=state["xzi"])
            g = 0.0 if out.mute else out.vol
            mix = (mix * g * self.master).astype(np.float32)
            # per-output latency-compensation delay line
            dsamp = out.delay_samples
            if dsamp > 0:
                dly = state.get("dly")
                if dly is None or dly.shape[0] != dsamp:
                    dly = np.zeros(dsamp, dtype=np.float32)
                ext = np.concatenate([dly, mix])
                mix = ext[:frames].astype(np.float32)
                state["dly"] = ext[frames:]
            if out is self._spec_src:
                self._update_spectrum(mix)
            out.peak = float(np.max(np.abs(mix))) if mix.size else 0.0
            outdata[:] = np.repeat(mix.reshape(-1, 1), outdata.shape[1], axis=1)

        return cb

    def _loopback_worker(self, src):
        if _sc is None:
            return
        try:
            spk = None
            if src.lb_name:
                spk = next((d for d in _sc.all_speakers() if src.lb_name.lower() in d.name.lower()), None)
            if spk is None:
                spk = _sc.default_speaker()
            mic = _sc.get_microphone(spk.name, include_loopback=True)
            with mic.recorder(samplerate=SR, channels=2, blocksize=BLOCK) as rec:
                while src._running:
                    data = rec.record(numframes=BLOCK)
                    if data is None or len(data) == 0:
                        continue
                    if data.shape[1] >= 2:
                        blk = np.ascontiguousarray(data[:, :2], dtype=np.float32)
                    else:
                        mono = data[:, 0].astype(np.float32)
                        blk = np.column_stack([mono, mono])
                    src.in_peakL = float(np.max(np.abs(blk[:, 0]))) if blk.size else 0.0
                    src.in_peakR = float(np.max(np.abs(blk[:, 1]))) if blk.size else 0.0
                    for q in src.queues.values():
                        try:
                            q.put_nowait(blk)
                        except queue.Full:
                            try:
                                q.get_nowait(); q.put_nowait(blk)
                            except queue.Empty:
                                pass
        except Exception:
            pass

    def start(self, sources, outputs, test=False):
        self.stop()
        self.sources = sources
        self.outputs = outputs
        self.test = test
        self._spec_src = next((o for o in outputs if not o.is_sub), outputs[0] if outputs else None)
        for o in outputs:
            o.build_filter()
        streams = []
        try:
            if not test:
                for src in sources:
                    src.queues = {o.id: queue.Queue(MAXBUF) for o in outputs}
                    src.bufs = {o.id: np.zeros((0, 2), dtype=np.float32) for o in outputs}

                    if src.loopback:
                        src._running = True
                        src._thread = threading.Thread(target=self._loopback_worker, args=(src,), daemon=True)
                        src._thread.start()
                        continue

                    def make_in(s):
                        def in_cb(indata, frames, _t, _st):
                            if indata.shape[1] > 1:
                                blk = indata[:, :2].astype(np.float32).copy()
                            else:
                                mono = indata[:, 0].astype(np.float32)
                                blk = np.column_stack([mono, mono])
                            s.in_peakL = float(np.max(np.abs(blk[:, 0]))) if frames else 0.0
                            s.in_peakR = float(np.max(np.abs(blk[:, 1]))) if frames else 0.0
                            for q in s.queues.values():
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
            tones = [440.0, 660.0, 550.0, 330.0, 770.0, 220.0, 880.0, 494.0]
            for i, o in enumerate(outputs):
                o.stream = sd.OutputStream(device=o.idx, channels=2, samplerate=SR, blocksize=BLOCK,
                                           dtype="float32", callback=self._out_cb(o, tones[i % len(tones)]))
                streams.append(o.stream)
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
        for src in self.sources:
            src._running = False
        for s in self.streams:
            try:
                s.stop(); s.close()
            except Exception:
                pass
        for src in self.sources:
            if src._thread is not None:
                try:
                    src._thread.join(timeout=0.6)
                except Exception:
                    pass
                src._thread = None
            src.stream = None
        for o in self.outputs:
            o.stream = None
            o.peak = 0.0
        self.streams = []
        self.running = False


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
        self.outputs = []          # list[OutputSpk]
        self.out_rows = []         # list of output widget dicts
        self._calibrating = False
        self.out_devs = devices(True)
        self.in_devs = devices(False)
        self.mic_devs = mic_devices()
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
        self._dev_sig = self._device_sig()
        self._tick()
        self.root.after(4000, self._device_poll)

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

        # ── Outputs (party rack): dynamic list of speakers / subwoofers ──
        outhead = ttk.Frame(self.root)
        outhead.pack(fill="x", padx=10, pady=(6, 0))
        ttk.Label(outhead, text="ВЫХОДЫ — КОЛОНКИ", style="Head.TLabel").pack(side="left")
        ttk.Button(outhead, text="+ Колонка", command=lambda: self.add_output_row()).pack(side="right")

        self.out_container = ttk.Frame(self.root, style="Panel.TFrame")
        self.out_container.pack(fill="x", padx=10, pady=4)
        ohdr = ttk.Frame(self.out_container, style="Panel.TFrame")
        ohdr.pack(fill="x", padx=8, pady=(6, 0))
        for txt, w in (("Устройство", 24), ("Канал", 8), ("Громк.", 12), ("Саб / Кроссовер", 16), ("Задержка", 9), ("Тест", 6), ("Ур.", 8)):
            ttk.Label(ohdr, text=txt, style="Sub.TLabel", width=w, anchor="w").pack(side="left", padx=2)

        # ── Auto-calibration (latency alignment by microphone) ──
        calf = ttk.Frame(self.root, style="Panel.TFrame")
        calf.pack(fill="x", padx=10, pady=(0, 4))
        ttk.Label(calf, text="🎤 Калибровка задержек — микрофон:", background=PANEL, foreground=ACC).pack(side="left", padx=(8, 6))
        self.mic_cb = ttk.Combobox(calf, values=[l for _, l in self.mic_devs], state="readonly", width=30, font=FONT)
        self.mic_cb.pack(side="left", padx=2)
        self._select_mic_default()
        ttk.Button(calf, text="Калибровать", command=self.start_calibration).pack(side="left", padx=8)
        self.auto_cal_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(calf, text="Авто", variable=self.auto_cal_var, command=self._toggle_auto_cal).pack(side="left", padx=4)
        self.cal_status = ttk.Label(calf, text="результат калибровки появится здесь", background=PANEL, foreground=SUB)
        self.cal_status.pack(side="left", padx=10)

        # ── Sources ──
        srchead = ttk.Frame(self.root)
        srchead.pack(fill="x", padx=10, pady=(8, 0))
        ttk.Label(srchead, text="ИСТОЧНИКИ", style="Head.TLabel").pack(side="left")
        ttk.Button(srchead, text="+ Источник", command=lambda: self.add_source_row()).pack(side="right")
        if HAVE_LOOPBACK:
            ttk.Button(srchead, text="+ Системный звук", command=self.add_loopback_row).pack(side="right", padx=6)

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

        # defaults: one source + two speakers (Left/Right)
        self.add_source_row(default_sub="CABLE Output")
        self.add_output_row(default_sub="Bob", role="Левый")
        self.add_output_row(default_sub="JBL", role="Правый")

        # footer / license + developer
        ttk.Label(self.root,
                  text=f"© 2026 {BRAND}  ·  Channel Splitter v{APP_VERSION}  ·  разработчик: {DEVELOPER}  ·  все права защищены",
                  background=BG, foreground=SUB, font=("Segoe UI", 8)).pack(pady=(2, 4))

    ROLE_BAL = {"Левый": -1.0, "Моно": 0.0, "Правый": 1.0}

    def add_output_row(self, default_sub=None, role="Левый"):
        spk = OutputSpk(0, "")
        spk.bal = self.ROLE_BAL.get(role, -1.0)
        self.outputs.append(spk)
        row = ttk.Frame(self.out_container, style="Panel.TFrame")
        row.pack(fill="x", padx=8, pady=3)

        cb = ttk.Combobox(row, values=self._out_labels(), state="readonly", width=24, font=FONT)
        cb.pack(side="left", padx=2)
        if default_sub:
            self._select_default(cb, self.out_devs, default_sub)
        elif self.out_devs:
            cb.current(0)

        rolev = tk.StringVar(value=role)
        rcb = ttk.Combobox(row, values=list(self.ROLE_BAL.keys()), state="readonly", width=7, font=FONT, textvariable=rolev)
        rcb.pack(side="left", padx=2)
        rcb.bind("<<ComboboxSelected>>", lambda e, s=spk, var=rolev: setattr(s, "bal", self.ROLE_BAL[var.get()]))

        vol = tk.DoubleVar(value=100)
        ttk.Scale(row, from_=0, to=150, variable=vol, orient="horizontal", length=90,
                  command=lambda v, s=spk, var=vol: setattr(s, "vol", var.get() / 100)).pack(side="left", padx=2)

        subv = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="SUB", variable=subv,
                        command=lambda s=spk, var=subv: (setattr(s, "is_sub", var.get()), s.build_filter())).pack(side="left", padx=2)
        xv = tk.IntVar(value=120)
        ttk.Spinbox(row, from_=40, to=300, increment=10, width=5, textvariable=xv,
                    command=lambda s=spk, var=xv: (setattr(s, "xover", float(var.get())), s.build_filter())).pack(side="left", padx=2)
        ttk.Label(row, text="Гц", background=PANEL, foreground=SUB).pack(side="left")

        ttk.Label(row, text="↻мс", background=PANEL, foreground=SUB).pack(side="left", padx=(6, 0))
        dv = tk.IntVar(value=0)
        ttk.Spinbox(row, from_=0, to=500, increment=5, width=5, textvariable=dv,
                    command=lambda s=spk, var=dv: s.set_delay(var.get())).pack(side="left", padx=2)

        ttk.Button(row, text="🔊", width=3, command=lambda s=spk: self.test_output(s)).pack(side="left", padx=4)

        mtr = tk.Canvas(row, width=50, height=12, bg=BD, highlightthickness=0)
        mtr.pack(side="left", padx=4)

        ttk.Button(row, text="✕", width=2, command=lambda: self.remove_output(spk, row)).pack(side="left", padx=2)

        self.out_rows.append({"spk": spk, "cb": cb, "mtr": mtr, "delay_var": dv})

    def remove_output(self, spk, row):
        if spk in self.outputs:
            self.outputs.remove(spk)
        self.out_rows = [r for r in self.out_rows if r["spk"] is not spk]
        row.destroy()

    def _resolve_outputs(self):
        outs = []
        for r in self.out_rows:
            idx = self._combo_idx(r["cb"], self.out_devs)
            if idx is None:
                continue
            r["spk"].idx = idx
            r["spk"].name = r["cb"].get()
            outs.append(r["spk"])
        return outs

    def test_output(self, spk):
        outs = self._resolve_outputs()
        if not outs:
            messagebox.showerror("Splitter", "Добавь колонку.")
            return
        for o in outs:
            o.test_on = (o is spk)
        try:
            self.engine.start([], outs, test=True)
        except Exception as e:
            messagebox.showerror("Splitter", f"Ошибка теста:\n{e}")
            return
        self._set_run_btn(True)
        self.status.config(text=f"тест: {spk.name[:24]}")
        self._test_token += 1
        tok = self._test_token
        self.root.after(1800, lambda: self._auto_stop_test(tok))

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

    def add_loopback_row(self):
        self.add_source_row(loopback=True)

    def add_source_row(self, default_sub=None, loopback=False):
        src = Source(0, "")
        src.loopback = loopback
        self.sources.append(src)
        row = ttk.Frame(self.src_container, style="Panel.TFrame")
        row.pack(fill="x", padx=8, pady=3)

        if loopback:
            ttk.Label(row, text="🔊", background=PANEL, foreground=ACC).pack(side="left")
            names = loopback_speakers()
            cb = ttk.Combobox(row, values=names, state="readonly", width=22, font=FONT)
            cb.pack(side="left", padx=2)
            if names:
                cb.current(0)
        else:
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

        self.src_rows.append({"src": src, "cb": cb, "row": row, "loopback": loopback})

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

    def _device_sig(self):
        return tuple(l for _, l in self.out_devs) + ("|",) + tuple(l for _, l in self.in_devs)

    def _rebuild_combos(self):
        # update combobox lists, preserving each selection BY NAME (indices change after re-init)
        outlabels = self._out_labels()
        for r in self.out_rows:
            sel = r["cb"].get()
            r["cb"]["values"] = outlabels
            if sel in outlabels:
                r["cb"].set(sel)
        inlabels = self._in_labels()
        lbnames = loopback_speakers()
        for r in self.src_rows:
            sel = r["cb"].get()
            vals = lbnames if r.get("loopback") else inlabels
            r["cb"]["values"] = vals
            if sel in vals:
                r["cb"].set(sel)
        if hasattr(self, "mic_cb"):
            miclabels = [l for _, l in self.mic_devs]
            sel = self.mic_cb.get()
            self.mic_cb["values"] = miclabels
            if sel in miclabels:
                self.mic_cb.set(sel)
            elif miclabels and not sel:
                self._select_mic_default()

    def _reenumerate(self):
        try:
            refresh_portaudio()   # PortAudio re-inits to see hot-plugged (Bluetooth) devices
        except Exception:
            pass
        self.out_devs = devices(True)
        self.in_devs = devices(False)
        self.mic_devs = mic_devices()
        self._dev_sig = self._device_sig()
        self._rebuild_combos()

    def refresh_devices(self):
        # Stop streams first — terminating PortAudio with open streams hangs the app
        if self.engine.running:
            self.engine.stop()
            self._set_run_btn(False)
        self._reenumerate()
        self.status.config(text="устройства обновлены")

    def _device_poll(self):
        # Auto-detect hot-plugged devices (Bluetooth) without restarting the app.
        # PortAudio only sees new devices after re-init, so we re-init while stopped.
        # NEVER re-init during calibration — it would kill the calibration streams.
        if not self.engine.running and not getattr(self, "_calibrating", False):
            try:
                refresh_portaudio()
            except Exception:
                pass
            out = devices(True)
            inp = devices(False)
            sig = tuple(l for _, l in out) + ("|",) + tuple(l for _, l in inp)
            if sig != getattr(self, "_dev_sig", None):
                self._dev_sig = sig
                self.out_devs = out
                self.in_devs = inp
                self.mic_devs = mic_devices()
                self._rebuild_combos()
                self.status.config(text="🔄 список устройств обновлён")
        self.root.after(4000, self._device_poll)

    # ── Auto latency calibration (chirp + microphone + cross-correlation) ──
    def _select_mic_default(self):
        labels = [l for _, l in self.mic_devs]
        for k, l in enumerate(labels):
            if "microphone" in l.lower() or "микрофон" in l.lower():
                self.mic_cb.current(k)
                return
        if labels:
            self.mic_cb.current(0)

    def _toggle_auto_cal(self):
        # Auto re-calibration runs ONLY when this is checked. OFF by default → nothing in background.
        if self.auto_cal_var.get():
            self.cal_status.config(text="авто-подстройка ВКЛ (каждые 5 мин)")
            self.root.after(300000, self._auto_cal_tick)
        else:
            self.cal_status.config(text="авто-подстройка выкл")

    def _auto_cal_tick(self):
        if not self.auto_cal_var.get():
            return  # turned off — stop the loop, nothing in background
        if not self._calibrating:
            self.start_calibration()
        self.root.after(300000, self._auto_cal_tick)

    def start_calibration(self):
        if getattr(self, "_calibrating", False):
            return
        mic = self._combo_idx(self.mic_cb, self.mic_devs)
        if mic is None:
            messagebox.showerror("Калибровка", "Выбери микрофон.")
            return
        outs = self._resolve_outputs()
        if not outs:
            messagebox.showerror("Калибровка", "Добавь колонки.")
            return
        self._resume_after_cal = self.engine.running
        if self.engine.running:
            self.engine.stop()
            self._set_run_btn(False)
        amp = 0.16
        self._calibrating = True
        self.cal_status.config(text="идёт калибровка…")
        threading.Thread(target=self._calibrate_worker, args=(mic, outs, amp), daemon=True).start()

    def _set_cal_status(self, txt):
        self.root.after(0, lambda: self.cal_status.config(text=txt))

    def _calibrate_worker(self, mic_idx, outs, amp=0.16):
        inp = None
        out_streams = []
        try:
            time.sleep(0.3)  # devices settle after the engine stopped
            try:
                mic_sr = int(sd.query_devices(mic_idx).get("default_samplerate") or SR)
            except Exception:
                mic_sr = SR
            m = len(outs)
            lo, hi = 150.0, 7000.0
            edges = [lo * (hi / lo) ** (j / max(1, m)) for j in range(m + 1)]

            chirp_secs = 1.0
            slot = chirp_secs + 0.9                    # per-speaker window (chirp + latency/air margin)
            n_rec = int((m * slot + 1.2) * mic_sr)
            recbuf = np.zeros(n_rec, dtype=np.float32)
            ri = [0]

            def in_cb(indata, frames, _t, _s):
                k = min(frames, n_rec - ri[0])
                if k > 0:
                    recbuf[ri[0]:ri[0] + k] = indata[:k, 0]
                ri[0] += k

            # pre-open one output stream per speaker (warm => steady-state latency, no cold-start jitter)
            states = []

            def make_cb(st):
                def cb(outdata, frames, _t, _s):
                    if st["play"]:
                        ch = st["chirp"]; n = st["n"]; k = min(frames, n - st["pi"])
                        if k > 0:
                            outdata[:k] = ch[st["pi"]:st["pi"] + k]
                        if k < frames:
                            outdata[k:] = 0
                        st["pi"] += k
                        if st["pi"] >= n:
                            st["play"] = False
                    else:
                        outdata.fill(0)
                return cb

            for i, o in enumerate(outs):
                f0 = edges[i]; f1 = max(edges[i + 1], f0 * 2.0)
                try:
                    spk_sr = int(sd.query_devices(o.idx).get("default_samplerate") or SR)
                except Exception:
                    spk_sr = SR
                chirp = make_chirp(dur=chirp_secs, sr=spk_sr, amp=amp, f0=f0, f1=f1)
                st = {"play": False, "pi": 0, "chirp": np.column_stack([chirp, chirp]), "n": len(chirp),
                      "f0": f0, "f1": f1, "spk": o}
                states.append(st)
                out_streams.append(sd.OutputStream(device=o.idx, channels=2, samplerate=spk_sr,
                                                   blocksize=1024, dtype="float32", callback=make_cb(st)))

            inp = sd.InputStream(device=mic_idx, channels=1, samplerate=mic_sr, blocksize=1024, dtype="float32", callback=in_cb)
            inp.start()
            for os_ in out_streams:
                os_.start()
            time.sleep(0.6)  # warm up

            lat = {}
            for o, st in zip(outs, states):
                self._set_cal_status(f"замер: {o.name[:18]} ({int(st['f0'])}–{int(st['f1'])} Гц)…")
                corr_ref = make_chirp(dur=chirp_secs, sr=mic_sr, amp=1.0, f0=st["f0"], f1=st["f1"])
                cmd = ri[0]                # recording position at the trigger moment
                st["pi"] = 0; st["play"] = True
                time.sleep(slot)
                seg = recbuf[cmd:min(ri[0], n_rec)]
                if seg.size >= len(corr_ref):
                    corr = fftconvolve(seg, corr_ref[::-1], mode="full")
                    peak = int(np.argmax(np.abs(corr))) - (len(corr_ref) - 1)
                    lat[o.id] = max(0.0, peak / mic_sr)
                else:
                    lat[o.id] = 0.0

            try:
                inp.stop(); inp.close()
            except Exception:
                pass
            for os_ in out_streams:
                try:
                    os_.stop(); os_.close()
                except Exception:
                    pass

            mx = max(lat.values()) if lat else 0.0
            delays = {oid: max(0.0, (mx - l) * 1000.0) for oid, l in lat.items()}

            def apply():
                parts = []
                for r in self.out_rows:
                    if r["spk"].id in delays:
                        ms = int(round(delays[r["spk"].id]))
                        r["spk"].set_delay(ms)
                        r["delay_var"].set(ms)
                        nm = r["spk"].name.split(" (")[0][:10]
                        parts.append(f"{nm}: {ms}мс")
                self.cal_status.config(text=("✓ " + "   ".join(parts)) if parts else "✓ готово")
                self._calibrating = False
                if getattr(self, "_resume_after_cal", False):
                    self._resume_after_cal = False
                    self._start_playback()
            self.root.after(0, apply)
        except Exception as e:
            for st in ([inp] + out_streams):
                try:
                    if st is not None:
                        st.stop(); st.close()
                except Exception:
                    pass
            import traceback
            try:
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "calib_error.log"), "w", encoding="utf-8") as fh:
                    fh.write(traceback.format_exc())
            except Exception:
                pass
            msg = str(e)
            self._set_cal_status(f"ошибка: {msg[:60]}")
            self.root.after(0, lambda: messagebox.showerror("Калибровка", msg))
            self._calibrating = False

    def _calibrate_one(self, mic_idx, spk_idx, amp=0.16, f0=150.0, f1=6000.0):
        # Use each device's NATIVE sample rate (mics/BT speakers vary) to avoid open errors.
        try:
            spk_sr = int(sd.query_devices(spk_idx).get("default_samplerate") or SR)
        except Exception:
            spk_sr = SR
        try:
            mic_sr = int(sd.query_devices(mic_idx).get("default_samplerate") or SR)
        except Exception:
            mic_sr = SR

        play_ref = make_chirp(sr=spk_sr, amp=amp, f0=f0, f1=f1)
        corr_ref = make_chirp(sr=mic_sr, amp=1.0, f0=f0, f1=f1)
        nplay, ncorr = len(play_ref), len(corr_ref)
        rec_secs = ncorr / mic_sr + 0.6
        n_rec = int(rec_secs * mic_sr)
        recbuf = np.zeros(n_rec, dtype=np.float32)
        ri = [0]
        adc0 = [None]

        def in_cb(indata, frames, t, _s):
            if adc0[0] is None:
                try:
                    adc0[0] = float(t.inputBufferAdcTime)
                except Exception:
                    adc0[0] = None
            k = min(frames, n_rec - ri[0])
            if k > 0:
                recbuf[ri[0]:ri[0] + k] = indata[:k, 0]
            ri[0] += k

        stereo = np.column_stack([play_ref, play_ref])
        pi = [0]
        dac0 = [None]

        def out_cb(outdata, frames, t, _s):
            if dac0[0] is None:
                try:
                    dac0[0] = float(t.outputBufferDacTime)
                except Exception:
                    dac0[0] = None
            k = min(frames, nplay - pi[0])
            if k > 0:
                outdata[:k] = stereo[pi[0]:pi[0] + k]
            if k < frames:
                outdata[k:] = 0
            pi[0] += k

        inp = out = None
        last_err = None
        for _attempt in range(2):
            try:
                inp = sd.InputStream(device=mic_idx, channels=1, samplerate=mic_sr, blocksize=1024, dtype="float32", callback=in_cb)
                out = sd.OutputStream(device=spk_idx, channels=2, samplerate=spk_sr, blocksize=1024, dtype="float32", callback=out_cb)
                inp.start(); out.start()
                last_err = None
                break
            except Exception as e:
                last_err = e
                for st in (inp, out):
                    try:
                        if st is not None:
                            st.close()
                    except Exception:
                        pass
                inp = out = None
                time.sleep(0.4)
        if last_err is not None:
            raise RuntimeError(f"открытие потоков (mic sr={mic_sr}, spk sr={spk_sr}): {last_err}")
        time.sleep(rec_secs + 0.2)
        try:
            out.stop(); inp.stop(); out.close(); inp.close()
        except Exception:
            pass
        corr = fftconvolve(recbuf, corr_ref[::-1], mode="full")
        lag = int(np.argmax(np.abs(corr))) - (ncorr - 1)
        arrival_s = lag / mic_sr
        # Absolute latency via PortAudio DAC/ADC timestamps — immune to stream-start jitter
        if adc0[0] is not None and dac0[0] is not None:
            return max(0.0, (adc0[0] + arrival_s) - dac0[0])
        return max(0.0, arrival_s)

    def _resolve_sources(self):
        ok = []
        for r in self.src_rows:
            src = r["src"]
            if r.get("loopback"):
                src.lb_name = r["cb"].get()
                ok.append(src)
            else:
                idx = self._combo_idx(r["cb"], self.in_devs)
                if idx is None:
                    continue
                src.idx = idx
                src.name = r["cb"].get()
                ok.append(src)
        return ok

    def toggle(self):
        self._test_token += 1  # cancel any pending test auto-stop
        if self.engine.running:
            self.engine.stop()
            self._set_run_btn(False)
            self.status.config(text="остановлено")
            return
        self._start_playback()

    def _start_playback(self):
        outs = self._resolve_outputs()
        if not outs:
            messagebox.showerror("Splitter", "Добавь хотя бы одну колонку.")
            return
        srcs = self._resolve_sources()
        if not srcs:
            messagebox.showerror("Splitter", "Добавь хотя бы один источник.")
            return
        for o in outs:
            o.test_on = True
        try:
            self.engine.start(srcs, outs, test=False)
        except Exception as e:
            messagebox.showerror("Splitter", f"Не удалось запустить:\n{e}\n\nПопробуй другое устройство или ⟳ Устройства.")
            return
        self._set_run_btn(True)
        self.status.config(text="играет")

    def _auto_stop_test(self, tok):
        if tok == self._test_token and self.engine.running and self.engine.test:
            self.engine.stop()
            self._set_run_btn(False)
            self.status.config(text="остановлено")

    def _tick(self):
        # per-output level meters (one bar per speaker row)
        for r in self.out_rows:
            cv = r["mtr"]
            lvl = min(1.0, r["spk"].peak * 1.3)
            cv.delete("all")
            w = cv.winfo_width() or 50
            h = cv.winfo_height() or 12
            col = ACC if lvl < 0.8 else ("#ffd166" if lvl < 0.95 else RED)
            cv.create_rectangle(0, 0, int(w * lvl), h, fill=col, width=0)
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
