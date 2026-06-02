#!/usr/bin/env python3
"""
Stereo channel splitter for Windows.

Captures a stereo source (default: VB-Audio "CABLE Output") and sends the
LEFT channel to one output device and the RIGHT channel to another — e.g. two
separate Bluetooth speakers. Each output runs on its own WASAPI stream with a
small ring buffer so the independent device clocks (Bluetooth!) don't click.

Usage:
  python splitter.py --list                       # show all audio devices
  python splitter.py --left "Bob" --right "JBL"   # route CABLE Output L/R
  python splitter.py --input "CABLE Output" --left "Bob" --right "JBL"
  python splitter.py --test --left "Bob" --right "JBL"   # play test tones (no input needed)

Notes:
  * Set the Windows default playback device to "CABLE Input" so all PC sound
    flows into the cable that this tool captures.
  * Two independent Bluetooth speakers cannot be sample-accurately synced
    (different latency); a small offset between L and R is physically expected.
"""

import argparse
import queue
import sys
import time

import numpy as np
import sounddevice as sd

HOSTAPI_PREF = ["Windows WASAPI", "MME", "Windows DirectSound", "Windows WDM-KS"]


def hostapi_name(idx: int) -> str:
    return sd.query_hostapis()[idx]["name"]


def list_devices() -> None:
    has = sd.query_hostapis()
    print(f"{'idx':>3} | {'in/out':^9} | {'host api':^18} | name")
    print("-" * 80)
    for i, d in enumerate(sd.query_devices()):
        io = f"in{d['max_input_channels']} out{d['max_output_channels']}"
        print(f"{i:>3} | {io:^9} | {has[d['hostapi']]['name']:^18} | {d['name']}")


def find_device(sub, want_output: bool):
    """Resolve a device by index (int/str-int) or by name substring, preferring WASAPI."""
    if sub is None:
        return None
    # explicit index?
    try:
        return int(sub)
    except (TypeError, ValueError):
        pass
    sub_l = str(sub).lower()
    cands = []
    for i, d in enumerate(sd.query_devices()):
        ch = d["max_output_channels"] if want_output else d["max_input_channels"]
        if ch > 0 and sub_l in d["name"].lower():
            cands.append((i, d))
    if not cands:
        return None

    def rank(item):
        name = hostapi_name(item[1]["hostapi"])
        return HOSTAPI_PREF.index(name) if name in HOSTAPI_PREF else len(HOSTAPI_PREF)

    cands.sort(key=rank)
    return cands[0][0]


def dev_label(idx):
    d = sd.query_devices(idx)
    return f"[{idx}] {d['name']} ({hostapi_name(d['hostapi'])})"


def make_output_callback(q: "queue.Queue", nch: int, tone_hz: float, samplerate: int, test: bool):
    state = {"buf": np.zeros(0, dtype=np.float32), "phase": 0}

    def cb(outdata, frames, _time, status):
        if status:
            pass  # under/overflow flags — ignored, buffer self-heals
        if test:
            t = (state["phase"] + np.arange(frames)) / samplerate
            mono = (0.2 * np.sin(2 * np.pi * tone_hz * t)).astype(np.float32)
            state["phase"] += frames
        else:
            b = state["buf"]
            while b.shape[0] < frames:
                try:
                    b = np.concatenate([b, q.get_nowait()])
                except queue.Empty:
                    b = np.concatenate([b, np.zeros(frames - b.shape[0], dtype=np.float32)])
                    break
            mono = b[:frames]
            state["buf"] = b[frames:]
        outdata[:] = np.repeat(mono.reshape(-1, 1), nch, axis=1)

    return cb


