# Channel Splitter — Errarium™

**Channel Splitter** is a premium Windows audio router. It captures a stereo source on
your PC and sends the **left and right channels to independent output devices** — for
example two Bluetooth speakers — while keeping a stereo pair (e.g. headphones) intact.
Each output runs on its own WASAPI stream with its own buffer, so the independent clocks
of wireless devices don't cause clicks, and per‑output delay lets you line them up.

It ships as a single installer with a brushed‑metal, pro‑AV rack interface
(seven‑segment readouts, tri‑colour segmented meters), a 12‑band equalizer, a DSP
effects rack, a GPU music visualizer, a now‑playing media bar, system‑tray support and a
floating mini player. Interface language (English / Russian) is chosen during install.

> © 2026 Errarium™. Proprietary license — see [LICENSE.txt](LICENSE.txt).
> Personal, non‑commercial use. No resale or rebranding.

---

## Highlights

- **Channel matrix** — route any number of outputs; each one is **L / R / Mono / L‑R**,
  with its own volume, mute, sub‑woofer (low‑pass) mode and phase invert (Ø).
- **Multiple sources** — capture system audio (WASAPI loopback — “what the PC is
  playing”) and/or physical inputs (microphone, line‑in, VB‑Audio CABLE), each with
  volume, balance, mute and phase.
- **Latency compensation**
  - **Manual sync slider** — drag until the speakers line up.
  - **Auto‑Calibration** — a microphone plays a quiet sweep on each output and aligns
    the delays automatically.
  - **HOLD** — lock the sync you like, and the app keeps it online by tracking
    Bluetooth clock drift through the microphone (no audible probes).
- **12‑band graphic EQ** with savable presets (presets persist across updates).
- **DSP effects rack** — 2‑D pads for Space (width/depth), Position (pan/distance) and
  Tone (warm‑bright/drive), plus compressor, mono‑bass and reverb (size + mix).
- **GPU visualizer** — full‑screen / 4K MilkDrop‑style fields with multiple presets and
  colour modes; press the Visualizer button again to cycle presets.
- **Now‑Playing bar** — title, artist and real position from Windows Media Session, with
  transport controls (play/pause, next, previous, stop) for the active media app.
- **System tray** — closing the window minimizes to tray; the tray menu gives
  show / mini‑player / transport / exit.
- **Floating mini player** — a small always‑on‑top strip to control playback when the
  main window is hidden.
- **Loud‑start protection** — first run starts at a safe volume and fades in; all
  settings (volumes, EQ, effects, theme, layout, language) are remembered and restored.
- **Themes & layout** — Dark or Silver (JVC‑style) face; one‑ or two‑column rack.
- **Bilingual UI** — English / Russian, including tooltips. Chosen at install time.

---

## Install

1. Run **`ChannelSplitter-Setup-2.2.exe`**.
2. Pick the interface language (English / Russian) in the setup wizard.
3. Launch Channel Splitter.

Settings and EQ presets are stored in
`%APPDATA%\Errarium\ChannelSplitter\` and survive updates and reinstalls.

### Recommended: route Windows audio into the app
To split *everything* the PC plays, add a **System Audio** source (WASAPI loopback) —
no extra setup needed. Alternatively install **VB‑Audio Virtual Cable**, set the Windows
default output to **CABLE Input**, and add **CABLE Output** as a source.

---

## Quick start

1. **Add outputs** (Output Matrix → **+ Output**): pick each device and set its role
   (e.g. one speaker **L**, the other **R**; headphones **L‑R** for full stereo).
2. **Add a source** (Pre‑Amp → **+ System** for system audio, or **+ Source** for a
   physical input).
3. Press **power (ON)** in the bottom panel.
4. **Align the speakers**: drag the **SYNC** slider, or run **Calibrate** with a mic, or
   press **HOLD** to keep the alignment locked online.

All controls work live during playback.

---

## About Bluetooth

Two **independent** Bluetooth speakers can't be locked sample‑accurate forever — each has
its own clock and its own, drifting latency. The manual slider and Auto‑Calibration set
the offset; **HOLD** continuously corrects the drift via the microphone. A small residual
offset is the physics of Bluetooth, not a bug. For perfect sync use a wired pair or a
single transmitter driving a stereo set.

---

## System requirements

- Windows 10 / 11 (x64).
- WebView2 runtime (preinstalled on current Windows; the installer relies on it).
- A microphone is only needed for Auto‑Calibration / HOLD.

---

## Build from source (developers)

```bat
build_exe.bat          REM builds dist\ChannelSplitter.exe (isolated venv, PyInstaller)
ISCC installer.iss     REM builds installer_out\ChannelSplitter-Setup-2.2.exe (Inno Setup 6)
```

Stack: Python audio engine (`splitter_gui.py`, NumPy/SciPy/sounddevice/soundcard),
pywebview UI (`splitter_app.py` + `app_web/`), moderngl/glfw GPU visualizer,
winsdk for Windows Media Session, pystray for the tray icon.

A Russian copy of this document is in [README.ru.md](README.ru.md).

---

© 2026 **Errarium™**. “Errarium” and the Errarium logo are trademarks of the rights holder.
Contact: **errarium_ai@gmail.com**.
