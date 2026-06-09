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

import colorsys
import json
import math
import os
import queue
import random
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

try:
    import moderngl as _mgl
    import glfw as _glfw
    HAVE_GPU = True
except Exception:
    _mgl = None
    _glfw = None
    HAVE_GPU = False


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
CAL_CAP = 48000 * 2  # 2 c кольцевой буфер выхода (для HOLD-автоподстройки)
BLOCK = 960          # ~20 ms blocks — fewer glitches with Bluetooth
MAXBUF = 60          # deeper ring buffer to absorb clock drift
RS_TARGET = 24 * BLOCK  # целевое заполнение буфера выхода (сэмплы): глубоко — запас на джиттер BT
RS_MINFILL = 6 * BLOCK  # ниже этого буфер опасно мелок — НЕ ускоряем потребление (чтобы не рвать)
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


def user_data_dir():
    """Стабильная пользовательская папка для пресетов/настроек.
    Переживает обновления и переустановки (не лежит в каталоге программы)."""
    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME") \
        or os.path.join(os.path.expanduser("~"), ".config")
    d = os.path.join(base, "Errarium", "ChannelSplitter")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


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
        self.radio = False      # интернет-радио (Tuner) как источник
        self.radio_url = ""     # поток выбранной станции
        # реальный формат источника (пишется движком при старте/работе)
        self.fmt_rate = 0.0
        self.fmt_ch = 0
        self.fmt_codec = ""
        self.fmt_kbps = 0
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
        self.stereo = False  # True = полноценный стерео-выход (наушники): L→L, R→R
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
        self.inv = False             # phase invert (fix anti-phase between speakers)
        self.cal_ring = None         # кольцевой буфер выхода для HOLD
        self.cal_w = 0

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
        self._t0 = 0.0          # момент старта — для плавного fade-in
        self._fade_dur = 0.6    # сек: защита от громкого звука при включении
        self.cal_capture = False  # пишем ли выход в кольцевые буферы (для HOLD)
        # интернет-радио (Tuner)
        self.radio_title = ""
        self.radio_paused = False
        self.radio_stopped = False
        self.radio_kbps = 0
        # EQ + effects (each effect has its own on/off)
        self.eq_on = False
        self.eq_gains = [0.0] * len(EQ_FREQS)
        self.bass_on = False; self.bass = 0.0          # low-shelf 110 Hz (Bass Boost)
        self.spatial_on = False; self.spatial = 1.0    # stereo width factor (1..2)
        self.threeD_on = False; self.threeD = 0.0      # 3D depth 0..1 (crossfeed/Haas)
        self.surround_on = False; self.surround = 0.0  # pseudo 7.1 surround 0..1 (early reflections)
        # ── premium FX (all neutral / off by default → звук не меняется) ──
        self.monobass_on = False; self.monobass_hz = 120.0   # bass below Hz → mono
        self.pos_on = False; self.pan = 0.0; self.distance = 0.0  # 2D position pad
        self.tone_on = False; self.tilt = 0.0; self.drive = 0.0   # 2D tone pad
        self.reverb_on = False; self.reverb_size = 0.5; self.reverb_mix = 0.22
        self.comp_on = False; self.comp_thresh = -18.0; self.comp_ratio = 2.5
        self._rv_combs = [1187, 1289, 1399, 1511]   # comb delays (all > BLOCK)
        self._rv_aps = [1051, 1213]                 # all-pass delays (all > BLOCK)
        self._mb_sos = None
        self._dist_sos = None
        self._spat_maxd = int(SR * 0.08) + 1
        self.spectrum = np.zeros(len(EQ_FREQS), dtype=np.float64)
        # ── live analysis for the colour-music visualizer ──
        self.VIZ_N = 64
        self._viz_edges = np.geomspace(30.0, 16000.0, self.VIZ_N + 1)
        self.viz_bands = np.zeros(self.VIZ_N, dtype=np.float64)  # smoothed magnitudes 0..1
        self.viz_level = 0.0       # overall RMS 0..1
        self.viz_centroid = 0.5    # spectral centroid (log) 0..1  (низкий→0, высокий→1)
        self.viz_bass = 0.0
        self.viz_mid = 0.0
        self.viz_treble = 0.0
        self.viz_beat = 0.0        # set to 1.0 on a detected beat, decays in UI
        self._viz_bass_avg = 1e-4
        self.VIZ_W = 512
        self.viz_wave = np.full(self.VIZ_W, 0.5, dtype=np.float32)  # осциллограмма 0..1
        self._ana_buf = np.zeros(4096, dtype=np.float64)            # скользящий буфер FFT
        self._ana_win = np.hanning(4096)
        # пользовательский стиль цветомузыки (читается GPU-движком вживую)
        self.viz_cfg = {
            "color_mode": 0,    # 0=Цвет, 1=Ч/Б, 2=Монотон
            "mono_hue": 0.55,   # оттенок для монотона (0..1)
            "saturation": 1.0,  # 0..1.3
            "decay": 0.955,     # тягучесть/шлейфы 0.90..0.992
            "speed": 1.0,       # скорость движения 0.2..2.5
            "warp": 1.0,        # искажение/зум 0..2
            "swirl": 1.0,       # вихрь 0..2
            "bloom": 0.12,      # свечение 0..0.4
            "gain": 1.0,        # яркость линий 0.3..2
            "linew": 1.0,       # толщина линий 0.4..2 (тоньше=эстетичнее)
            "react": 1.0,       # чувствительность к звуку 0.3..2
            "bursts": 1.0,      # всплески/лучи/вспышки 0..1
        }
        self.eq_sos = None
        self.build_eq()
        self.build_monobass()
        self.outputs = []        # list[OutputSpk]
        self._spec_src = None    # output whose signal feeds the EQ spectrum
        self.failed_outputs = []

    def build_eq(self):
        rows = []
        if self.eq_on:
            rows += [_peaking_sos(f, EQ_Q, g, SR) for f, g in zip(EQ_FREQS, self.eq_gains)]
        if self.bass_on and self.bass > 0:
            rows.append(_lowshelf_sos(110.0, self.bass, SR))
        if self.tone_on and self.tilt != 0.0:
            # tilt: <0 = тепло (бас↑/верх↓), >0 = ярко (бас↓/верх↑)
            t = max(-1.0, min(1.0, self.tilt))
            rows.append(_lowshelf_sos(180.0, -t * 6.0, SR))
            rows.append(_highshelf_sos(4500.0, t * 6.0, SR))
        self.eq_sos = np.array(rows, dtype=np.float64) if rows else None

    def build_monobass(self):
        fc = max(40.0, min(self.monobass_hz, 400.0))
        self._mb_sos = butter(2, fc / (SR / 2), btype="low", output="sos")

    def set_distance(self, d):
        self.distance = max(0.0, min(1.0, float(d)))
        if self.distance > 0.001:
            fc = max(1400.0, 20000.0 * (1.0 - 0.9 * self.distance))
            self._dist_sos = butter(2, min(fc, SR / 2 - 1) / (SR / 2), btype="low", output="sos")
        else:
            self._dist_sos = None

    def _reverb(self, st, x, frames):
        """Block-wise Schroeder reverb (4 combs → 2 all-pass). All delays > frames."""
        combs = self._rv_combs
        aps = self._rv_aps
        if frames > min(combs + aps):
            return x  # огромный блок — пропускаем (страховка)
        g = 0.70 + 0.22 * max(0.0, min(1.0, self.reverb_size))
        rv = st.get("rv")
        if rv is None:
            rv = {"c": [np.zeros(d, dtype=np.float32) for d in combs],
                  "ax": [np.zeros(d, dtype=np.float32) for d in aps],
                  "ay": [np.zeros(d, dtype=np.float32) for d in aps]}
            st["rv"] = rv
        acc = np.zeros(frames, dtype=np.float32)
        for k, D in enumerate(combs):
            hist = rv["c"][k]
            y = x + g * hist[:frames]               # y[n] = x[n] + g·y[n-D]
            rv["c"][k] = np.concatenate([hist, y])[-D:]
            acc += y
        acc *= (1.0 / len(combs))
        ga = 0.5
        out = acc
        for k, D in enumerate(aps):
            xh = rv["ax"][k]; yh = rv["ay"][k]
            y = -ga * out + xh[:frames] + ga * yh[:frames]
            rv["ax"][k] = np.concatenate([xh, out])[-D:]
            rv["ay"][k] = np.concatenate([yh, y])[-D:]
            out = y
        return out.astype(np.float32)

    def _compress(self, st, x, frames):
        """Gentle block-rate bus compressor + soft limiter ceiling."""
        pk = float(np.max(np.abs(x))) if x.size else 0.0
        lvl = 20.0 * math.log10(pk + 1e-6)
        th = self.comp_thresh
        ratio = max(1.1, self.comp_ratio)
        over = lvl - th
        gr = over * (1.0 / ratio - 1.0) if over > 0 else 0.0      # dB (<=0)
        makeup = -th * (1.0 - 1.0 / ratio) * 0.5                  # auto makeup
        target = 10.0 ** ((gr + makeup) / 20.0)
        prev = st.get("cg", 1.0)
        a = 0.45 if target < prev else 0.12                       # fast attack / slow release
        g = prev + (target - prev) * a
        st["cg"] = g
        ramp = np.linspace(prev, g, frames, dtype=np.float32)
        y = x * ramp
        c = 0.98                                                  # soft limiter ceiling
        return (c * np.tanh(y / c)).astype(np.float32)

    def _apply_spatial(self, st, sumL, sumR, frames):
        if not (self.spatial_on or self.threeD_on or self.surround_on
                or self.monobass_on or self.pos_on):
            return sumL, sumR
        # mono-bass: ниже частоты бас → моно (плотнее, не «гуляет» между колонками)
        if self.monobass_on and self._mb_sos is not None:
            if st.get("mbL") is None or st["mbL"].shape[0] != self._mb_sos.shape[0]:
                st["mbL"] = np.zeros((self._mb_sos.shape[0], 2))
                st["mbR"] = np.zeros((self._mb_sos.shape[0], 2))
            lowL, st["mbL"] = sosfilt(self._mb_sos, sumL, zi=st["mbL"])
            lowR, st["mbR"] = sosfilt(self._mb_sos, sumR, zi=st["mbR"])
            lowM = (lowL + lowR) * 0.5
            sumL = (sumL - lowL) + lowM
            sumR = (sumR - lowR) + lowM
            sumL = sumL.astype(np.float32); sumR = sumR.astype(np.float32)
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
        # 2D POSITION: equal-power pan (X) + distance level (Y)
        if self.pos_on:
            theta = (max(-1.0, min(1.0, self.pan)) + 1.0) * 0.25 * math.pi
            gL = math.cos(theta) * 1.41421356
            gR = math.sin(theta) * 1.41421356
            outL = outL * gL
            outR = outR * gR
            if self.distance > 0.001:
                lvl = 1.0 - 0.6 * self.distance
                outL = outL * lvl
                outR = outR * lvl
        st["tL"] = extL[-MAXD:]
        st["tR"] = extR[-MAXD:]
        return outL.astype(np.float32), outR.astype(np.float32)

    def _update_spectrum(self, x):
        n = x.shape[0]
        if n < 16:
            return
        # скользящий буфер → высокое разрешение по низким частотам (≈12 Гц/бин),
        # иначе на лог-шкале низкие полосы уже бина и зияют промежутками
        buf = self._ana_buf
        N = buf.shape[0]
        if n >= N:
            buf[:] = x[-N:]
        else:
            buf[:-n] = buf[n:]
            buf[-n:] = x
        mag = np.abs(np.fft.rfft(buf * self._ana_win)) / (N * 0.5)
        freqs = np.fft.rfftfreq(N, 1.0 / SR)
        sp = self.spectrum
        for i, (lo, hi) in enumerate(EQ_EDGES):
            m = (freqs >= lo) & (freqs < hi)
            sp[i] = (float(mag[m].mean()) * EQ_TILT[i]) if m.any() else 0.0
        self._update_viz(buf, mag, freqs)

    def _update_viz(self, x, mag, freqs):
        """High-resolution features for the colour-music visualizer."""
        # log-spaced band magnitudes via reduceat (fast)
        idx = np.clip(np.searchsorted(freqs, self._viz_edges), 0, len(mag))
        N = self.VIZ_N
        bands = np.zeros(N, dtype=np.float64)
        for i in range(N):
            a, b = idx[i], idx[i + 1]
            if b > a:
                bands[i] = mag[a:b].mean()
        # perceptual lift (AGC в UI приведёт к полному размаху)
        bands = np.sqrt(bands) * 6.0
        prev = self.viz_bands
        # very fast attack, slow release → резко и живо
        self.viz_bands = np.where(bands > prev, bands, prev * 0.86 + bands * 0.14)
        # overall level
        rms = float(np.sqrt(np.mean(x * x))) if x.size else 0.0
        self.viz_level = rms
        # spectral centroid (log-normalized 0..1)
        msum = float(mag.sum()) + 1e-9
        cen = float((freqs * mag).sum()) / msum
        cen = max(40.0, min(cen, 16000.0))
        self.viz_centroid = (math.log2(cen / 40.0)) / math.log2(16000.0 / 40.0)
        # band energies
        bass = float(mag[freqs < 160].mean()) if (freqs < 160).any() else 0.0
        midm = (freqs >= 160) & (freqs < 2000)
        treb = freqs >= 2000
        self.viz_mid = float(mag[midm].mean()) if midm.any() else 0.0
        self.viz_treble = float(mag[treb].mean()) if treb.any() else 0.0
        self.viz_bass = bass
        # beat detection on bass energy (чувствительнее)
        avg = self._viz_bass_avg
        self._viz_bass_avg = 0.95 * avg + 0.05 * bass
        if bass > avg * 1.28 and bass > 0.0025:
            self.viz_beat = 1.0
        # waveform (осциллоскоп) — даунсемпл к VIZ_W, нормализуем 0..1
        W = self.VIZ_W
        n = x.shape[0]
        if n >= W:
            wv = x[:(n // W) * W:(n // W)][:W]
        else:
            wv = np.interp(np.linspace(0, 1, W), np.linspace(0, 1, n), x) if n > 1 else np.zeros(W)
        self.viz_wave = (np.clip(wv * 4.0, -1.0, 1.0) * 0.5 + 0.5).astype(np.float32)

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

    def _chain(self, out, st, x, frames, ck):
        """Полная обработка одного канала (EQ → FX → кроссовер → громк. → фаза → задержка).
        ck — ключ канала ('m' для моно, 'L'/'R' для стерео) — чтобы у каждого
        канала было своё состояние фильтров."""
        if not out.is_sub:
            sos = self.eq_sos
            if sos is not None and sos.shape[0] > 0:
                k = "eqzi_" + ck
                if st.get(k) is None or st[k].shape[0] != sos.shape[0]:
                    st[k] = np.zeros((sos.shape[0], 2))
                x, st[k] = sosfilt(sos, x, zi=st[k])
            if self.tone_on and self.drive > 0:
                d = 1.0 + self.drive * 4.0
                x = (np.tanh(x * d) / math.tanh(d)).astype(np.float32)
            if self.pos_on and self._dist_sos is not None:
                k = "dz_" + ck
                if st.get(k) is None or st[k].shape[0] != self._dist_sos.shape[0]:
                    st[k] = np.zeros((self._dist_sos.shape[0], 2))
                x, st[k] = sosfilt(self._dist_sos, x, zi=st[k])
                x = x.astype(np.float32)
            if self.reverb_on and self.reverb_mix > 0:
                wet = self._reverb(st.setdefault("rv_" + ck, {}), x, frames)
                m = self.reverb_mix
                x = (x * (1.0 - m) + wet * m).astype(np.float32)
            if self.comp_on:
                x = self._compress(st.setdefault("cmp_" + ck, {}), x, frames)
        xs = out.sos
        if xs is not None:
            k = "xzi_" + ck
            if st.get(k) is None or st[k].shape[0] != xs.shape[0]:
                st[k] = np.zeros((xs.shape[0], 2))
            x, st[k] = sosfilt(xs, x, zi=st[k])
        g = 0.0 if out.mute else out.vol
        x = (x * g * self.master * self._fadeval()).astype(np.float32)
        if out.inv:
            x = -x
        dsamp = out.delay_samples
        if dsamp > 0:
            k = "dly_" + ck
            dly = st.get(k)
            if dly is None or dly.shape[0] != dsamp:
                dly = np.zeros(dsamp, dtype=np.float32)
            ext = np.concatenate([dly, x])
            x = ext[:frames].astype(np.float32)
            st[k] = ext[frames:]
        return x

    def _cap(self, out, sig):
        """Записать выходной сигнал колонки в кольцевой буфер (для HOLD)."""
        cr = out.cal_ring
        if cr is None or cr.shape[0] != CAL_CAP:
            cr = np.zeros(CAL_CAP, dtype=np.float32); out.cal_ring = cr; out.cal_w = 0
        n = sig.shape[0]
        if n >= CAL_CAP:
            cr[:] = sig[-CAL_CAP:]; out.cal_w = 0
            return
        w = out.cal_w; end = w + n
        if end <= CAL_CAP:
            cr[w:end] = sig
        else:
            k = CAL_CAP - w; cr[w:] = sig[:k]; cr[:end - CAL_CAP] = sig[k:]
        out.cal_w = end % CAL_CAP

    def cal_snapshot(self, out):
        cr = out.cal_ring
        if cr is None:
            return None
        w = out.cal_w
        return np.concatenate([cr[w:], cr[:w]])

    def _out_cb(self, out, tone_hz):
        state = {"sp": {}, "ph": 0}

        def cb(outdata, frames, _t, _s):
            nch = outdata.shape[1]
            if self.test:
                if out.test_on:
                    tt = (state["ph"] + np.arange(frames)) / SR
                    state["ph"] += frames
                    sumL = sumR = (0.2 * np.sin(2 * np.pi * tone_hz * tt)).astype(np.float32)
                else:
                    sumL = sumR = np.zeros(frames, dtype=np.float32)
            else:
                # Простой гладкий тракт: берём ровно frames из глубокого буфера.
                # (Поблочный дрейф-ресемплинг убран — он давал разрывы на стыках блоков
                #  и «рваный» звук на BT. Дрейф колонок компенсируется задержкой/HOLD.)
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

            # Цветомузыка анализирует сигнал ДО громкости/мастера — иначе при низком
            # master почти не реагирует. Берём предусиленный микс источников.
            if out is self._spec_src:
                self._update_spectrum(((sumL + sumR) * 0.5).astype(np.float32))

            if out.stereo and not out.is_sub:
                # полноценный стерео-выход (наушники): L→L, R→R, эффекты по каналам
                L = self._chain(out, state, sumL, frames, "L")
                R = self._chain(out, state, sumR, frames, "R")
                if self.cal_capture:
                    self._cap(out, ((L + R) * 0.5).astype(np.float32))
                out.peak = float(max(np.max(np.abs(L)) if L.size else 0.0,
                                     np.max(np.abs(R)) if R.size else 0.0))
                for c in range(nch):
                    outdata[:, c] = L if (c % 2 == 0) else R
            else:
                b = out.bal
                mix = sumL * (0.5 - b * 0.5) + sumR * (0.5 + b * 0.5)
                mix = self._chain(out, state, mix, frames, "m")
                if self.cal_capture:
                    self._cap(out, mix)
                out.peak = float(np.max(np.abs(mix))) if mix.size else 0.0
                outdata[:] = np.repeat(mix.reshape(-1, 1), nch, axis=1)

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

    def _radio_worker(self, src):
        """Интернет-радио: тянем поток по URL, декодируем в 48k стерео float32 и
        кладём блоки в очереди выходов (как loopback). Заголовок трека — из ICY."""
        try:
            import miniaudio
        except Exception:
            self.radio_stopped = True
            src.fmt_codec = "no decoder"
            return
        client = None
        try:
            def on_title(_c, title):
                self.radio_title = (title or "").strip()
            try:
                import ssl as _ssl
                sslctx = _ssl.create_default_context() if src.radio_url.lower().startswith("https") else None
            except Exception:
                sslctx = None
            try:
                client = miniaudio.IceCastClient(src.radio_url, update_stream_title=on_title, ssl_context=sslctx)
            except Exception:
                client = miniaudio.IceCastClient(src.radio_url)
            # реальные частота/каналы источника — зондируем ОТДЕЛЬНЫМ коротким соединением
            # (чтение из основного «съело» бы заголовок OGG/WAV)
            pc = None
            try:
                pc = miniaudio.IceCastClient(src.radio_url, ssl_context=sslctx)
                di = miniaudio.decode(bytes(pc.read(64000)))
                src.fmt_rate = float(di.sample_rate); src.fmt_ch = int(di.nchannels)
            except Exception:
                src.fmt_rate = 44100.0; src.fmt_ch = 2
            finally:
                if pc is not None:
                    try:
                        pc.close()
                    except Exception:
                        pass
            if not src.fmt_codec:
                try:
                    src.fmt_codec = getattr(client, "audio_format", None).name
                except Exception:
                    src.fmt_codec = "STREAM"
            self.radio_kbps = int(getattr(src, "fmt_kbps", 0) or 0)
            stream = miniaudio.stream_any(
                client, source_format=miniaudio.FileFormat.UNKNOWN,
                output_format=miniaudio.SampleFormat.FLOAT32,
                nchannels=2, sample_rate=int(SR), frames_to_read=BLOCK)
            next(stream)   # prime
            silence = np.zeros((BLOCK, 2), dtype=np.float32)
            # выходим и по сбросу _running, и при снятии флага radio (eject/смена источника):
            # _running переиспользуется при перезапуске на loopback, поэтому проверяем оба
            while src._running and getattr(src, "radio", False):
                if self.radio_paused:
                    blk = silence
                else:
                    chunk = stream.send(BLOCK)
                    arr = np.frombuffer(memoryview(chunk), dtype=np.float32)
                    if arr.size < 2:
                        continue
                    blk = np.ascontiguousarray(arr.reshape(-1, 2))
                    src.in_peakL = float(np.max(np.abs(blk[:, 0]))) if blk.size else 0.0
                    src.in_peakR = float(np.max(np.abs(blk[:, 1]))) if blk.size else 0.0
                # Backpressure: miniaudio декодирует БЫСТРЕЕ реального времени (буферизует сеть),
                # поэтому пишем БЛОКИРУЮЩЕ — продюсер пасуется под темп выхода (реальное время),
                # без выброса блоков (выброс давал периодические пропуски — «волны»).
                for q in list(src.queues.values()):
                    try:
                        q.put(blk, timeout=0.5)
                    except queue.Full:
                        pass   # выход подвис >0.5с — пропускаем блок для него, но не дропаем поток
        except Exception:
            pass
        finally:
            self.radio_stopped = True
            try:
                if client is not None:
                    client.close()
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

                    if getattr(src, "radio", False) and src.radio_url:
                        self.radio_stopped = False; self.radio_paused = False; self.radio_title = ""
                        src._running = True
                        src._thread = threading.Thread(target=self._radio_worker, args=(src,), daemon=True)
                        src._thread.start()
                        continue

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
            # start input/capture streams first (these must succeed)
            for s in streams:
                s.start()
            # open each output tolerantly — one bad/unavailable speaker must not kill the rest
            tones = [440.0, 660.0, 550.0, 330.0, 770.0, 220.0, 880.0, 494.0]
            self.failed_outputs = []
            started = []
            for i, o in enumerate(outputs):
                o.stream = None
                try:
                    o.stream = sd.OutputStream(device=o.idx, channels=2, samplerate=SR, blocksize=BLOCK,
                                               latency="high",   # глубокий буфер: BT не рвёт при нагрузке/джиттере
                                               dtype="float32", callback=self._out_cb(o, tones[i % len(tones)]))
                    o.stream.start()
                    streams.append(o.stream)
                    started.append(o)
                except Exception as ex:
                    self.failed_outputs.append((o.name, str(ex)))
                    try:
                        if o.stream is not None:
                            o.stream.close()
                    except Exception:
                        pass
                    o.stream = None
            if not started:
                raise RuntimeError("Не удалось открыть ни одну колонку: " +
                                   "; ".join(f"{n}: {e[:60]}" for n, e in self.failed_outputs))
            self.outputs = started
            if self._spec_src not in started:
                self._spec_src = next((o for o in started if not o.is_sub), started[0])
        except Exception as e:
            for src in self.sources:
                src._running = False
            for s in streams:
                try:
                    s.stop(); s.close()
                except Exception:
                    pass
            raise e
        self.streams = streams
        self._t0 = time.perf_counter()   # запустить fade-in (мягкий старт)
        self.running = True

    def _fadeval(self):
        """Плавный разгон громкости 0→1 при включении (ease-in) — защита от громкого старта."""
        d = self._fade_dur
        if d <= 0:
            return 1.0
        f = (time.perf_counter() - self._t0) / d
        if f <= 0.0:
            return 0.0
        if f >= 1.0:
            return 1.0
        return f * f

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

# ── премиальная тема Studio (графит + неон) ──
BG = "#0e1115"     # глубокий графит (фон)
PANEL = "#171b21"  # карточка/панель (светлее фона → объём)
CARD = "#1d232b"   # приподнятый элемент (кнопки/инпуты)
FG = "#e9eef3"     # основной текст
SUB = "#79838f"    # вторичный текст
BD = "#2b323c"     # тонкая линия / трек слайдера
ACC = "#2dd36f"    # неон-зелёный (основной акцент)
ACC2 = "#19c3d6"   # неон-циан (второй акцент)
RED = "#ff5d6c"
FONT = ("Segoe UI", 10)
FONT_B = ("Segoe UI", 11, "bold")
FONT_H = ("Segoe UI Semibold", 12)
FONT_MONO = ("Consolas", 10)

APP_VERSION = "1.4"
BRAND = "Errarium™"
DEVELOPER = "Errarium"


_VIZ_VS = """#version 330
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }
"""

# ── feedback shader (техника MilkDrop/Geiss/AVS) ──
# Каждый кадр = предыдущий, искажённый (зум+поворот+свирл) и затухающий,
# плюс новая осциллограмма, спектр-всплески и вспышка на бите.
_FB_FS = """#version 330
uniform vec2 res;
uniform float time, level, bass, treble, cen, beat;
uniform int preset;
uniform int color_mode;
uniform float mono_hue, saturation, decay, speed, warp, swirl,
              gain, linew, react, bursts;
uniform sampler2D prev;     // предыдущий кадр
uniform sampler2D bands;    // спектр (64)
uniform sampler2D wave;     // осциллограмма (512), 0..1
out vec4 fragColor;

vec3 hsv(float h,float s,float v){ vec3 k=vec3(1.0,2.0/3.0,1.0/3.0);
  vec3 q=abs(fract(vec3(h)+k)*6.0-3.0); return v*mix(vec3(1.0),clamp(q-1.0,0.0,1.0),s); }
float spec(float x){ return texture(bands, vec2(clamp(x,0.0,1.0),0.5)).r; }
float wav(float x){ return texture(wave, vec2(clamp(x,0.0,1.0),0.5)).r*2.0-1.0; }

vec3 tint(float inten, float ang, float t){
  if(color_mode==1) return vec3(inten);                              // Ч/Б
  if(color_mode==2) return hsv(mono_hue, saturation, 1.0)*inten;     // Монотон
  return hsv(fract(t*0.05*speed + ang/6.2831 + 0.2*cen), saturation, 1.0)*inten;
}

void main(){
  float asp = res.x/res.y;
  vec2 uv = gl_FragCoord.xy/res;
  vec2 c  = uv-0.5; c.x*=asp;
  float r = length(c);
  float ang = atan(c.y,c.x);
  float t = time;
  vec3 col;

  if(preset<=2){
    // ── ЦЕНТРОВЫЕ режимы (тоннель/вихрь) ──
    float zoom, rot, sw;
    if(preset==0){ zoom = 1.0 - (0.018 + 0.05*bass)*warp; rot = (0.010 + 0.05*treble + 0.04*beat)*speed; sw=0.0; }
    else if(preset==1){ zoom = 1.0 + (0.020 + 0.05*bass)*warp; rot = -(0.008 + 0.03*treble)*speed; sw=0.0; }
    else { zoom = 1.0 - 0.010*warp; rot = 0.006*speed; sw = (0.05 + 0.25*bass)*swirl; }
    float a2 = rot + sw*(0.5 - r);
    float ca=cos(a2), sa=sin(a2);
    vec2 cc = mat2(ca,-sa,sa,ca)*c*zoom;
    cc += 0.004*warp*vec2(sin(t*0.7*speed+cc.y*6.0), cos(t*0.6*speed+cc.x*6.0));
    vec2 w = cc; w.x/=asp; w += 0.5;
    col = texture(prev, w).rgb * clamp(decay + 0.02*beat, 0.0, 0.999);
    float circR = 0.16 + (0.10*level + 0.06*beat)*react;
    float wv = wav(fract(ang/6.2831 + 0.5));
    float scope = smoothstep(0.010*linew, 0.0, abs(r - (circR + 0.07*wv*react))) * (0.5 + 0.8*level*react);
    float m = spec(fract(ang/6.2831));
    float ray = smoothstep(0.015*linew, 0.0, abs(r - (circR + 0.05 + 0.55*m*react))) * m * 1.4 * bursts;
    col += tint(scope + ray, ang, t) * gain;
    col += tint(beat * smoothstep(0.22, 0.0, r) * 1.4 * bursts, ang, t*2.0);
  }
  else if(preset==3){
    // ── ГОРИЗОНТАЛЬНЫЙ СКРОЛЛ (спектрограмма: частота↕, время→) ──
    vec2 w = uv; w.x -= (0.004 + 0.012*speed)*warp;
    w.y += 0.0025*warp*sin(t*0.5 + uv.y*10.0);
    col = texture(prev, w).rgb * clamp(decay, 0.0, 0.999);
    float edge = smoothstep(0.02, 0.0, uv.x);
    float m = spec(clamp(uv.y,0.0,1.0));
    float wv = wav(uv.y);
    float line = smoothstep(0.02*linew, 0.0, abs(uv.x - (0.03 + 0.05*wv*react)));
    col += tint((m*1.7*react + 0.5*line*bursts) * edge, uv.y, t) * gain;
    col += tint(beat*edge*0.8*bursts, uv.y, t*2.0);
  }
  else if(preset==4){
    // ── ВЕРТИКАЛЬНЫЙ СКРОЛЛ (частота↔, время↑) ──
    vec2 w = uv; w.y += (0.004 + 0.012*speed)*warp;
    w.x += 0.0025*warp*sin(t*0.5 + uv.x*10.0);
    col = texture(prev, w).rgb * clamp(decay, 0.0, 0.999);
    float edge = smoothstep(0.02, 0.0, 1.0 - uv.y);
    float m = spec(clamp(uv.x,0.0,1.0));
    col += tint(m*1.7*react*edge, uv.x, t) * gain;
    col += tint(beat*edge*0.8*bursts, uv.x, t*2.0);
  }
  else {
    // ── ПЛОСКАЯ ПЛАЗМА (не привязана к центру) ──
    vec2 w = uv + vec2(0.0022*warp*sin(t*0.30 + uv.y*8.0), 0.0018*warp*cos(t*0.27 + uv.x*8.0));
    col = texture(prev, w).rgb * clamp(decay - 0.02, 0.0, 0.99);
    float fld = 0.5 + 0.5*sin((uv.x*6.0 + uv.y*4.0) + t*1.5*speed + 6.0*spec(uv.x)*react);
    float wv = wav(uv.x);
    float line = smoothstep(0.02*linew, 0.0, abs(uv.y - (0.5 + 0.32*wv)));
    col += tint(0.5*fld*level*react + 0.7*line*bursts, uv.x + 0.2*uv.y, t) * gain;
    col += tint(beat*0.4*bursts, uv.y, t);
  }
  fragColor = vec4(max(col, 0.0), 1.0);
}
"""

# ── present shader: тон-маппинг + лёгкий блум + виньетка ──
_PRESENT_FS = """#version 330
uniform vec2 res;
uniform float bloom;
uniform sampler2D scene;
out vec4 fragColor;
void main(){
  vec2 uv = gl_FragCoord.xy/res;
  vec3 c = texture(scene, uv).rgb;
  // дешёвый блум: усреднение по кресту
  vec2 px = 1.5/res;
  vec3 bl = texture(scene, uv+vec2(px.x,0)).rgb + texture(scene, uv-vec2(px.x,0)).rgb
          + texture(scene, uv+vec2(0,px.y)).rgb + texture(scene, uv-vec2(0,px.y)).rgb;
  c += bloom*bl;
  c = c/(c+vec3(0.85));            // тон-маппинг (Reinhard)
  c = pow(c, vec3(0.85));          // гамма
  float vig = smoothstep(1.25, 0.35, length(uv-0.5));
  c *= mix(0.55, 1.0, vig);        // виньетка
  fragColor = vec4(c, 1.0);
}
"""


class GPUVisualizer:
    """Полноэкранная цветомузыка на GPU (OpenGL/GLSL) — плотные поля, 4K.
    Своё окно glfw в отдельном потоке, питается аналитикой движка."""

    def __init__(self, engine):
        self.engine = engine
        self.thread = None
        self._stop = False
        self._win = None
        self._preset = 0
        self._fs = False
        self._wx = self._wy = 60
        self._ww, self._wh = 1366, 768

    @staticmethod
    def available():
        return HAVE_GPU

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self._stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self._stop = True

    def next_preset(self):
        self._preset = (self._preset + 1) % 6   # читается циклом рендера вживую

    def is_open(self):
        return self.thread is not None and self.thread.is_alive()

    def _toggle_fs(self, glfw, win, mon_index, force=False):
        if self._fs and not force:
            glfw.set_window_monitor(win, None, self._wx, self._wy, self._ww, self._wh, 0)
            self._fs = False
            return
        if not self._fs:
            try:
                self._wx, self._wy = glfw.get_window_pos(win)
                self._ww, self._wh = glfw.get_window_size(win)
            except Exception:
                pass
        mons = glfw.get_monitors()
        if not mons:
            return
        m = mons[mon_index] if mon_index < len(mons) else mons[0]
        vm = glfw.get_video_mode(m)
        glfw.set_window_monitor(win, m, 0, 0, vm.size.width, vm.size.height, vm.refresh_rate)
        self._fs = True

    def _run(self):
        glfw = _glfw; mgl = _mgl
        if not glfw.init():
            return
        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
        glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
        win = glfw.create_window(self._ww, self._wh, "Errarium — Цветомузыка (GPU)", None, None)
        if not win:
            glfw.terminate(); return
        self._win = win
        glfw.make_context_current(win)
        glfw.swap_interval(1)
        try:
            ctx = mgl.create_context()
            fb_prog = ctx.program(vertex_shader=_VIZ_VS, fragment_shader=_FB_FS)
            pr_prog = ctx.program(vertex_shader=_VIZ_VS, fragment_shader=_PRESENT_FS)
        except Exception:
            try: glfw.destroy_window(win)
            except Exception: pass
            glfw.terminate(); self._win = None; return
        quad = ctx.buffer(np.array([-1, -1, 3, -1, -1, 3], dtype="f4").tobytes())
        fb_vao = ctx.simple_vertex_array(fb_prog, quad, "p")
        pr_vao = ctx.simple_vertex_array(pr_prog, quad, "p")

        # внутреннее разрешение feedback-буфера (апскейл до 4K в present — бесплатный на GPU)
        IW, IH = 1600, 900
        def make_fbo():
            t = ctx.texture((IW, IH), 3, dtype="f2")
            t.filter = (mgl.LINEAR, mgl.LINEAR)
            t.repeat_x = False; t.repeat_y = False
            return ctx.framebuffer(color_attachments=[t]), t
        fboA, texA = make_fbo()
        fboB, texB = make_fbo()
        fboA.use(); ctx.clear(0, 0, 0, 1)
        fboB.use(); ctx.clear(0, 0, 0, 1)

        N = self.engine.VIZ_N
        bands_tex = ctx.texture((N, 1), 1, dtype="f4")
        bands_tex.filter = (mgl.LINEAR, mgl.LINEAR)
        bands_tex.repeat_x = False; bands_tex.repeat_y = False
        WN = self.engine.VIZ_W
        wave_tex = ctx.texture((WN, 1), 1, dtype="f4")
        wave_tex.filter = (mgl.LINEAR, mgl.LINEAR)
        wave_tex.repeat_x = False; wave_tex.repeat_y = False

        for nm, slot in (("prev", 0), ("bands", 1), ("wave", 2)):
            try: fb_prog[nm].value = slot
            except Exception: pass
        try: pr_prog["scene"].value = 0
        except Exception: pass

        start = time.perf_counter()
        norm = 0.05; lvln = 0.05; bassn = 0.02; beatenv = 0.0
        disp = np.zeros(N, dtype="f4")
        prev = {}
        cur, nxt = (fboA, texA), (fboB, texB)

        def edge(k):
            cur_ = glfw.get_key(win, k) == glfw.PRESS
            was = prev.get(k, False); prev[k] = cur_
            return cur_ and not was

        def setu(p, name, val):
            try: p[name].value = val
            except Exception: pass

        while not glfw.window_should_close(win) and not self._stop:
            e = self.engine
            running = e.running
            raw = np.asarray(e.viz_bands, dtype="f4")
            if not running:
                raw = raw * 0.92
            pk = float(raw.max()) if raw.size else 0.0
            norm = max(pk, norm * 0.99, 0.02)
            tgt = np.clip(raw / norm, 0.0, 1.0)
            disp = np.where(tgt > disp, disp * 0.40 + tgt * 0.60,
                            disp * 0.82 + tgt * 0.18).astype("f4")
            lvln = max(e.viz_level, lvln * 0.992, 0.02)
            level = min(1.0, (e.viz_level / lvln)) * (0.4 if not running else 1.0)
            bassn = max(e.viz_bass, bassn * 0.99, 0.004)
            bassv = min(1.0, e.viz_bass / bassn) * (0.0 if not running else 1.0)
            bn = e.viz_beat; e.viz_beat = 0.0
            beatenv = max(beatenv * 0.85, bn if running else 0.0)
            treble = min(1.0, e.viz_treble * 40.0)
            wave = np.asarray(e.viz_wave, dtype="f4")
            if not running:
                wave = (wave - 0.5) * 0.92 + 0.5

            bands_tex.write(disp.tobytes())
            wave_tex.write(np.ascontiguousarray(wave).tobytes())

            # 1) feedback pass: nxt = warp(cur) + new elements
            (cur_fbo, cur_tex) = cur
            (nxt_fbo, nxt_tex) = nxt
            cur_tex.use(0); bands_tex.use(1); wave_tex.use(2)
            nxt_fbo.use()
            ctx.viewport = (0, 0, IW, IH)
            setu(fb_prog, "res", (float(IW), float(IH)))
            setu(fb_prog, "time", time.perf_counter() - start)
            setu(fb_prog, "level", float(level))
            setu(fb_prog, "bass", float(bassv))
            setu(fb_prog, "treble", float(treble))
            setu(fb_prog, "cen", float(e.viz_centroid))
            setu(fb_prog, "beat", float(beatenv))
            setu(fb_prog, "preset", int(self._preset))
            cfg = e.viz_cfg
            setu(fb_prog, "color_mode", int(cfg.get("color_mode", 0)))
            setu(fb_prog, "mono_hue", float(cfg.get("mono_hue", 0.55)))
            setu(fb_prog, "saturation", float(cfg.get("saturation", 1.0)))
            setu(fb_prog, "decay", float(cfg.get("decay", 0.955)))
            setu(fb_prog, "speed", float(cfg.get("speed", 1.0)))
            setu(fb_prog, "warp", float(cfg.get("warp", 1.0)))
            setu(fb_prog, "swirl", float(cfg.get("swirl", 1.0)))
            setu(fb_prog, "gain", float(cfg.get("gain", 1.0)))
            setu(fb_prog, "linew", float(cfg.get("linew", 1.0)))
            setu(fb_prog, "react", float(cfg.get("react", 1.0)))
            setu(fb_prog, "bursts", float(cfg.get("bursts", 1.0)))
            fb_vao.render(mgl.TRIANGLES)

            # 2) present pass: nxt → экран (апскейл до окна/4K + блум + тон-маппинг)
            ctx.screen.use()
            w, h = glfw.get_framebuffer_size(win)
            ctx.viewport = (0, 0, w, h)
            nxt_tex.use(0)
            setu(pr_prog, "res", (float(w), float(h)))
            setu(pr_prog, "bloom", float(cfg.get("bloom", 0.12)))
            pr_vao.render(mgl.TRIANGLES)

            glfw.swap_buffers(win)
            glfw.poll_events()
            cur, nxt = nxt, cur   # ping-pong

            if edge(glfw.KEY_ESCAPE):
                break
            if edge(glfw.KEY_SPACE):
                self._preset = (self._preset + 1) % 6
            if edge(glfw.KEY_F11) or edge(glfw.KEY_F):
                self._toggle_fs(glfw, win, 0)
            if edge(glfw.KEY_1):
                self._toggle_fs(glfw, win, 0, force=True)
            if edge(glfw.KEY_2):
                self._toggle_fs(glfw, win, 1, force=True)
            if edge(glfw.KEY_3):
                self._toggle_fs(glfw, win, 2, force=True)

        try: glfw.destroy_window(win)
        except Exception: pass
        try: glfw.terminate()
        except Exception: pass
        self._win = None


class App:
    def __init__(self, root):
        self.root = root
        self.engine = Engine()
        self.sources = []          # list[Source]
        self.src_rows = []         # list of widget dicts
        self.outputs = []          # list[OutputSpk]
        self.out_rows = []         # list of output widget dicts
        self.fx_win = None         # «Спецэффекты» Toplevel
        self.viz_win = None        # «Цветомузыка» Toplevel (CPU-фолбэк)
        self._viz_job = None
        self._gpu_viz = None       # GPU-визуализатор (OpenGL)
        self.viz_cfg_win = None     # окно настроек стиля цветомузыки
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
        s.configure(".", background=BG, foreground=FG, fieldbackground=CARD, font=FONT)
        s.configure("TFrame", background=BG)
        s.configure("Panel.TFrame", background=PANEL)
        s.configure("Card.TFrame", background=CARD)
        s.configure("TLabel", background=BG, foreground=FG)
        s.configure("Sub.TLabel", background=PANEL, foreground=SUB, font=("Segoe UI", 9))
        s.configure("Head.TLabel", background=BG, foreground=FG, font=FONT_H)
        s.configure("Accent.TLabel", background=BG, foreground=ACC, font=FONT_H)
        s.configure("TButton", background=CARD, foreground=FG, borderwidth=0,
                    focuscolor=BG, padding=(12, 6))
        s.map("TButton",
              background=[("active", BD), ("pressed", BD)],
              foreground=[("active", "#ffffff")])
        # акцентная кнопка (основные действия)
        s.configure("Accent.TButton", background=ACC, foreground="#06210f",
                    borderwidth=0, focuscolor=BG, padding=(14, 6), font=FONT_B)
        s.map("Accent.TButton", background=[("active", "#37e07d"), ("pressed", "#26b85f")])
        s.configure("TCheckbutton", background=PANEL, foreground=FG, focuscolor=BG)
        s.map("TCheckbutton", background=[("active", PANEL)],
              foreground=[("active", ACC)], indicatorcolor=[("selected", ACC)])
        s.configure("TCombobox", fieldbackground=CARD, background=CARD, foreground=FG,
                    arrowcolor=ACC, bordercolor=BD, lightcolor=CARD, darkcolor=CARD, padding=5)
        s.map("TCombobox",
              fieldbackground=[("readonly", CARD), ("disabled", PANEL)],
              foreground=[("readonly", FG), ("disabled", SUB)],
              bordercolor=[("focus", ACC), ("active", ACC2)],
              arrowcolor=[("active", ACC2)],
              selectbackground=[("readonly", CARD)],
              selectforeground=[("readonly", FG)])
        s.configure("Horizontal.TScale", background=PANEL, troughcolor=BD,
                    bordercolor=PANEL, lightcolor=ACC, darkcolor=ACC)
        s.configure("Vertical.TScale", background=PANEL, troughcolor=BD,
                    bordercolor=PANEL, lightcolor=ACC2, darkcolor=ACC2)
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
        ttk.Label(head, text=f"by {BRAND}", foreground=ACC, background=BG,
                  font=("Segoe UI", 9, "bold")).pack(side="left", padx=8)
        ttk.Label(head, text="L/R · стерео-наушники · мультиисточник · EQ · спецэффекты",
                  foreground=SUB, background=BG, font=("Segoe UI", 9)).pack(side="left", padx=6)

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
        self.fx_btn = tk.Button(tr, text="✨ Спецэффекты", command=self.open_fx_window,
                                bg=PANEL, fg=ACC2, activebackground=BD, activeforeground=FG,
                                relief="flat", bd=1, font=FONT_B, padx=14, pady=3, cursor="hand2")
        self.fx_btn.pack(side="left", padx=4)
        self.viz_btn = tk.Button(tr, text="🌈 Цветомузыка", command=self.open_visualizer,
                                 bg=PANEL, fg="#f78c6b", activebackground=BD, activeforeground=FG,
                                 relief="flat", bd=1, font=FONT_B, padx=14, pady=3, cursor="hand2")
        self.viz_btn.pack(side="left", padx=(4, 0))
        self.viz_cfg_btn = tk.Button(tr, text="🎛", command=self.open_viz_settings,
                                     bg=PANEL, fg="#f78c6b", activebackground=BD, activeforeground=FG,
                                     relief="flat", bd=1, font=FONT_B, padx=8, pady=3, cursor="hand2")
        self.viz_cfg_btn.pack(side="left", padx=(0, 4))
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
    ROLES = ["Левый", "Моно", "Правый", "Стерео"]

    def _set_role(self, spk, role):
        spk.stereo = (role == "Стерео")
        spk.bal = self.ROLE_BAL.get(role, 0.0)

    def add_output_row(self, default_sub=None, role="Левый"):
        spk = OutputSpk(0, "")
        self._set_role(spk, role)
        self.outputs.append(spk)
        row = ttk.Frame(self.out_container, style="Panel.TFrame")
        row.pack(fill="x", padx=8, pady=3)

        cb = ttk.Combobox(row, values=self._out_labels(), state="readonly", width=24, font=FONT)
        cb.pack(side="left", padx=2)
        if default_sub:
            self._select_default(cb, self.out_devs, default_sub)
        elif self.out_devs:
            cb.current(0)
        cb.bind("<<ComboboxSelected>>", lambda e: self._reapply())

        rolev = tk.StringVar(value=role)
        rcb = ttk.Combobox(row, values=self.ROLES, state="readonly", width=8, font=FONT, textvariable=rolev)
        rcb.pack(side="left", padx=2)
        rcb.bind("<<ComboboxSelected>>", lambda e, s=spk, var=rolev: self._set_role(s, var.get()))

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
        if default_sub is None and len(self.out_rows) >= 3 and not getattr(self, "_warned_many", False):
            self._warned_many = True
            messagebox.showinfo(
                "Несколько колонок — важно",
                "⚠️ Bluetooth: ноутбучный BT-чип обычно стабильно тянет МАКСИМУМ 2 BT-колонки "
                "одновременно. При 3+ звук начинает заикаться/хрипеть (перегруз радиоканала 2.4 ГГц) — "
                "буфер это не лечит.\n\n"
                "⚠️ Умные/сетевые колонки (Яндекс «Алиса», Sonos, и т.п.) могут отображаться в списке, "
                "но НЕ воспроизводить через Windows — они играют только через свой кастинг.\n\n"
                "Совет: держи ≤2 Bluetooth; остальные подключай проводом/USB.")
        if self.engine.running:
            self._reapply()

    def remove_output(self, spk, row):
        if spk in self.outputs:
            self.outputs.remove(spk)
        self.out_rows = [r for r in self.out_rows if r["spk"] is not spk]
        row.destroy()
        if self.engine.running:
            self._reapply()

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

        cb.bind("<<ComboboxSelected>>", lambda e: self._reapply())

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
        if self.engine.running:
            self._reapply()

    def remove_source(self, src, row):
        if src in self.sources:
            self.sources.remove(src)
        self.src_rows = [r for r in self.src_rows if r["src"] is not src]
        row.destroy()
        if self.engine.running:
            self._reapply()

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
        path = os.path.join(user_data_dir(), "eq_presets.json")
        # одноразовая миграция из старого расположения (рядом со скриптом)
        if not os.path.exists(path):
            try:
                old = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eq_presets.json")
                if os.path.exists(old) and os.path.abspath(old) != os.path.abspath(path):
                    with open(old, "r", encoding="utf-8") as fi, open(path, "w", encoding="utf-8") as fo:
                        fo.write(fi.read())
            except Exception:
                pass
        return path

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
            "eq_on": e.eq_on,
            "bass_on": e.bass_on, "bass": e.bass,
            "spatial_on": e.spatial_on, "spatial": e.spatial,
            "threeD_on": e.threeD_on, "threeD": e.threeD,
            "surround_on": e.surround_on, "surround": e.surround,
            # ── спецэффекты ──
            "monobass_on": e.monobass_on, "monobass_hz": e.monobass_hz,
            "pos_on": e.pos_on, "pan": e.pan, "distance": e.distance,
            "tone_on": e.tone_on, "tilt": e.tilt, "drive": e.drive,
            "reverb_on": e.reverb_on, "reverb_size": e.reverb_size, "reverb_mix": e.reverb_mix,
            "comp_on": e.comp_on, "comp_thresh": e.comp_thresh,
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
        # ── спецэффекты ──
        e.monobass_on = bool(p.get("monobass_on", False))
        e.monobass_hz = float(p.get("monobass_hz", 120.0)); e.build_monobass()
        e.pos_on = bool(p.get("pos_on", False))
        e.pan = float(p.get("pan", 0.0)); e.set_distance(float(p.get("distance", 0.0)))
        e.tone_on = bool(p.get("tone_on", False))
        e.tilt = float(p.get("tilt", 0.0)); e.drive = float(p.get("drive", 0.0))
        e.reverb_on = bool(p.get("reverb_on", False))
        e.reverb_size = float(p.get("reverb_size", 0.5)); e.reverb_mix = float(p.get("reverb_mix", 0.22))
        e.comp_on = bool(p.get("comp_on", False)); e.comp_thresh = float(p.get("comp_thresh", -18.0))
        if "eq_on" in p:
            e.eq_on = bool(p["eq_on"])
            if e.eq_on:
                self.eq_btn.config(text="EQ ВКЛ", bg=ACC, fg="#06210f")
            else:
                self.eq_btn.config(text="EQ ВЫКЛ", bg=PANEL, fg=SUB)
        self.engine.build_eq()
        # если окно спецэффектов открыто — пересоберём, чтобы отразить пресет
        if self.fx_win is not None:
            try:
                if self.fx_win.winfo_exists():
                    self.fx_win.destroy()
                    self.fx_win = None
                    self.open_fx_window()
            except Exception:
                pass

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

    # ── Спецэффекты (отдельное полноразмерное окно) ──
    def _make_xy_pad(self, parent, title, xlabel, ylabel, color, on_cmd, move_cmd,
                     init=(0.5, 0.5), on_init=False):
        SIZE = 230
        r = 9
        col = ttk.Frame(parent, style="Panel.TFrame")
        col.pack(side="left", expand=True, fill="both", padx=10, pady=6)
        top = ttk.Frame(col, style="Panel.TFrame"); top.pack(fill="x")
        ttk.Label(top, text=title, background=PANEL, foreground=color, font=FONT_B).pack(side="left", padx=4)
        onv = tk.BooleanVar(value=on_init)
        ttk.Checkbutton(top, text="вкл", variable=onv,
                        command=lambda: on_cmd(onv.get())).pack(side="left", padx=6)
        cv = tk.Canvas(col, width=SIZE, height=SIZE, bg=BD, highlightthickness=1, highlightbackground=PANEL)
        cv.pack(padx=4, pady=4)
        cv.create_line(SIZE / 2, 0, SIZE / 2, SIZE, fill="#3a3f47")
        cv.create_line(0, SIZE / 2, SIZE, SIZE / 2, fill="#3a3f47")
        px = init[0] * SIZE; py = (1 - init[1]) * SIZE
        dot = cv.create_oval(px - r, py - r, px + r, py + r, fill=color, outline="#ffffff", width=2)
        ttk.Label(col, text=f"X: {xlabel}", style="Sub.TLabel").pack()
        ttk.Label(col, text=f"Y: {ylabel}", style="Sub.TLabel").pack()

        def set_pos(ev=None, xn=None, yn=None):
            if ev is not None:
                xn = min(max(ev.x, 0), SIZE) / SIZE
                yn = 1 - min(max(ev.y, 0), SIZE) / SIZE
            x = xn * SIZE; y = (1 - yn) * SIZE
            cv.coords(dot, x - r, y - r, x + r, y + r)
            move_cmd(xn, yn)

        cv.bind("<Button-1>", set_pos)
        cv.bind("<B1-Motion>", set_pos)
        move_cmd(init[0], init[1])   # выставить нейтральные значения (эффект пока выкл)

    def open_fx_window(self):
        if self.fx_win is not None:
            try:
                if self.fx_win.winfo_exists():
                    self.fx_win.deiconify(); self.fx_win.lift(); self.fx_win.focus_force()
                    return
            except Exception:
                pass
        win = tk.Toplevel(self.root)
        self.fx_win = win
        win.title(f"Спецэффекты — {BRAND}")
        win.configure(bg=BG)
        try:
            self.root.update_idletasks()
            w = max(self.root.winfo_width(), 920)
            h = max(self.root.winfo_height(), 720)
            win.geometry(f"{w}x{h}")
        except Exception:
            win.geometry("960x720")
        win.protocol("WM_DELETE_WINDOW", lambda: (setattr(self, "fx_win", None), win.destroy()))

        head = ttk.Frame(win)
        head.pack(fill="x", padx=12, pady=(10, 4))
        ttk.Label(head, text="СПЕЦЭФФЕКТЫ", style="Head.TLabel").pack(side="left")
        ttk.Label(head, text="2D-площадки и премиальная обработка · по умолчанию всё выключено",
                  foreground=SUB, background=BG).pack(side="left", padx=10)

        # ── 2D pads ──
        pads = ttk.Frame(win, style="Panel.TFrame")
        pads.pack(fill="x", padx=12, pady=6)
        e = self.engine
        cl = lambda x: max(0.0, min(1.0, x))
        self._make_xy_pad(
            pads, "SPACE", "Ширина стерео", "Глубина (3D)", ACC2,
            on_cmd=lambda v: (setattr(e, "spatial_on", v), setattr(e, "threeD_on", v),
                              setattr(e, "surround_on", v)),
            move_cmd=lambda xn, yn: (setattr(e, "spatial", xn * 2.0),
                                     setattr(e, "threeD", yn),
                                     setattr(e, "surround", yn * 0.6)),
            init=(cl(e.spatial / 2.0), cl(e.threeD)), on_init=e.spatial_on)
        self._make_xy_pad(
            pads, "POSITION", "Пан Л ↔ П", "Дальше ↕ Ближе", ACC,
            on_cmd=lambda v: setattr(e, "pos_on", v),
            move_cmd=lambda xn, yn: (setattr(e, "pan", (xn - 0.5) * 2.0),
                                     e.set_distance(1.0 - yn)),
            init=(cl(e.pan / 2.0 + 0.5), cl(1.0 - e.distance)), on_init=e.pos_on)
        self._make_xy_pad(
            pads, "TONE", "Тепло ↔ Ярко", "Сатурация", "#f78c6b",
            on_cmd=lambda v: setattr(e, "tone_on", v),
            move_cmd=lambda xn, yn: (setattr(e, "tilt", (xn - 0.5) * 2.0),
                                     setattr(e, "drive", yn), e.build_eq()),
            init=(cl(e.tilt / 2.0 + 0.5), cl(e.drive)), on_init=e.tone_on)

        # ── effect strips ──
        def strip(title, color, on_init=False):
            fr = ttk.Frame(win, style="Panel.TFrame")
            fr.pack(fill="x", padx=12, pady=4)
            top = ttk.Frame(fr, style="Panel.TFrame"); top.pack(fill="x", pady=(4, 0))
            ttk.Label(top, text=title, background=PANEL, foreground=color, font=FONT_B).pack(side="left", padx=8)
            onv = tk.BooleanVar(value=on_init)
            return fr, top, onv

        cfr, ctop, comp_on = strip("КОМПРЕССОР / ЛИМИТЕР", ACC, e.comp_on)
        ttk.Checkbutton(ctop, text="вкл", variable=comp_on,
                        command=lambda: setattr(e, "comp_on", comp_on.get())).pack(side="left", padx=6)
        clbl = ttk.Label(ctop, text=f"{int(e.comp_thresh)} dB", background=PANEL, foreground=SUB)
        clbl.pack(side="right", padx=10)
        cvar = tk.DoubleVar(value=e.comp_thresh)
        ttk.Scale(cfr, from_=-40, to=0, variable=cvar, orient="horizontal",
                  command=lambda v: (setattr(e, "comp_thresh", float(v)),
                                     clbl.config(text=f"{int(float(v))} dB"))).pack(fill="x", padx=10, pady=(0, 4))

        mfr, mtop, mb_on = strip("МОНО-БАС", ACC2, e.monobass_on)
        ttk.Checkbutton(mtop, text="вкл", variable=mb_on,
                        command=lambda: setattr(e, "monobass_on", mb_on.get())).pack(side="left", padx=6)
        mlbl = ttk.Label(mtop, text=f"{int(e.monobass_hz)} Гц", background=PANEL, foreground=SUB)
        mlbl.pack(side="right", padx=10)
        mvar = tk.DoubleVar(value=e.monobass_hz)
        ttk.Scale(mfr, from_=60, to=250, variable=mvar, orient="horizontal",
                  command=lambda v: (setattr(e, "monobass_hz", float(v)), e.build_monobass(),
                                     mlbl.config(text=f"{int(float(v))} Гц"))).pack(fill="x", padx=10, pady=(0, 4))

        rfr, rtop, rv_on = strip("РЕВЕРБ", "#f78c6b", e.reverb_on)
        ttk.Checkbutton(rtop, text="вкл", variable=rv_on,
                        command=lambda: setattr(e, "reverb_on", rv_on.get())).pack(side="left", padx=6)
        r1 = ttk.Frame(rfr, style="Panel.TFrame"); r1.pack(fill="x", padx=10)
        ttk.Label(r1, text="Размер", style="Sub.TLabel", width=8, anchor="w").pack(side="left")
        szvar = tk.DoubleVar(value=e.reverb_size * 100.0)
        ttk.Scale(r1, from_=0, to=100, variable=szvar, orient="horizontal",
                  command=lambda v: setattr(e, "reverb_size", float(v) / 100.0)).pack(side="left", fill="x", expand=True)
        r2 = ttk.Frame(rfr, style="Panel.TFrame"); r2.pack(fill="x", padx=10, pady=(0, 4))
        ttk.Label(r2, text="Микс", style="Sub.TLabel", width=8, anchor="w").pack(side="left")
        mxvar = tk.DoubleVar(value=e.reverb_mix * 100.0)
        ttk.Scale(r2, from_=0, to=80, variable=mxvar, orient="horizontal",
                  command=lambda v: setattr(e, "reverb_mix", float(v) / 100.0)).pack(side="left", fill="x", expand=True)

        # ── phase invert per speaker ──
        pfr = ttk.Frame(win, style="Panel.TFrame")
        pfr.pack(fill="x", padx=12, pady=6)
        ttk.Label(pfr, text="ФАЗА КОЛОНОК — инверсия (фикс противофазы / пропадающего баса)",
                  style="Head.TLabel").pack(anchor="w", padx=8, pady=(6, 2))
        prow = ttk.Frame(pfr, style="Panel.TFrame"); prow.pack(fill="x", padx=8, pady=(0, 8))
        rows = getattr(self, "out_rows", [])
        if rows:
            for r in rows:
                spk = r["spk"]
                nm = (r["cb"].get() or spk.name or f"Выход {spk.id}")
                nm = nm.split(" · ")[0][:22]
                pv = tk.BooleanVar(value=spk.inv)
                ttk.Checkbutton(prow, text=nm, variable=pv,
                                command=lambda s=spk, v=pv: setattr(s, "inv", v.get())).pack(side="left", padx=10)
        else:
            ttk.Label(prow, text="нет колонок", style="Sub.TLabel").pack(side="left")

        ttk.Label(win,
                  text="💡 Эффекты применяются к любому звуку, идущему через сплиттер. "
                       "Для системного звука добавь источник «+ Системный звук».",
                  background=BG, foreground=SUB, font=("Segoe UI", 9)).pack(padx=12, pady=(2, 8), anchor="w")

    # ── Цветомузыка: настройки стиля ──
    def open_viz_settings(self):
        if self.viz_cfg_win is not None:
            try:
                if self.viz_cfg_win.winfo_exists():
                    self.viz_cfg_win.deiconify(); self.viz_cfg_win.lift(); self.viz_cfg_win.focus_force()
                    return
            except Exception:
                pass
        win = tk.Toplevel(self.root)
        self.viz_cfg_win = win
        win.title(f"Цветомузыка — стиль · {BRAND}")
        win.configure(bg=BG)
        win.geometry("440x640")
        win.protocol("WM_DELETE_WINDOW", lambda: (setattr(self, "viz_cfg_win", None), win.destroy()))
        cfg = self.engine.viz_cfg
        vbox = {}

        ttk.Label(win, text="СТИЛЬ ЦВЕТОМУЗЫКИ", style="Head.TLabel").pack(anchor="w", padx=14, pady=(12, 2))

        # пресеты
        pf = ttk.Frame(win, style="Panel.TFrame"); pf.pack(fill="x", padx=12, pady=6)
        ttk.Label(pf, text="Пресеты:", style="Sub.TLabel").pack(side="left", padx=(8, 6), pady=8)

        # выбор цветового режима
        cmf = ttk.Frame(win, style="Panel.TFrame"); cmf.pack(fill="x", padx=12, pady=6)
        ttk.Label(cmf, text="Цвет:", style="Sub.TLabel").pack(side="left", padx=(8, 6), pady=6)
        color_var = tk.IntVar(value=int(cfg.get("color_mode", 0)))
        for i, nm in ((0, "Цвет"), (1, "Ч/Б"), (2, "Монотон")):
            ttk.Radiobutton(cmf, text=nm, variable=color_var, value=i,
                            command=lambda: cfg.__setitem__("color_mode", color_var.get())).pack(side="left", padx=6)

        def slider(label, key, lo, hi):
            fr = ttk.Frame(win, style="Panel.TFrame"); fr.pack(fill="x", padx=12, pady=2)
            ttk.Label(fr, text=label, style="Sub.TLabel", width=18, anchor="w").pack(side="left", padx=(8, 0))
            var = tk.DoubleVar(value=float(cfg.get(key, lo)))
            lbl = ttk.Label(fr, text=f"{cfg.get(key, lo):.2f}", background=PANEL, foreground=FG, width=6)

            def on(v, key=key, lbl=lbl):
                cfg[key] = float(v); lbl.config(text=f"{float(v):.2f}")
            ttk.Scale(fr, from_=lo, to=hi, variable=var, orient="horizontal",
                      command=on).pack(side="left", fill="x", expand=True, padx=6)
            lbl.pack(side="left", padx=(0, 8))
            vbox[key] = (var, lbl)

        slider("Оттенок (монотон)", "mono_hue", 0.0, 1.0)
        slider("Насыщенность", "saturation", 0.0, 1.3)
        slider("Тягучесть (шлейфы)", "decay", 0.90, 0.992)
        slider("Скорость", "speed", 0.2, 2.5)
        slider("Искажение", "warp", 0.0, 2.0)
        slider("Вихрь", "swirl", 0.0, 2.0)
        slider("Свечение (блум)", "bloom", 0.0, 0.4)
        slider("Яркость линий", "gain", 0.3, 2.0)
        slider("Толщина линий", "linew", 0.4, 2.0)
        slider("Чувствительность", "react", 0.3, 2.0)
        slider("Всплески / лучи", "bursts", 0.0, 1.0)

        def apply_preset(d):
            cfg.update(d)
            color_var.set(int(cfg.get("color_mode", 0)))
            for k, (var, lbl) in vbox.items():
                if k in cfg:
                    var.set(cfg[k]); lbl.config(text=f"{cfg[k]:.2f}")

        BRIGHT = dict(color_mode=0, saturation=1.0, decay=0.955, speed=1.0, warp=1.0, swirl=1.0,
                      bloom=0.14, gain=1.1, linew=1.0, react=1.0, bursts=1.0)
        STRICT_MONO = dict(color_mode=2, mono_hue=0.55, saturation=0.55, decay=0.984, speed=0.5,
                           warp=0.55, swirl=0.35, bloom=0.18, gain=0.9, linew=0.55, react=0.9, bursts=0.0)
        STRICT_BW = dict(color_mode=1, saturation=0.0, decay=0.985, speed=0.45, warp=0.5,
                         swirl=0.3, bloom=0.16, gain=0.85, linew=0.5, react=0.9, bursts=0.0)

        for txt, preset, col in (("Яркий", BRIGHT, ACC), ("Строгий·моно", STRICT_MONO, ACC2),
                                 ("Строгий·Ч/Б", STRICT_BW, FG)):
            tk.Button(pf, text=txt, command=lambda p=preset: apply_preset(p),
                      bg=CARD, fg=col, activebackground=BD, activeforeground=FG,
                      relief="flat", bd=0, font=FONT, padx=10, pady=4, cursor="hand2").pack(side="left", padx=4, pady=6)

        ttk.Label(win, text="Меняется вживую. Открой «🌈 Цветомузыка» и крути слайдеры.\n"
                           "В окне: SPACE — режим варпа, F11 — полный экран, 1/2/3 — монитор.",
                  background=BG, foreground=SUB, font=("Segoe UI", 9), justify="left").pack(anchor="w", padx=14, pady=10)

    # ── Цветомузыка ──
    def open_visualizer(self):
        """GPU-окно (плотные поля, 4K) с откатом на CPU-визуализатор."""
        if HAVE_GPU:
            try:
                if self._gpu_viz is None:
                    self._gpu_viz = GPUVisualizer(self.engine)
                self._gpu_viz.start()
                return
            except Exception as ex:
                messagebox.showwarning("Цветомузыка",
                                       f"GPU-режим недоступен ({ex}). Включаю обычный режим.")
        self.open_viz_window()

    @staticmethod
    def _hsv_hex(h, s, v):
        h = h % 1.0
        s = max(0.0, min(1.0, s)); v = max(0.0, min(1.0, v))
        r, g, b = colorsys.hsv_to_rgb(h, s, v)
        return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"

    def open_viz_window(self):
        if self.viz_win is not None:
            try:
                if self.viz_win.winfo_exists():
                    self.viz_win.deiconify(); self.viz_win.lift(); self.viz_win.focus_force()
                    return
            except Exception:
                pass
        win = tk.Toplevel(self.root)
        self.viz_win = win
        win.title(f"Цветомузыка — {BRAND}")
        win.configure(bg="#000000")
        try:
            self.root.update_idletasks()
            w = max(self.root.winfo_width(), 1000)
            win.geometry(f"{w}x{max(self.root.winfo_height(), 720)}")
        except Exception:
            win.geometry("1100x760")

        cv = tk.Canvas(win, bg="#04050a", highlightthickness=0)
        cv.pack(fill="both", expand=True)
        N = self.engine.VIZ_N
        # frequency → hue: бас красный (0.0) … верх фиолет (~0.78)
        base_hue = [0.0 + 0.78 * (i / (N - 1)) for i in range(N)]
        st = {
            "cv": cv, "N": N, "base_hue": base_hue,
            "W": 0, "H": 0, "cx": 0, "cy": 0, "R": 0,
            "rot": 0.0, "beat": 0.0, "level": 0.0, "centroid": 0.5,
            "norm": 0.05, "lvl_norm": 0.05, "bass_norm": 0.02,
            "bands": np.zeros(N),
            "bg": cv.create_rectangle(0, 0, 1, 1, fill="#04050a", outline=""),
            "halo": cv.create_oval(0, 0, 1, 1, fill="#04050a", outline=""),
            "poly": cv.create_polygon([0, 0, 1, 1, 2, 2], fill="#0a0c14", outline="", smooth=True),
            "bars": [cv.create_line(0, 0, 0, 0, width=3, capstyle="round") for _ in range(N)],
            "core": cv.create_oval(0, 0, 1, 1, fill="#ffffff", outline=""),
            "rings": [{"id": cv.create_oval(0, 0, 1, 1, outline="", width=3), "life": 0.0, "hue": 0.0}
                      for _ in range(5)],
            "parts": [{"id": cv.create_oval(0, 0, 1, 1, fill="", outline=""),
                       "x": 0.0, "y": 0.0, "vx": 0.0, "vy": 0.0, "life": 0.0, "hue": 0.0}
                      for _ in range(90)],
        }
        self._viz_state = st
        hint = cv.create_text(14, 14, anchor="nw", fill="#3a4150",
                              text="ESC — закрыть · F11 — полный экран · двойной клик — полный экран",
                              font=("Segoe UI", 9))
        st["hint"] = hint

        def on_resize(ev=None):
            st["W"] = cv.winfo_width(); st["H"] = cv.winfo_height()
            st["cx"] = st["W"] * 0.5; st["cy"] = st["H"] * 0.5
            st["R"] = min(st["W"], st["H"]) * 0.24
            cv.coords(st["bg"], 0, 0, st["W"], st["H"])

        cv.bind("<Configure>", on_resize)

        def toggle_fs(ev=None):
            try:
                win.attributes("-fullscreen", not bool(win.attributes("-fullscreen")))
            except Exception:
                pass

        win.bind("<F11>", toggle_fs)
        cv.bind("<Double-Button-1>", toggle_fs)
        win.bind("<Escape>", lambda e: self._viz_close())
        win.protocol("WM_DELETE_WINDOW", self._viz_close)
        on_resize()
        self._viz_tick()

    def _viz_close(self):
        if self._viz_job is not None:
            try:
                self.root.after_cancel(self._viz_job)
            except Exception:
                pass
            self._viz_job = None
        if self.viz_win is not None:
            try:
                self.viz_win.destroy()
            except Exception:
                pass
        self.viz_win = None
        self._viz_state = None

    def _viz_tick(self):
        st = getattr(self, "_viz_state", None)
        if st is None or self.viz_win is None:
            return
        try:
            if not self.viz_win.winfo_exists():
                return
        except Exception:
            return
        cv = st["cv"]; e = self.engine; N = st["N"]
        cx, cy, R = st["cx"], st["cy"], st["R"]

        if not e.running:        # тишина — плавно гасим
            e.viz_bands = e.viz_bands * 0.90
            e.viz_level *= 0.90
            e.viz_bass *= 0.90

        # ── AUTO-GAIN: нормализуем к недавнему пику, чтобы всегда был полный размах ──
        raw = e.viz_bands
        pk = float(raw.max()) if raw.size else 0.0
        st["norm"] = max(pk, st["norm"] * 0.990, 0.015)
        tgt = np.clip(raw / st["norm"], 0.0, 1.0)
        prev = st["bands"]
        # резкая атака, плавный спад
        st["bands"] = np.where(tgt > prev, prev * 0.30 + tgt * 0.70, prev * 0.74 + tgt * 0.26)
        bands = st["bands"]
        # level AGC
        st["lvl_norm"] = max(e.viz_level, st["lvl_norm"] * 0.992, 0.02)
        ln = e.viz_level / st["lvl_norm"]
        st["level"] = st["level"] * 0.55 + ln * 0.45
        level = min(1.0, st["level"])
        # bass AGC (для ядра)
        st["bass_norm"] = max(e.viz_bass, st["bass_norm"] * 0.99, 0.004)
        bassn = min(1.0, e.viz_bass / st["bass_norm"])
        st["centroid"] = st["centroid"] * 0.82 + e.viz_centroid * 0.18
        centroid = st["centroid"]
        # consume beat
        beat_now = e.viz_beat
        e.viz_beat = 0.0
        st["beat"] = max(st["beat"] * 0.82, beat_now)
        beat = st["beat"]
        # rotation: drift + treble energy + beat kick
        st["rot"] += 0.004 + min(0.06, e.viz_treble * 3.0) + beat * 0.02
        rot = st["rot"]
        dom_hue = 0.62 - 0.5 * centroid + 0.05 * math.sin(rot * 0.3)

        # background tint (вспыхивает на бите)
        cv.itemconfig(st["bg"], fill=self._hsv_hex(dom_hue, 0.7, 0.04 + 0.10 * level + 0.10 * beat))
        # halo
        hr = R * (1.3 + 3.4 * level + 2.0 * beat)
        cv.coords(st["halo"], cx - hr, cy - hr, cx + hr, cy + hr)
        cv.itemconfig(st["halo"], fill=self._hsv_hex(dom_hue, 0.85, 0.12 + 0.20 * level + 0.18 * beat))

        # bars + polygon tips
        ang = rot + np.arange(N) * (2.0 * math.pi / N)
        rin = R * 0.90
        length = R * (0.12 + 3.6 * bands)         # длинные полосы во весь экран
        rout = rin + length
        ca = np.cos(ang); sa = np.sin(ang)
        x1 = cx + ca * rin; y1 = cy + sa * rin
        x2 = cx + ca * rout; y2 = cy + sa * rout
        tips = []
        bars = st["bars"]; base_hue = st["base_hue"]
        hue_shift = 0.10 * math.sin(rot * 0.7) + 0.15 * beat
        for i in range(N):
            bi = bands[i]
            cv.coords(bars[i], x1[i], y1[i], x2[i], y2[i])
            hue = base_hue[i] + hue_shift
            val = 0.55 + 0.45 * bi + 0.2 * beat            # ярче
            sat = 1.0 - 0.30 * bi
            cv.itemconfig(bars[i], fill=self._hsv_hex(hue, sat, min(1.0, val)),
                          width=2 + int(6 * bi))           # толще на пиках
            tips.extend((x2[i], y2[i]))
        cv.coords(st["poly"], *tips)
        cv.itemconfig(st["poly"], fill=self._hsv_hex(dom_hue, 0.9, 0.14 + 0.16 * level))

        # core
        crv = R * (0.30 + 0.6 * bassn + 0.8 * beat)
        crv = min(crv, R * 1.4)
        cv.coords(st["core"], cx - crv, cy - crv, cx + crv, cy + crv)
        cv.itemconfig(st["core"], fill=self._hsv_hex(dom_hue, 0.20, min(1.0, 0.8 + 0.2 * beat)))

        # beat → ring + particles
        if beat_now > 0.5:
            for rg in st["rings"]:
                if rg["life"] <= 0.01:
                    rg["life"] = 1.0; rg["hue"] = dom_hue
                    break
            spawn = int(18 + 30 * level)
            for p in st["parts"]:
                if spawn <= 0:
                    break
                if p["life"] <= 0.01:
                    a = random.random() * 2.0 * math.pi
                    sp = R * (0.08 + 0.16 * random.random()) * (1.0 + 1.5 * level)
                    p["x"] = cx; p["y"] = cy
                    p["vx"] = math.cos(a) * sp; p["vy"] = math.sin(a) * sp
                    p["life"] = 1.0; p["hue"] = base_hue[random.randrange(N)]
                    spawn -= 1

        # update rings
        for rg in st["rings"]:
            if rg["life"] > 0.01:
                rg["life"] -= 0.038
                rr = R * (0.5 + (1.0 - rg["life"]) * 4.2)
                cv.coords(rg["id"], cx - rr, cy - rr, cx + rr, cy + rr)
                cv.itemconfig(rg["id"], outline=self._hsv_hex(rg["hue"], 0.9, rg["life"]),
                              width=max(1, int(7 * rg["life"])))
            else:
                cv.coords(rg["id"], -10, -10, -8, -8)

        # update particles
        for p in st["parts"]:
            if p["life"] > 0.01:
                p["life"] -= 0.022
                p["x"] += p["vx"]; p["y"] += p["vy"]
                p["vx"] *= 0.97; p["vy"] *= 0.97
                pr = 2 + 7 * p["life"]
                cv.coords(p["id"], p["x"] - pr, p["y"] - pr, p["x"] + pr, p["y"] + pr)
                cv.itemconfig(p["id"], fill=self._hsv_hex(p["hue"], 0.8, p["life"]))
            else:
                cv.coords(p["id"], -10, -10, -8, -8)

        self._viz_job = self.root.after(33, self._viz_tick)

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
            dbg = [f"mic_sr={mic_sr} slot={slot}s chirp={chirp_secs}s amp={amp}"]
            for o, st in zip(outs, states):
                self._set_cal_status(f"замер: {o.name[:18]} ({int(st['f0'])}–{int(st['f1'])} Гц)…")
                corr_ref = make_chirp(dur=chirp_secs, sr=mic_sr, amp=1.0, f0=st["f0"], f1=st["f1"])
                cmd = ri[0]                # recording position at the trigger moment
                st["pi"] = 0; st["play"] = True
                time.sleep(slot)
                seg = recbuf[cmd:min(ri[0], n_rec)]
                if seg.size >= len(corr_ref):
                    corr = np.abs(fftconvolve(seg, corr_ref[::-1], mode="full"))
                    pk_idx = int(np.argmax(corr))
                    peak = pk_idx - (len(corr_ref) - 1)
                    raw = max(0.0, peak / mic_sr)
                    lat[o.id] = raw
                    noise = float(np.median(corr)) + 1e-12
                    ratio = float(corr[pk_idx]) / noise
                    seg_rms = float(np.sqrt(np.mean(seg ** 2)))
                    dbg.append(f"{o.name[:26]}: raw={raw * 1000:.1f}ms peak_ratio={ratio:.1f} seg_rms={seg_rms:.4f} seg={seg.size}")
                else:
                    lat[o.id] = 0.0
                    dbg.append(f"{o.name[:26]}: seg too short ({seg.size})")
            try:
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "calib_debug.log"), "w", encoding="utf-8") as fh:
                    fh.write("\n".join(dbg))
            except Exception:
                pass

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
        failed = getattr(self.engine, "failed_outputs", [])
        if failed:
            names = "\n".join(f"• {n}: {e[:80]}" for n, e in failed)
            self.status.config(text=f"играет (не открылись: {len(failed)})")
            messagebox.showwarning("Splitter", "Эти колонки не удалось открыть (играют остальные):\n\n" + names +
                                   "\n\nЧасто помогает: переподключить устройство, или оно занято/не на 48кГц.")
        else:
            self.status.config(text="играет")

    def _reapply(self):
        # Re-start playback so output/source changes (added/removed/changed device) take effect live.
        if self.engine.running:
            self.engine.stop()
            self._start_playback()

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


# Имя mutex должно совпадать с AppMutex в installer.iss — по нему
# установщик находит и закрывает работающую копию при обновлении.
APP_MUTEX_NAME = "ChannelSplitterErrariumMutex"


def _create_app_mutex():
    """Создаёт глобальный именованный mutex (Windows). Держим ссылку,
    чтобы он жил всё время работы приложения. Тихо игнорируем ошибки."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        h = ctypes.windll.kernel32.CreateMutexW(None, False, APP_MUTEX_NAME)
        return h  # дескриптор живёт до завершения процесса
    except Exception:
        return None


def main():
    _mutex = _create_app_mutex()  # noqa: F841 — держим ссылку живой
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
