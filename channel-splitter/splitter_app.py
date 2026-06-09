"""Channel Splitter — premium web UI (pywebview) over the Python audio engine.
Reuses the DSP/engine/GPU-visualizer from splitter_gui (no Tk window is created)."""
import json
import os
import sys
import threading
import time

import numpy as np
import webview

import splitter_gui as core


def _asset(*parts):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "app_web", *parts)


def _mmss(sec):
    sec = max(0, int(sec))
    return "%d:%02d" % (sec // 60, sec % 60)


def _now_playing():
    """Best-effort Windows 'now playing' via Media Session API (winsdk):
    название, исполнитель, позиция/длительность."""
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
            pos = end = 0.0
            try:
                tl = s.get_timeline_properties()
                pos = tl.position.total_seconds()
                end = tl.end_time.total_seconds()
                # позиция дана на момент last_updated_time → экстраполируем, если играет
                try:
                    from winsdk.windows.media.control import \
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PS
                    import datetime
                    pb = s.get_playback_info()
                    if pb and pb.playback_status == PS.PLAYING:
                        last = tl.last_updated_time
                        if last:
                            now = datetime.datetime.now(datetime.timezone.utc)
                            d = (now - last).total_seconds()
                            if 0 <= d < 36000:
                                pos += d
                    if end > 0:
                        pos = min(pos, end)
                except Exception:
                    pass
            except Exception:
                pass
            return {"title": (info.title or "").strip(),
                    "sub": (info.artist or info.album_title or "").strip(),
                    "source": (s.source_app_user_model_id or "").split("!")[0],
                    "pos": pos, "end": end}
        return asyncio.run(go())
    except Exception:
        return None


class AppCore:
    ROLE = {"L": (-1.0, False), "R": (1.0, False), "Mono": (0.0, False), "L/R": (0.0, True)}

    FX_KEYS = ["spatial_on", "spatial", "threeD_on", "threeD", "surround_on", "surround",
               "monobass_on", "monobass_hz", "pos_on", "pan", "distance",
               "tone_on", "tilt", "drive", "reverb_on", "reverb_size", "reverb_mix",
               "comp_on", "comp_thresh", "bass_on", "bass"]

    def __init__(self):
        self.engine = core.Engine()
        self.outputs = []
        self.sources = []
        self.gpu = None
        self._win = None
        self._mini = None
        self._viz_win = None
        self._mini_x = 40
        self._mini_y = 40
        self._radio_cover = ""   # обложка радио (URL), для плеера и мини-плеера
        self._radio_cover_title = ""   # трек, для которого уже искали обложку
        self._np_art = ""        # обложка системного трека (SMTC), фоновый кэш
        self._tray = None
        self._quitting = False
        self._main_hidden = False
        self._mini_hidden = False
        self.ui = {"theme": "dark", "cols": 2, "lang": self._install_lang()}
        self._last_save = 0.0
        self._hold_on = False
        self._hold_thread = None
        self._hold_stop = False
        self._hold_mic = ""
        self.refresh_devices()
        if not self._load_settings():
            self.engine.master = 0.6   # безопасная стартовая громкость (не 100%)
            self._add_output("Bob", "L")
            self._add_output("JBL", "R")
            if core.HAVE_LOOPBACK:
                self.add_loopback()
            else:
                self.add_source()
            self.save_settings()
        # фоновый опрос «сейчас играет» (название/позиция/обложка) — вне bridge-потока
        threading.Thread(target=self._np_poll, daemon=True).start()

    # ── язык: выбирается при установке (installer пишет lang.txt) ──
    def _install_lang(self):
        try:
            p = os.path.join(core.user_data_dir(), "lang.txt")
            with open(p, "r", encoding="utf-8") as f:
                v = f.read().strip().lower()
            return "en" if v.startswith("en") else "ru"
        except Exception:
            return "ru"

    def open_url(self, url):
        try:
            import webbrowser
            webbrowser.open(url)
            return True
        except Exception:
            return False

    # ── persistence: запоминаем и восстанавливаем ВСЕ регулировки ──
    def _settings_path(self):
        return os.path.join(core.user_data_dir(), "settings.json")

    def _load_settings(self):
        try:
            with open(self._settings_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            return False
        e = self.engine
        e.master = float(d.get("master", 1.0))
        eq = d.get("eq", {})
        e.eq_on = bool(eq.get("on", False))
        g = eq.get("gains")
        if g and len(g) == len(e.eq_gains):
            e.eq_gains = [float(x) for x in g]
        for k, v in (d.get("fx", {}) or {}).items():
            try:
                setattr(e, k, v)
            except Exception:
                pass
        e.build_eq(); e.build_monobass(); e.set_distance(e.distance)
        if isinstance(d.get("viz"), dict):
            e.viz_cfg.update(d["viz"])
        if isinstance(d.get("ui"), dict):
            self.ui.update(d["ui"])
        self.outputs = []
        for od in d.get("outputs", []):
            spk = core.OutputSpk(0, "")
            bal, st = self.ROLE.get(od.get("role", "L"), (-1.0, False))
            spk.bal = bal; spk.stereo = st
            spk.label = od.get("device", "")
            spk.vol = float(od.get("vol", 1.0)); spk.mute = bool(od.get("mute", False))
            spk.is_sub = bool(od.get("sub", False)); spk.xover = float(od.get("xover", 120.0))
            spk.build_filter()
            spk.set_delay(float(od.get("delay", 0.0))); spk.inv = bool(od.get("inv", False))
            self.outputs.append(spk)
        self.sources = []
        for s_ in d.get("sources", []):
            s = core.Source(0, "System Audio" if s_.get("loopback") else "")
            s.loopback = bool(s_.get("loopback", False)); s.lb_name = s_.get("lb_name", "")
            s.label = s_.get("device", "")
            s.vol = float(s_.get("vol", 1.0)); s.bal = float(s_.get("bal", 0.0))
            s.mute = bool(s_.get("mute", False)); s.inv = bool(s_.get("inv", False))
            self.sources.append(s)
        if not self.outputs:
            self._add_output("Bob", "L"); self._add_output("JBL", "R")
        return True

    def save_settings(self):
        e = self.engine
        d = {
            "master": e.master,
            "eq": {"on": e.eq_on, "gains": list(e.eq_gains)},
            "fx": {k: getattr(e, k) for k in self.FX_KEYS},
            "viz": dict(e.viz_cfg),
            "ui": dict(self.ui),
            "outputs": [{"device": getattr(o, "label", ""), "role": self._role(o),
                         "vol": o.vol, "mute": o.mute, "sub": o.is_sub, "xover": o.xover,
                         "delay": o.delay_ms, "inv": o.inv} for o in self.outputs],
            "sources": [{"loopback": s.loopback, "device": getattr(s, "label", ""),
                         "lb_name": s.lb_name, "vol": s.vol, "bal": s.bal,
                         "mute": s.mute, "inv": s.inv} for s in self.sources],
        }
        try:
            with open(self._settings_path(), "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def _save(self):
        """Троттлинг частых изменений (drag ползунков)."""
        now = time.perf_counter()
        if now - self._last_save < 0.4:
            return
        self._last_save = now
        self.save_settings()

    def set_ui(self, key, value):
        self.ui[key] = value
        self._save()

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
        self._add_output(role="L"); self._reapply(); self._save()

    def remove_output(self, oid):
        self.outputs = [o for o in self.outputs if o.id != oid]; self._reapply(); self._save()

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
        self._save()

    # ── sources ──
    def add_source(self):
        s = core.Source(0, "")
        s.label = self.in_devs[0][1] if self.in_devs else ""
        self.sources.append(s); self._reapply(); self._save()

    def add_loopback(self):
        s = core.Source(0, "System Audio")
        s.loopback = True
        s.lb_name = ""   # "" → захват устройства Windows по умолчанию (что реально играет)
        self.sources.append(s); self._reapply(); self._save()

    def remove_source(self, sid):
        self.sources = [s for s in self.sources if s.id != sid]; self._reapply(); self._save()

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
        self._save()

    # ── engine run ──
    def _resolve(self):
        for o in self.outputs:
            o.idx = self._out_idx(getattr(o, "label", ""))
        for s in self.sources:
            if not s.loopback and not getattr(s, "radio", False):
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
        self.engine.eq_gains[int(i)] = float(g); self.engine.build_eq(); self._save()

    def set_eq_on(self, on):
        self.engine.eq_on = bool(on); self.engine.build_eq(); self._save()

    def eq_reset(self):
        self.engine.eq_gains = [0.0] * len(core.EQ_FREQS); self.engine.build_eq(); self._save()

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
        e.build_eq(); e.build_monobass(); e.set_distance(e.distance); self._save()

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
        self._save()

    def set_master(self, v):
        self.engine.master = float(v); self._save()

    def resize_window(self, w, h):
        """Подогнать окно ровно под содержимое (вызывается из UI после рендера).
        +рамка/заголовок окна Windows."""
        try:
            if self._win is not None:
                self._win.resize(int(w) + 16, int(h) + 39)
        except Exception:
            pass

    # ── окна: главное + мини-плеер (трей) ──
    def show_main(self):
        try:
            self._win.show(); self._win.restore()
            self._main_hidden = False
        except Exception:
            pass
        return True

    def hide_main(self):
        try:
            self._win.hide(); self._main_hidden = True
        except Exception:
            pass
        return True

    def toggle_main(self):
        if self._main_hidden:
            return self.show_main()
        return self.hide_main()

    def show_mini(self):
        try:
            self._mini.show(); self._mini_hidden = False
        except Exception:
            pass
        return True

    def hide_mini(self):
        try:
            self._mini.hide(); self._mini_hidden = True
        except Exception:
            pass
        return True

    def toggle_mini(self):
        if self._mini_hidden:
            return self.show_mini()
        return self.hide_mini()

    def quit_app(self):
        self._quitting = True
        # Гарантия выхода СРАЗУ: даже если очистка/WebView2/потоки залипнут — добиваем процесс.
        def _force():
            import time as _t
            _t.sleep(1.5)
            os._exit(0)
        threading.Thread(target=_force, daemon=True).start()
        try:
            self.save_settings()
        except Exception:
            pass
        try:
            if self._hold_on:
                self._hold_stop = True
        except Exception:
            pass
        try:
            self.engine.stop()          # останавливает потоки источников (радио/loopback)
        except Exception:
            pass
        if self.gpu:
            try:
                self.gpu.stop()
            except Exception:
                pass
        try:
            if self._tray is not None:
                self._tray.stop()
        except Exception:
            pass
        for w in (self._mini, self._viz_win, self._win):
            try:
                if w is not None:
                    w.destroy()
            except Exception:
                pass
        return True

    # ── visualizer ──
    def open_viz(self):
        """Цветомузыка в отдельном окне (viz.html на canvas, как в macOS-версии)."""
        try:
            if self._viz_win is not None:
                try:
                    self._viz_win.show()
                    return True
                except Exception:
                    self._viz_win = None
            self._viz_win = webview.create_window(
                "Channel Splitter — Visualizer", url=_asset("viz.html"),
                js_api=self, width=1280, height=720, background_color="#050607")

            def _viz_closed():
                self._viz_win = None
            try:
                self._viz_win.events.closed += _viz_closed
            except Exception:
                pass
            return True
        except Exception:
            return False

    def set_viz(self, key, value):
        self.engine.viz_cfg[key] = value if isinstance(value, (bool, str)) else float(value)
        self._save()

    # ── управление системным плеером (Windows Media Session) ──
    def _media_cmd(self, cmd):
        # Выполняем SMTC-команду в ОТДЕЛЬНОМ потоке — мост отвечает мгновенно,
        # кнопка никогда не «залипает» (раньше async на bridge-потоке мог тормозить).
        threading.Thread(target=self._media_cmd_bg, args=(cmd,), daemon=True).start()
        return True

    def _media_cmd_bg(self, cmd):
        try:
            from winsdk.windows.media.control import \
                GlobalSystemMediaTransportControlsSessionManager as MM
            import asyncio

            async def go():
                mgr = await MM.request_async()
                s = mgr.get_current_session()
                if not s:
                    return False
                if cmd == "play":
                    await s.try_toggle_play_pause_async()
                elif cmd == "next":
                    await s.try_skip_next_async()
                elif cmd == "prev":
                    await s.try_skip_previous_async()
                elif cmd == "stop":
                    # STOP надёжно во всех плеерах (Яндекс/Spotify часто НЕ поддерживают
                    # try_stop): мягкий сброс = перемотка в начало + пауза. Если плеер
                    # реально поддерживает stop — пробуем и его.
                    try:
                        await s.try_change_playback_position_async(0)
                    except Exception:
                        pass
                    try:
                        await s.try_pause_async()
                    except Exception:
                        pass
                    try:
                        await s.try_change_playback_position_async(0)
                    except Exception:
                        pass
                    try:
                        if s.get_playback_info().controls.is_stop_enabled:
                            await s.try_stop_async()
                    except Exception:
                        pass
                return True
            asyncio.run(asyncio.wait_for(go(), 6.0))
        except Exception:
            pass

    def _radio_active(self):
        return (self.engine.running and not self.engine.radio_stopped
                and any(getattr(s, "radio", False) for s in self.sources))

    def media_playpause(self):
        if self._radio_active():
            self.engine.radio_paused = not self.engine.radio_paused
            return not self.engine.radio_paused
        return self._media_cmd("play")

    def media_next(self):
        if self._radio_active():
            return False
        return self._media_cmd("next")

    def media_prev(self):
        if self._radio_active():
            return False
        return self._media_cmd("prev")

    def media_stop(self):
        if self._radio_active():
            self.tuner_stop()
            return False
        return self._media_cmd("stop")

    def radio_cover(self, song=None):
        """Поиск обложки трека радио в iTunes на стороне Python (в WebView fetch к
        iTunes блокируется CORS — нет Access-Control-Allow-Origin). Возвращает URL 300×300."""
        if not song:
            return ""
        try:
            import urllib.request, urllib.parse, json
            u = "https://itunes.apple.com/search?limit=1&entity=song&term=" + urllib.parse.quote(song)
            req = urllib.request.Request(u, headers={"User-Agent": "ChannelSplitter/2.2"})
            with urllib.request.urlopen(req, timeout=8) as r:
                j = json.load(r)
            res = j.get("results") or []
            art = res[0].get("artworkUrl100") if res else None
            if art:
                return art.replace("100x100", "300x300")
        except Exception:
            pass
        return ""

    def _fetch_radio_cover_bg(self, title):
        cover = self.radio_cover(title)
        if cover and self._radio_cover_title == title and self._radio_active():
            self._radio_cover = cover

    def set_radio_cover(self, url=None):
        """Обложка радио (URL логотипа станции / арт трека из iTunes), приходит из JS —
        у радио нет SMTC-миниатюры, поэтому мини-плеер берёт её отсюда."""
        self._radio_cover = url or ""
        return True

    def now_playing_art(self):
        """Мгновенно из кэша: радио — обложка станции/трека, иначе — миниатюра SMTC,
        которую обновляет фоновый поллер (никакого блокирующего async на bridge-потоке)."""
        if self._radio_active() and self._radio_cover:
            return self._radio_cover
        return self._np_art or None

    def _smtc_art(self):
        """Миниатюра текущего трека из Windows Media Session → data:URL. Вызывается
        ТОЛЬКО из фонового поллера (не из bridge), с таймаутом."""
        try:
            from winsdk.windows.media.control import \
                GlobalSystemMediaTransportControlsSessionManager as MM
            from winsdk.windows.storage.streams import DataReader
            import asyncio, base64

            async def go():
                mgr = await MM.request_async()
                s = mgr.get_current_session()
                if not s:
                    return None
                info = await s.try_get_media_properties_async()
                thumb = getattr(info, "thumbnail", None)
                if not thumb:
                    return None
                stream = await thumb.open_read_async()
                size = int(stream.size)
                if size <= 0:
                    return None
                reader = DataReader(stream)
                await reader.load_async(size)
                buf = bytearray(size)
                reader.read_bytes(buf)
                ct = (getattr(stream, "content_type", "") or "image/jpeg")
                return "data:" + ct + ";base64," + base64.b64encode(bytes(buf)).decode("ascii")
            return asyncio.run(asyncio.wait_for(go(), 5.0))
        except Exception:
            return None

    def _np_poll(self):
        """Фоновый опрос «сейчас играет» (название/позиция/обложка) — чтобы bridge
        никогда не блокировался на медленном WinRT/SMTC."""
        import time as _t
        last_key = None
        while not self._quitting:
            try:
                np_ = _now_playing()
                if np_:
                    self._np_cache = np_
                    key = (np_.get("title", ""), np_.get("sub", ""), np_.get("source", ""))
                    if key != last_key:
                        last_key = key
                        self._np_art = self._smtc_art() or ""
            except Exception:
                pass
            _t.sleep(1.0)

    # ── Input / Tuner (выбор источника + интернет-радио) ──
    def _first_source(self):
        if not self.sources:
            self.sources = [core.Source(0, "")]
        return self.sources[0]

    def set_input(self, kind=None, value=None):
        """Кнопка Input: первый источник → системный звук / приложение(устройство
        захвата) / входное устройство. На Windows «app» = захват выбранного
        render-устройства (полноценный per-process loopback недоступен без WASAPI
        process-loopback)."""
        s = self._first_source()
        s.radio = False; s.radio_url = ""
        if kind == "app":
            s.loopback = True; s.lb_name = value or ""; s.name = "System Audio"
        elif kind == "device":
            s.loopback = False; s.lb_name = ""
            s.label = value or ""; s.name = value or "Input"
        else:  # system
            s.loopback = True; s.lb_name = ""; s.name = "System Audio"
        if self.engine.running:
            self._reapply()
        else:
            self._start()
        self._save()
        return True

    def tuner_play(self, url=None, name="", favicon="", codec="", bitrate=0):
        if not url:
            return False
        s = self._first_source()
        s.radio = True; s.radio_url = url; s.loopback = False; s.lb_name = ""
        s.name = name or "Radio"
        # кодек/битрейт — из метаданных станции (radio-browser); частоту зондирует воркер
        s.fmt_codec = (codec or "").upper()
        try:
            s.fmt_kbps = int(float(bitrate or 0))
        except Exception:
            s.fmt_kbps = 0
        s.fmt_rate = 0.0; s.fmt_ch = 0
        self._radio_cover = favicon or ""   # лого станции — мгновенная обложка (до арта трека)
        self._radio_cover_title = ""        # сбросить — искать обложку для нового трека
        self.engine.radio_stopped = False; self.engine.radio_paused = False; self.engine.radio_title = ""
        if self.engine.running:
            self._reapply()
        else:
            self._start()
        return True

    def tuner_stop(self):
        s = self.sources[0] if self.sources else None
        if s and getattr(s, "radio", False):
            s.radio = False; s.radio_url = ""; s.loopback = True; s.lb_name = ""; s.name = "System Audio"
            if self.engine.running:
                self._reapply()
        self.engine.radio_stopped = True
        return True

    def mini_move(self, dx, dy):
        try:
            if self._mini is not None:
                self._mini_x = int(getattr(self, "_mini_x", 40)) + int(dx)
                self._mini_y = int(getattr(self, "_mini_y", 40)) + int(dy)
                self._mini.move(self._mini_x, self._mini_y)
        except Exception:
            pass
        return True

    # ── HOLD: онлайн-удержание синхронизации (компенсация дрейфа BT по микрофону) ──
    def hold_toggle(self, mic_label=None):
        if self._hold_on:
            self._hold_stop = True
            self._hold_on = False
            self.engine.cal_capture = False
            return False
        if len([o for o in self.outputs if not o.is_sub]) < 2 or not self.mic:
            return False
        self._hold_mic = mic_label or self.ui.get("hold_mic") or (self.mic[0][1] if self.mic else "")
        self._hold_stop = False
        self._hold_on = True
        self.engine.cal_capture = True
        self._hold_thread = threading.Thread(target=self._hold_worker, args=(self._hold_mic,), daemon=True)
        self._hold_thread.start()
        return True

    def _hold_worker(self, mic_label):
        import time as _t
        import sounddevice as sd
        eng = self.engine
        st = None
        try:
            outs = [o for o in self.outputs if not o.is_sub]
            if len(outs) < 2:
                return
            a, b = outs[0], outs[1]
            mic_idx = next((i for i, l in self.mic if l == mic_label), self.mic[0][0])
            try:
                msr = int(sd.query_devices(mic_idx).get("default_samplerate") or core.SR)
            except Exception:
                msr = core.SR
            MR = int(msr * 2.5)
            ring = np.zeros(MR, dtype=np.float32); wpos = [0]

            def in_cb(indata, frames, _t2, _s):
                x = indata[:, 0].astype(np.float32); n = x.shape[0]; w = wpos[0]; e = w + n
                if e <= MR:
                    ring[w:e] = x
                else:
                    k = MR - w; ring[w:] = x[:k]; ring[:e - MR] = x[k:]
                wpos[0] = e % MR

            st = sd.InputStream(device=mic_idx, channels=1, samplerate=msr, blocksize=1024,
                                dtype="float32", callback=in_cb)
            st.start()
            base = None
            base_samples = []
            rel_hist = []
            base_d = (a.delay_ms, b.delay_ms)
            applied = float(base_d[1] - base_d[0])   # текущее соотношение задержек (b−a), мс
            DEADZONE = 3.0   # мс: дрейф мельче — НЕ трогаем (держим соотношение момента HOLD)
            WINs = int(0.9 * core.SR)

            def lag(mc, o):
                c = np.abs(core.fftconvolve(mc, o[::-1], mode="full"))
                pk = int(np.argmax(c))
                ratio = float(c[pk]) / (float(np.median(c)) + 1e-9)
                return pk - (len(o) - 1), ratio

            while not self._hold_stop:
                _t.sleep(2.0)
                # HOLD контролирует только включивший: переживаем перезапуски движка
                # (смена входа/радио/добавление выходов), сами НЕ выключаемся.
                if not eng.running:
                    continue
                eng.cal_capture = True
                nonsub = [o for o in self.outputs if not o.is_sub]
                if len(nonsub) < 2:
                    continue
                a, b = nonsub[0], nonsub[1]
                need = int(1.1 * msr)
                w = wpos[0]
                mic = np.concatenate([ring[w:], ring[:w]])[-need:]
                if mic.size < need * 0.8:
                    continue
                tgt = max(1, int(mic.size * core.SR / msr))
                micr = np.interp(np.linspace(0, 1, tgt), np.linspace(0, 1, mic.size), mic).astype(np.float32)
                sa = eng.cal_snapshot(a); sb = eng.cal_snapshot(b)
                if sa is None or sb is None:
                    continue
                m = micr[-WINs:] if micr.size >= WINs else micr
                t0, r0 = lag(m, sa[-WINs:]); t1, r1 = lag(m, sb[-WINs:])
                if r0 < 4.0 or r1 < 4.0:
                    continue   # ненадёжно (моно-контент/тишина) — пропускаем
                rel = (t1 - t0) / core.SR * 1000.0
                # отсев выбросов + медиана истории — иначе задержка «дёргается»
                if rel_hist:
                    med = sorted(rel_hist)[len(rel_hist) // 2]
                    if abs(rel - med) > 40.0:
                        continue   # явный выброс (микрофон поймал не то) — игнор
                rel_hist.append(rel); rel_hist = rel_hist[-7:]
                rel_med = sorted(rel_hist)[len(rel_hist) // 2]
                if base is None:
                    base_samples.append(rel_med)
                    if len(base_samples) >= 3:
                        base = sorted(base_samples)[len(base_samples) // 2]   # стабильный «ноль»
                    continue
                target = (base_d[1] - base_d[0]) - (rel_med - base)
                err = target - applied
                if abs(err) > DEADZONE:               # держим соотношение; правим только заметный дрейф
                    applied += max(-2.0, min(2.0, err * 0.25))   # плавно, не более ~2 мс за шаг
                if applied >= 0:
                    a.set_delay(0.0); b.set_delay(min(300.0, applied))
                else:
                    a.set_delay(min(300.0, -applied)); b.set_delay(0.0)
        except Exception:
            pass
        finally:
            try:
                if st is not None:
                    st.stop(); st.close()
            except Exception:
                pass
            eng.cal_capture = False
            self._hold_on = False

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

    def _calibrate(self, mic_idx, outs, amp=0.10):
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
            items.append({"id": o.id, "name": getattr(o, "label", "").split(" · ")[0][:26], "delay": ms})
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
            "gpu": False, "loopback": core.HAVE_LOOPBACK,
            "running": e.running, "master": e.master,
            "outputs": [{"id": o.id, "device": getattr(o, "label", ""), "role": self._role(o),
                         "vol": o.vol, "mute": o.mute, "sub": o.is_sub, "xover": o.xover,
                         "delay": o.delay_ms, "inv": o.inv} for o in self.outputs],
            "sources": [{"id": s.id, "name": s.name, "loopback": s.loopback, "lb_name": s.lb_name,
                         "device": getattr(s, "label", ""), "radio": getattr(s, "radio", False),
                         "vol": s.vol, "bal": s.bal, "mute": s.mute, "inv": s.inv} for s in self.sources],
            "eq": {"on": e.eq_on, "gains": list(e.eq_gains)},
            "fx": {"spatial_on": e.spatial_on, "spatial": e.spatial, "threeD_on": e.threeD_on,
                   "threeD": e.threeD, "surround_on": e.surround_on, "surround": e.surround,
                   "bass_on": e.bass_on, "bass": e.bass,
                   "monobass_on": e.monobass_on, "monobass_hz": e.monobass_hz,
                   "pos_on": e.pos_on, "pan": e.pan, "distance": e.distance,
                   "tone_on": e.tone_on, "tilt": e.tilt, "drive": e.drive,
                   "reverb_on": e.reverb_on, "reverb_size": e.reverb_size, "reverb_mix": e.reverb_mix,
                   "comp_on": e.comp_on, "comp_thresh": e.comp_thresh},
            "viz": dict(e.viz_cfg),
            "ui": dict(self.ui),
            "hold": self._hold_on,
            "fmt": {"rate": 48000, "ch": 2, "codec": "PCM", "kbps": 0},
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
        # «сейчас играет» берём из ФОНОВОГО кэша (опрос SMTC в отдельном потоке) —
        # никакого блокирующего async на bridge-потоке, иначе зависал UI/название/обложка.
        np = dict(self._np_cache)
        pos = float(np.get("pos", 0.0)); end = float(np.get("end", 0.0))
        np["cur"] = _mmss(pos); np["total"] = _mmss(end)
        np["posfrac"] = (pos / end) if end > 0 else 0.0
        np_app = np.get("source", "")
        radio_active = self._radio_active()
        if radio_active:
            np["title"] = e.radio_title or np.get("title", "") or "Radio"
            np["source"] = "Radio"
        if radio_active:
            # обложку радио ищем в бэкенде (для мини-плеера / now_playing_art) при смене трека
            rt = e.radio_title or ""
            if rt and rt != self._radio_cover_title:
                self._radio_cover_title = rt
                threading.Thread(target=self._fetch_radio_cover_bg, args=(rt,), daemon=True).start()
            np["art_id"] = "radio:" + rt + ("#c" if self._radio_cover else "#")
            np["art_url"] = self._radio_cover or ""   # прямая ссылка (radio) — для мини без async
        else:
            np["art_id"] = "%s|%s|%s" % (np.get("title", ""), np.get("sub", ""), np_app)
            np["art_url"] = self._np_art or ""   # обложка системного трека из фонового кэша
        np.update({"codec": "PCM", "rate": "48.0k", "bits": "32f", "ch": "2.0"})
        s0 = self.sources[0] if self.sources else None
        if radio_active:
            fmt = {"rate": float(getattr(s0, "fmt_rate", 0) or 44100),
                   "ch": int(getattr(s0, "fmt_ch", 0) or 2),
                   "codec": (getattr(s0, "fmt_codec", "") or "STREAM"),
                   "kbps": int(getattr(s0, "fmt_kbps", 0) or e.radio_kbps or 0)}
        else:
            fmt = {"rate": 48000, "ch": 2, "codec": "PCM", "kbps": 0}
        src_sig = ",".join("%s|%s|%s" % (getattr(s, "lb_name", ""), getattr(s, "radio", False),
                                          getattr(s, "label", "")) for s in self.sources)
        try:
            wave = [float(x) for x in e.viz_wave]
        except Exception:
            wave = []
        return {"running": e.running, "outs": outs, "srcs": srcs, "spectrum": spec,
                "bands": bands, "wave": wave, "level": float(e.viz_level), "beat": beat,
                "viz": {"level": float(e.viz_level), "beat": beat}, "np": np, "np_app": np_app,
                "radio_title": e.radio_title, "radio_paused": bool(e.radio_paused),
                "radio_stopped": bool(e.radio_stopped), "radio_active": radio_active,
                "fmt": fmt, "src_sig": src_sig}


def _tray_image():
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([3, 3, 60, 60], radius=12, fill=(22, 24, 27, 255), outline=(0, 0, 0, 255))
    amber = (232, 176, 75, 255)
    d.ellipse([18, 18, 46, 46], outline=amber, width=3)
    d.ellipse([28, 28, 36, 36], fill=amber)
    return img


def _start_tray(app):
    try:
        import pystray
    except Exception:
        return
    en = (app.ui.get("lang") == "en")
    L = (lambda ru, eng: eng if en else ru)

    def show(icon=None, item=None):
        app.show_main()

    def toggle_mini(icon=None, item=None):
        app.toggle_mini()

    def play(icon=None, item=None):
        app.media_playpause()

    def nxt(icon=None, item=None):
        app.media_next()

    def prev(icon=None, item=None):
        app.media_prev()

    def quit_(icon=None, item=None):
        app.quit_app()

    menu = pystray.Menu(
        pystray.MenuItem(L("Показать окно", "Show window"), show, default=True),
        pystray.MenuItem(L("Мини-плеер", "Mini player"), toggle_mini),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(L("Плей / Пауза", "Play / Pause"), play),
        pystray.MenuItem(L("Вперёд", "Next"), nxt),
        pystray.MenuItem(L("Назад", "Previous"), prev),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(L("Выход", "Exit"), quit_),
    )
    try:
        icon = pystray.Icon("ChannelSplitter", _tray_image(),
                            "Channel Splitter — Errarium", menu)
        app._tray = icon
        icon.run()
    except Exception:
        pass


def _post_start(app):
    # мини-плеер в правый нижний угол + трей
    try:
        import ctypes
        sw = ctypes.windll.user32.GetSystemMetrics(0)
        sh = ctypes.windll.user32.GetSystemMetrics(1)
        if app._mini is not None:
            app._mini_x = sw - 384
            app._mini_y = sh - 168
            app._mini.move(app._mini_x, app._mini_y)
    except Exception:
        pass
    _start_tray(app)


def _create_app_mutex():
    """Глобальный named mutex (= AppMutex в installer.iss): по нему установщик находит
    и закрывает работающую копию при обновлении. Держим дескриптор живым.
    Второй запуск НЕ блокируем — иначе нельзя перезапустить, пока копия в трее."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        return ctypes.windll.kernel32.CreateMutexW(None, False, core.APP_MUTEX_NAME)
    except Exception:
        return None


def main():
    core_app = AppCore()
    core_app._mutex = _create_app_mutex()   # для авто-закрытия установщиком; держим живым
    win = webview.create_window(
        "Channel Splitter — Errarium",
        url=_asset("index.html"),
        js_api=core_app,
        width=1332, height=900, min_size=(640, 420), resizable=True,
        background_color="#0b0b0c",
    )
    core_app._win = win

    mini = webview.create_window(
        "Channel Splitter — Mini",
        url=_asset("mini.html"),
        js_api=core_app,
        width=360, height=98, resizable=False, frameless=True,
        easy_drag=False, on_top=True, background_color="#111315",
    )
    core_app._mini = mini

    def on_closing():
        # крестик главного окна → сворачиваем в трей (не выходим)
        if core_app._quitting:
            return True
        try:
            win.hide()
        except Exception:
            pass
        core_app._main_hidden = True
        return False

    def on_closed():
        try:
            core_app.save_settings()   # финальное сохранение всех регулировок
        except Exception:
            pass
        try:
            core_app.engine.stop()
        except Exception:
            pass
        if core_app.gpu:
            try:
                core_app.gpu.stop()
            except Exception:
                pass
        try:
            if core_app._tray is not None:
                core_app._tray.stop()
        except Exception:
            pass

    win.events.closing += on_closing
    win.events.closed += on_closed
    webview.start(_post_start, core_app)


if __name__ == "__main__":
    main()