def run(args) -> int:
    in_idx = find_device(args.input, want_output=False)
    l_idx = find_device(args.left, want_output=True)
    r_idx = find_device(args.right, want_output=True)

    if not args.test and in_idx is None:
        print(f"!! Вход не найден: «{args.input}». Запусти с --list.", file=sys.stderr)
        return 2
    if l_idx is None:
        print(f"!! Левое устройство не найдено: «{args.left}». Запусти с --list.", file=sys.stderr)
        return 2
    if r_idx is None:
        print(f"!! Правое устройство не найдено: «{args.right}» (BT-колонка подключена?). Запусти с --list.", file=sys.stderr)
        return 2

    sr = args.samplerate
    block = args.blocksize
    gain = args.gain

    if not args.test:
        print(f"ВХОД : {dev_label(in_idx)}")
    print(f"L  -> {dev_label(l_idx)}")
    print(f"R  -> {dev_label(r_idx)}")
    print(f"samplerate={sr}  blocksize={block}  gain={gain}  {'TEST TONES' if args.test else 'CAPTURE'}")

    qL: "queue.Queue" = queue.Queue(maxsize=args.maxbuf)
    qR: "queue.Queue" = queue.Queue(maxsize=args.maxbuf)

    def in_cb(indata, frames, _time, status):
        if status:
            pass
        L = (indata[:, 0] * gain).astype(np.float32).copy()
        R = (indata[:, 1] * gain).astype(np.float32).copy() if indata.shape[1] > 1 else L.copy()
        for q, data in ((qL, L), (qR, R)):
            try:
                q.put_nowait(data)
            except queue.Full:
                try:
                    q.get_nowait()      # drop oldest, keep latency bounded
                    q.put_nowait(data)
                except queue.Empty:
                    pass

    streams = []
    try:
        outL = sd.OutputStream(device=l_idx, channels=2, samplerate=sr, blocksize=block,
                               dtype="float32", callback=make_output_callback(qL, 2, args.tone_left, sr, args.test))
        outR = sd.OutputStream(device=r_idx, channels=2, samplerate=sr, blocksize=block,
                               dtype="float32", callback=make_output_callback(qR, 2, args.tone_right, sr, args.test))
        streams = [outL, outR]
        if not args.test:
            inp = sd.InputStream(device=in_idx, channels=2, samplerate=sr, blocksize=block,
                                 dtype="float32", callback=in_cb)
            streams.insert(0, inp)
        for s in streams:
            s.start()
    except Exception as e:  # noqa: BLE001
        print(f"!! Не удалось открыть потоки: {e}", file=sys.stderr)
        print("   Подсказка: попробуй другой --samplerate (44100/48000) — у BT-устройств часто 48000.", file=sys.stderr)
        for s in streams:
            try:
                s.close()
            except Exception:
                pass
        return 3

    print("\n▶ Идёт разведение каналов. Ctrl+C — стоп.\n")
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nОстановка…")
    finally:
        for s in streams:
            try:
                s.stop(); s.close()
            except Exception:
                pass
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Split stereo: LEFT -> device A, RIGHT -> device B (Windows).")
    p.add_argument("--list", action="store_true", help="показать все аудиоустройства и выйти")
    p.add_argument("--input", default="CABLE Output", help="устройство-источник (имя или индекс). По умолчанию CABLE Output")
    p.add_argument("--left", default="Bob", help="устройство для ЛЕВОГО канала (имя или индекс)")
    p.add_argument("--right", default="JBL", help="устройство для ПРАВОГО канала (имя или индекс)")
    p.add_argument("--samplerate", type=int, default=48000)
    p.add_argument("--blocksize", type=int, default=480)
    p.add_argument("--gain", type=float, default=1.0)
    p.add_argument("--maxbuf", type=int, default=32, help="макс. блоков в буфере на канал (защита от разъезда часов)")
    p.add_argument("--test", action="store_true", help="играть тестовые тоны (L и R разной частоты) без входа")
    p.add_argument("--tone-left", type=float, default=440.0)
    p.add_argument("--tone-right", type=float, default=660.0)
    args = p.parse_args()

    if args.list:
        list_devices()
        return 0
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
