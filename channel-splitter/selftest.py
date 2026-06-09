"""Channel Splitter — гейт-тест перед сборкой.
Прогоняет ВЕСЬ bridge-API и движок headless (без реальных устройств), ловит
регрессии (исключения, пропавшие поля, сломанные эффекты). Запуск:
    buildenv\\Scripts\\python.exe selftest.py
Код возврата 0 = всё ок; 1 = есть провал (сборку делать НЕЛЬЗЯ)."""
import sys
import threading
import time
import queue

import numpy as np
import splitter_gui as core
import splitter_app as A

FAILS = []


def ok(name):
    print("  OK  " + name)


def bad(name, e):
    FAILS.append((name, repr(e)))
    print("  !!  " + name + "  ->  " + repr(e))


def check(name, fn):
    try:
        fn()
        ok(name)
    except Exception as e:  # noqa: BLE001
        bad(name, e)


# ───────────────────────── AppCore / bridge API ─────────────────────────
print("== AppCore bridge API ==")
app = A.AppCore()
app._start = lambda: True          # не трогаем реальные устройства в тесте
app._reapply = lambda: None

REQUIRED_STATE = {"out_devices", "in_devices", "lb_speakers", "mic_devices", "gpu",
                  "loopback", "running", "master", "outputs", "sources", "eq", "fx",
                  "viz", "ui", "hold", "fmt", "np"}
REQUIRED_METERS = {"running", "outs", "srcs", "spectrum", "bands", "wave", "level",
                   "beat", "viz", "np", "np_app", "radio_title", "radio_paused",
                   "radio_stopped", "radio_active", "fmt", "src_sig"}
REQUIRED_NP = {"title", "sub", "cur", "total", "posfrac", "art_id", "art_url", "source"}


def t_get_state():
    s = app.get_state()
    miss = REQUIRED_STATE - set(s)
    assert not miss, "missing state keys: " + str(miss)
    assert isinstance(s["outputs"], list) and isinstance(s["fx"], dict)


def t_meters():
    for _ in range(10):
        m = app.meters()
    miss = REQUIRED_METERS - set(m)
    assert not miss, "missing meters keys: " + str(miss)
    npmiss = REQUIRED_NP - set(m["np"])
    assert not npmiss, "missing np keys: " + str(npmiss)
    assert len(m["bands"]) == 64 and isinstance(m["bands"], list)
    assert len(m["spectrum"]) == 12
    assert isinstance(m["wave"], list)


def t_eq():
    app.set_eq(0, 5.0); app.set_eq(11, -3.0)
    app.set_eq_on(True); app.set_eq_on(False)
    app.eq_reset()
    assert isinstance(app.eq_presets(), list)
    app.eq_save("__selftest__"); assert "__selftest__" in app.eq_presets()
    app.eq_apply("__selftest__"); app.eq_delete("__selftest__")
    assert "__selftest__" not in app.eq_presets()


def t_fx():
    for k in ("spatial_on", "threeD_on", "surround_on", "bass_on", "monobass_on",
              "pos_on", "tone_on", "reverb_on", "comp_on"):
        app.set_fx(k, True); app.set_fx(k, False)
    for k, v in (("spatial", 0.5), ("threeD", 0.4), ("surround", 0.3), ("bass", 6.0),
                 ("monobass_hz", 120.0), ("pan", 0.2), ("distance", 0.5), ("tilt", 0.1),
                 ("drive", 0.3), ("reverb_size", 0.5), ("reverb_mix", 0.2), ("comp_thresh", -20.0)):
        app.set_fx(k, v)
    fx = app.get_state()["fx"]
    assert "bass" in fx and "comp_thresh" in fx


def t_master():
    app.set_master(0.5); assert abs(app.engine.master - 0.5) < 1e-6


def t_outputs():
    n0 = len(app.outputs)
    app.add_output(); assert len(app.outputs) == n0 + 1
    o = app.outputs[-1]
    for f, v in (("role", "R"), ("vol", 0.8), ("mute", True), ("mute", False),
                 ("sub", True), ("sub", False), ("inv", True), ("inv", False), ("delay", 12.0)):
        app.set_output(o.id, f, v)
    app.remove_output(o.id); assert len(app.outputs) == n0


def t_sources():
    n0 = len(app.sources)
    app.add_source(); app.add_loopback()
    s = app.sources[-1]
    for f, v in (("vol", 0.7), ("bal", 0.3), ("mute", True), ("mute", False), ("inv", True), ("inv", False)):
        app.set_source(s.id, f, v)
    while len(app.sources) > n0:
        app.remove_source(app.sources[-1].id)


def t_input_tuner():
    app.set_input("system", "")
    app.set_input("app", "Some Device")
    app.set_input("device", "Some Mic")
    app.tuner_play("http://example/stream", "St", "http://logo", "MP3", 128)
    assert app.sources[0].radio
    app.tuner_stop()


