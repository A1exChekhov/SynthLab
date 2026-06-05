"""Channel Splitter — premium web UI (pywebview) over the Python audio engine.
Reuses the DSP/engine/GPU-visualizer from splitter_gui (no Tk window is created)."""
import json
import os
import sys
import threading

import numpy as np
import webview

import splitter_gui as core


def _asset(*parts):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "app_web", *parts)


def _now_playing():
    """Best-effort Windows 'now playing' via Media Session API (winsdk). Optional."""
    try:
        from winsdk.windows.media.control import \
            GlobalSystemMediaTransportControlsSessionManager as MM
        import asyncio
        async def go():
            mgr = await MM.request_async()
            s = mgr.get_current_session()
            if not s:
                return None
            info = await s.try_get_media_properties_async()
            return {"title": (info.title or "").strip(),
                    "sub": (info.artist or info.album_title or "").strip(),
                    "source": (s.source_app_user_model_id or "").split("!")[0]}
        return asyncio.run(go())
    except Exception:
        return None


class AppCore:
    ROLE = {"L": (-1.0, False), "R": (1.0, False), "Mono": (0.0, False), "L/R": (0.0, True)}

    def __init__(self):
        self.engine = core.Engine()
        self.outputs = []
        self.sources = []
        self.gpu = None
        self._win = None
        self.refresh_devices()
        # defaults
        self._add_output("Bob", "L")
        self._add_output("JBL", "R")
        if core.HAVE_LOOPBACK:
            self.add_loopback()
        else:
            self.add_source()

    # ── devices ──
    def refresh_devices(self):
        was = self.engine.running
        if was:
            self.engine.stop()
        core.refresh_portaudio()
        self.out_devs = core.devices(True)
        self.in_devs = core.devices(False)
        self.lb = core.loopback_speakers()
        self.mic = core.mic_devices()
        if was:
            self._start()   # вернуть воспроизведение после пересканирования

    def _out_idx(self, label):
        for i, l in self.out_devs:
            if l == label:
                return i
        return self.out_devs[0][0] if self.out_devs else None

    def _in_idx(self, label):
        for i, l in self.in_devs:
            if l == label:
                return i
        return self.in_devs[0][0] if self.in_devs else None

    def _default_out(self, sub):
        for i, l in self.out_devs:
            if sub.lower() in l.lower():
                return l
        return self.out_devs[0][1] if self.out_devs else ""

    # ── outputs ──
    def _add_output(self, sub=None, role="L"):
        spk = core.OutputSpk(0, "")
        bal, st = self.ROLE[role]
        spk.bal = bal; spk.stereo = st
        spk.label = self._default_out(sub) if sub else (self.out_devs[0][1] if self.out_devs else "")
        self.outputs.append(spk)
        return spk

    def add_output(self):
        self._add_output(role="L"); self._reapply()

    def remove_output(self, oid):
        self.outputs = [o for o in self.outputs if o.id != oid]; self._reapply()

    def set_output(self, oid, field, value):
        o = next((x for x in self.outputs if x.id == oid), None)
        if not o:
            return
        struct = False
        if field == "device":
            o.label = value; struct = True
        elif field == "role":
            o.bal, o.stereo = self.ROLE.get(value, (0.0, False))
        elif field == "vol":
            o.vol = float(value)
        elif field == "mute":
            o.mute = bool(value)
        elif field == "delay":
            o.set_delay(float(value))
        elif field == "sub":
            o.is_sub = bool(value); o.build_filter(); struct = True
        elif field == "inv":
            o.inv = bool(value)
        if struct:
            self._reapply()

    # ── sources ──
    def add_source(self):
        s = core.Source(0, "")
        s.label = self.in_devs[0][1] if self.in_devs else ""
        self.sources.append(s); self._reapply()

    def add_loopback(self):
        s = core.Source(0, "System Audio")
        s.loopback = True
        s.lb_name = ""   # "" → захват устройства Windows по умолчанию (что реально играет)
        self.sources.append(s); self._reapply()

    def remove_source(self, sid):
        self.sources = [s for s in self.sources if s.id != sid]; self._reapply()

    def set_source(self, sid, field, value):
        s = next((x for x in self.sources if x.id == sid), None)
        if not s:
            return
        struct = False
        if field == "device":
            s.label = value; struct = True
        elif field == "lb_name":
            s.lb_name = value; struct = True
        elif field == "vol":
            s.vol = float(value)
        elif field == "bal":
            s.bal = float(value)
        elif field == "mute":
            s.mute = bool(value)
        elif field == "inv":
            s.inv = bool(value)
        if struct:
            self._reapply()

    # ── engine run ──
    def _resolve(self):
        for o in self.outputs:
            o.idx = self._out_idx(getattr(o, "label", ""))
        for s in self.sources:
            if not s.loopback:
                s.idx = self._in_idx(getattr(s, "label", ""))
        return list(self.sources), list(self.outputs)

    def _start(self):
        srcs, outs = self._resolve()
        if not outs:
            return False
        try:
            self.engine.start(srcs, outs)
            return True
        except Exception:
            return False

    def _reapply(self):
        if self.engine.running:
            self._start()

    def toggle(self):
        if self.engine.running:
            self.engine.stop()
        else:
            self._start()
        return self.engine.running

    def test_output(self, oid):
        for o in self.outputs:
            o.test_on = (o.id == oid)
        _, outs = self._resolve()
        try:
            self.engine.start([], outs, test=True)
        except Exception:
            pass

    # ── EQ ──
    def set_eq(self, i, g):
        self.engine.eq_gains[int(i)] = float(g); self.engine.build_eq()

    def set_eq_on(self, on):
        self.engine.eq_on = bool(on); self.engine.build_eq()

    def eq_reset(self):
        self.engine.eq_gains = [0.0] * len(core.EQ_FREQS); self.engine.build_eq()

    def _preset_path(self):
        return os.path.join(core.user_data_dir(), "eq_presets.json")

    def _load_presets(self):
        try:
            with open(self._preset_path(), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def eq_presets(self):
        return list(self._load_presets().keys())

    def eq_save(self, name):
        if not name:
            return
        e = self.engine
        d = self._load_presets()
        d[name] = {"gains": list(e.eq_gains), "eq_on": e.eq_on,
                   "monobass_on": e.monobass_on, "monobass_hz": e.monobass_hz,
                   "pos_on": e.pos_on, "pan": e.pan, "distance": e.distance,
                   "tone_on": e.tone_on, "tilt": e.tilt, "drive": e.drive,
                   "reverb_on": e.reverb_on, "reverb_size": e.reverb_size, "reverb_mix": e.reverb_mix,
                   "comp_on": e.comp_on, "comp_thresh": e.comp_thresh,
                   "spatial_on": e.spatial_on, "spatial": e.spatial,
                   "threeD_on": e.threeD_on, "threeD": e.threeD,
                   "surround_on": e.surround_on, "surround": e.surround}
        try:
            with open(self._preset_path(), "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def eq_apply(self, name):
        p = self._load_presets().get(name)
        if not p:
            return
        e = self.engine
        e.eq_gains = list(p.get("gains", [0.0] * len(core.EQ_FREQS)))
        for k in ("eq_on", "monobass_on", "monobass_hz", "pos_on", "pan", "distance",
                  "tone_on", "tilt", "drive", "reverb_on", "reverb_size", "reverb_mix",
                  "comp_on", "comp_thresh", "spatial_on", "spatial", "threeD_on", "threeD",
                  "surround_on", "surround"):
            if k in p:
                setattr(e, k, p[k])
        e.build_eq(); e.build_monobass(); e.set_distance(e.distance)

    def eq_delete(self, name):
        d = self._load_presets()
        if name in d:
            del d[name]
            try:
                with open(self._preset_path(), "w", encoding="utf-8") as f:
                    json.dump(d, f, ensure_ascii=False, indent=2)
            except Exception:
                pass

    # ── FX ──
    def set_fx(self, key, value):
        e = self.engine
        if key == "monobass_hz":
            e.monobass_hz = float(value); e.build_monobass()
        elif key == "distance":
            e.set_distance(float(value))
        elif key in ("tone_on", "tilt", "bass_on", "bass"):
            setattr(e, key, value if isinstance(value, bool) else float(value)); e.build_eq()
        elif isinstance(value, bool):
            setattr(e, key, value)
        else:
            setattr(e, key, float(value))

    def set_master(self, v):
        self.engine.master = float(v)

    def resize_window(self, w, h):
        """Подогнать окно ровно под содержимое (вызывается из UI после рендера).
        +рамка/заголовок окна Windows."""
        try:
            if self._win is not None:
                self._win.resize(int(w) + 16, int(h) + 39)
        except Exception:
            pass

    # ── visualizer ──
    def open_viz(self):
        if not core.HAVE_GPU:
            return False
        if self.gpu is None:
            self.gpu = core.GPUVisualizer(self.engine)
        self.gpu.start()
        return True

    def set_viz(self, key, value):
        self.engine.viz_cfg[key] = value if isinstance(value, (bool, str)) else float(value)

    def calibrate(self, mic_label=None):
        """Авто-выравнивание задержек по микрофону: chirp на каждый выход →
        кросс-корреляция → задержка = max(lat) - lat_i (мс) на каждый выход."""
        if not self.mic:
            return {"msg": "Микрофон не найден (нужен вход WASAPI/MME).", "items": []}
        mic_idx = next((i for i, l in self.mic if l == mic_label), self.mic[0][0])
        was = self.engine.running
        self.engine.stop()
        _, outs = self._resolve()
        outs = [o for o in outs if not o.is_sub and o.idx is not None]
        if not outs:
            if was:
                self._start()
            return {"msg": "Нет выходов для калибровки.", "items": []}
        try:
            items = self._calibrate(mic_idx, outs)
            msg = "✓ Готово — задержки выровнены. Подстрой вручную при необходимости."
        except Exception as e:
            items, msg = [], "Ошибка калибровки: " + str(e)
        if was:
            self._start()
        return {"msg": msg, "items": items}

    def _calibrate(self, mic_idx, outs, amp=0.16):
        import time as _t
        import sounddevice as sd
        _t.sleep(0.3)
        try:
            mic_sr = int(sd.query_devices(mic_idx).get("default_samplerate") or core.SR)
        except Exception:
            mic_sr = core.SR
        m = len(outs)
        lo, hi = 150.0, 7000.0
        edges = [lo * (hi / lo) ** (j / max(1, m)) for j in range(m + 1)]
        chirp_secs = 1.0
        slot = chirp_secs + 0.9
        REPS = 3                       # усреднение для точности
        n_rec = int((m * REPS * slot + 1.5) * mic_sr)
        recbuf = np.zeros(n_rec, dtype=np.float32)
        ri = [0]

        def in_cb(indata, frames, _tt, _s):
            k = min(frames, n_rec - ri[0])
            if k > 0:
                recbuf[ri[0]:ri[0] + k] = indata[:k, 0]
            ri[0] += k

        states, out_streams = [], []

        def make_cb(st):
            def cb(outdata, frames, _tt, _s):
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
                spk_sr = int(sd.query_devices(o.idx).get("default_samplerate") or core.SR)
            except Exception:
                spk_sr = core.SR
            chirp = core.make_chirp(dur=chirp_secs, sr=spk_sr, amp=amp, f0=f0, f1=f1)
            st = {"play": False, "pi": 0, "chirp": np.column_stack([chirp, chirp]),
                  "n": len(chirp), "f0": f0, "f1": f1}
            states.append(st)
            out_streams.append(sd.OutputStream(device=o.idx, channels=2, samplerate=spk_sr,
                                               blocksize=1024, dtype="float32", callback=make_cb(st)))
        inp = sd.InputStream(device=mic_idx, channels=1, samplerate=mic_sr, blocksize=1024,
                             dtype="float32", callback=in_cb)
        inp.start()
        for os_ in out_streams:
            os_.start()
        _t.sleep(0.6)
        lat = {}
        try:
            for o, st in zip(outs, states):
                corr_ref = core.make_chirp(dur=chirp_secs, sr=mic_sr, amp=1.0, f0=st["f0"], f1=st["f1"])
                meas = []
                for _r in range(REPS):
                    cmd = ri[0]; st["pi"] = 0; st["play"] = True
                    _t.sleep(slot)
                    seg = recbuf[cmd:min(ri[0], n_rec)]
                    if seg.size < len(corr_ref):
                        continue
                    corr = np.abs(core.fftconvolve(seg, corr_ref[::-1], mode="full"))
                    pk = int(np.argmax(corr))
                    ratio = float(corr[pk]) / (float(np.median(corr)) + 1e-12)
                    val = max(0.0, (pk - (len(corr_ref) - 1)) / mic_sr)
                    if ratio > 6.0:            # принимаем только уверенные пики
                        meas.append(val)
                lat[o.id] = float(np.median(meas)) if meas else 0.0
        finally:
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
        items = []
        for o in outs:
            ms = int(round(max(0.0, (mx - lat.get(o.id, 0.0)) * 1000.0)))
            o.set_delay(ms)
            items.append({"id": o.id, "name": getattr(o, "label", "").split(" (")[0][:20], "delay": ms})
        return items

    # ── state / meters ──
    def _role(self, o):
        if o.stereo:
            return "L/R"
        if o.bal <= -0.5:
            return "L"
        if o.bal >= 0.5:
            return "R"
        return "Mono"

    def get_state(self):
        e = self.engine
        return {
            "out_devices": [{"idx": i, "label": l} for i, l in self.out_devs],
            "in_devices": [{"idx": i, "label": l} for i, l in self.in_devs],
            "lb_speakers": list(self.lb),
            "mic_devices": [{"idx": i, "label": l} for i, l in self.mic],
            "gpu": core.HAVE_GPU, "loopback": core.HAVE_LOOPBACK,
            "running": e.running, "master": e.master,
            "outputs": [{"id": o.id, "device": getattr(o, "label", ""), "role": self._role(o),
                         "vol": o.vol, "mute": o.mute, "sub": o.is_sub, "xover": o.xover,
                         "delay": o.delay_ms, "inv": o.inv} for o in self.outputs],
            "sources": [{"id": s.id, "name": s.name, "loopback": s.loopback, "lb_name": s.lb_name,
                         "device": getattr(s, "label", ""), "vol": s.vol, "bal": s.bal,
                         "mute": s.mute, "inv": s.inv} for s in self.sources],
            "eq": {"on": e.eq_on, "gains": list(e.eq_gains)},
            "fx": {"spatial_on": e.spatial_on, "spatial": e.spatial, "threeD_on": e.threeD_on,
                   "threeD": e.threeD, "surround_on": e.surround_on, "surround": e.surround,
                   "monobass_on": e.monobass_on, "monobass_hz": e.monobass_hz,
                   "pos_on": e.pos_on, "pan": e.pan, "distance": e.distance,
                   "tone_on": e.tone_on, "tilt": e.tilt, "drive": e.drive,
                   "reverb_on": e.reverb_on, "reverb_size": e.reverb_size, "reverb_mix": e.reverb_mix,
                   "comp_on": e.comp_on, "comp_thresh": e.comp_thresh},
            "viz": dict(e.viz_cfg),
            "np": {"codec": "PCM", "rate": "48.0k", "bits": "32f", "ch": "2.0", "kbps": "—"},
        }

    _np_cache = {"title": "", "sub": "", "source": ""}
    _np_tick = 0

    def meters(self):
        e = self.engine
        outs = {o.id: float(o.peak) for o in self.outputs}
        srcs = {s.id: [float(s.in_peakL), float(s.in_peakR)] for s in self.sources}
        spec = [min(1.0, float(x) * 26.0) for x in e.spectrum]
        bands = [float(x) for x in (e.viz_bands if e.running else e.viz_bands * 0.9)]
        beat = float(e.viz_beat); e.viz_beat = 0.0
        # now playing (refresh ~ every second)
        self._np_tick += 1
        if self._np_tick % 20 == 0:
            np_ = _now_playing()
            if np_:
                self._np_cache = np_
        np = dict(self._np_cache)
        np.update({"codec": "PCM", "rate": "48.0k", "bits": "32f", "ch": "2.0", "kbps": "—"})
        return {"running": e.running, "outs": outs, "srcs": srcs, "spectrum": spec,
                "bands": bands, "level": float(e.viz_level), "beat": beat, "np": np}


def main():
    core_app = AppCore()
    win = webview.create_window(
        "Channel Splitter — Errarium",
        url=_asset("index.html"),
        js_api=core_app,
        width=1332, height=929, min_size=(700, 480), resizable=False,
        background_color="#0b0b0c",
    )
    core_app._win = win

    def on_closed():
        try:
            core_app.engine.stop()
        except Exception:
            pass
        if core_app.gpu:
            try:
                core_app.gpu.stop()
            except Exception:
                pass
    win.events.closed += on_closed
    webview.start()


if __name__ == "__main__":
    main()