def t_misc():
    app.set_ui("theme", "silver"); assert app.ui["theme"] == "silver"
    app.set_radio_cover("http://x/y.png"); assert app._radio_cover == "http://x/y.png"
    assert isinstance(app.now_playing_art() or "", str)
    assert app.radio_cover("") == ""
    # окна (в headless _win/_mini = None → методы тихо проходят, без сайд-эффектов)
    app.toggle_mini(); app.show_main(); app.hide_main(); app.toggle_main()
    app.mini_move(5, 5)
    # методы существуют и вызываемы (реальный плеер/микрофон в тесте НЕ трогаем)
    for name in ("media_playpause", "media_next", "media_prev", "media_stop",
                 "hold_toggle", "open_viz", "quit_app", "refresh_devices", "toggle"):
        assert callable(getattr(app, name)), "missing method " + name


for n, f in [("get_state", t_get_state), ("meters", t_meters), ("eq", t_eq), ("fx", t_fx),
             ("master", t_master), ("outputs", t_outputs), ("sources", t_sources),
             ("input/tuner", t_input_tuner), ("misc (ui/art/media/windows/hold)", t_misc)]:
    check(n, f)


# ───────────────────────── Движок: DSP-цепочка ─────────────────────────
print("== Engine DSP chain ==")


def chain(setup, sig):
    e = core.Engine(); e.master = 1.0; e._t0 = time.perf_counter() - 100
    setup(e); e.build_eq(); e.build_monobass()
    o = core.OutputSpk(0, ""); o.id = 1; o.bal = 0.0; o.is_sub = False; o.sos = None; o.build_filter()
    return e._chain(o, {}, sig.astype(np.float32).copy(), len(sig), "m")


def t_passthrough():
    t = np.arange(core.SR) / core.SR
    s = (0.3 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    out = chain(lambda e: None, s)
    assert abs(float(np.sqrt((out ** 2).mean())) - float(np.sqrt((s ** 2).mean()))) < 0.02, "passthrough changed level"


def t_bass_effect():
    t = np.arange(core.SR) / core.SR
    s = (0.2 * np.sin(2 * np.pi * 60 * t)).astype(np.float32)
    off = float(np.sqrt((chain(lambda e: None, s) ** 2).mean()))
    on = float(np.sqrt((chain(lambda e: (setattr(e, "bass_on", True), setattr(e, "bass", 12.0)), s) ** 2).mean()))
    assert on > off * 1.5, "bass boost not working (off=%.3f on=%.3f)" % (off, on)


def t_comp_effect():
    t = np.arange(core.SR) / core.SR
    loud = (0.9 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    off = float(np.max(np.abs(chain(lambda e: None, loud))))
    on = float(np.max(np.abs(chain(lambda e: (setattr(e, "comp_on", True), setattr(e, "comp_thresh", -30.0)), loud))))
    assert on < off - 0.05, "compressor not reducing peaks (off=%.3f on=%.3f)" % (off, on)


def t_out_cb():
    e = core.Engine(); e.master = 1.0; e._t0 = time.perf_counter() - 100; e.test = False
    s = core.Source(0, ""); s.vol = 1.0; s.bal = 0.0; s.loopback = True
    q = queue.Queue(core.MAXBUF); s.queues = {1: q}; s.bufs = {1: np.zeros((0, 2), np.float32)}
    o = core.OutputSpk(0, ""); o.id = 1; o.is_sub = False; o.bal = 0.0; o.sos = None
    e.sources = [s]; e.outputs = [o]; e._spec_src = o
    tt = np.arange(core.BLOCK) / core.SR
    w = (0.5 * np.sin(2 * np.pi * 440 * tt)).astype(np.float32)
    for _ in range(8):
        q.put_nowait(np.column_stack([w, w]))
    cb = e._out_cb(o, 440.0); ob = np.zeros((core.BLOCK, 2), np.float32)
    cb(ob, core.BLOCK, None, None)
    assert float(np.max(np.abs(ob))) > 0.1, "output callback produced silence"


for n, f in [("passthrough", t_passthrough), ("bass boost", t_bass_effect),
             ("compressor", t_comp_effect), ("output callback", t_out_cb)]:
    check(n, f)


# ───────────────────────── Движок: радио-воркер ─────────────────────────
print("== Engine radio worker (network) ==")


def t_radio():
    e = core.Engine()
    s = core.Source(0, ""); s.radio = True
    s.radio_url = "http://jking.cdnstream1.com/b22139_128mp3"
    q = queue.Queue(core.MAXBUF); s.queues = {1: q}; s.bufs = {1: np.zeros((0, 2), np.float32)}
    s._running = True
    th = threading.Thread(target=e._radio_worker, args=(s,), daemon=True); th.start()
    time.sleep(6)
    s._running = False; s.radio = False
    assert not e.radio_stopped, "radio worker stopped early"
    assert q.qsize() > 0, "radio worker fed nothing"
    assert s.in_peakL > 0.0, "radio produced silence"


check("radio stream decode+feed", t_radio)

print()
if FAILS:
    print("FAILED %d check(s):" % len(FAILS))
    for n, e in FAILS:
        print("  - %s: %s" % (n, e))
    sys.exit(1)
print("ALL SELFTEST CHECKS PASSED")
sys.exit(0)
