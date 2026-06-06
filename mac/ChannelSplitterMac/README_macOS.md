# Channel Splitter — macOS · Errarium™

Нативный порт `channel-splitter/splitter_gui.py` на **Swift + SwiftUI + AVAudioEngine + Core Audio**.
Собирается **без Xcode**, только через Command Line Tools.

## Реализовано (фазы 1–3)

- **Фаза 1 — ядро вывода:** захват источника → раздача на ≥2 устройства, по одному
  `AVAudioEngine` на колонку (вариант B из ТЗ). Роль (Л/Моно/П), громкость, mute, мастер,
  ON/OFF, тест-сигнал на колонку, индикаторы уровня.
- **Фаза 2 — EQ + эффекты + саб:** 12-полосный `AVAudioUnitEQ` (20 Гц…20 кГц, Q=1.4),
  спектр (vDSP FFT), BASS (low-shelf 110 Гц), SPATIAL (M/S), 3D (Haas), 7.1 SURROUND
  (ранние отражения), сабвуфер с кроссовером (low-pass).
- **Фаза 3 — задержки:** ручной ползунок «Задержка, мс» на колонку + **автокалибровка**:
  лог-свип в каждую колонку, запись микрофоном, кросс-корреляция (vDSP),
  выставление delay lines (`delay = τ_max − τ_i`).

### Версия 1.1 (паритет с Windows-эталоном)

- **Толерантный запуск:** если одна колонка не открылась (занята/не на 48 кГц), остальные
  продолжают играть; список сбойных показывается алертом.
- **Живое переприменение:** добавление/удаление/смена колонки или источника на лету
  перезапускает граф без ручного OFF/ON.
- **Hot-plug устройств:** опрос каждые 4 с (когда остановлено и не идёт калибровка) —
  Bluetooth-колонки появляются в списке без перезапуска.
- **Предупреждение при 3+ колонках:** про лимит BT-чипа (стабильно ≤2 BT) и про
  умные/сетевые колонки (Алиса, Sonos, HomePod), которые видны, но играют только своим кастингом.
- **Калибровка по диапазонам:** каждой колонке свой лог-диапазон chirp (150–7000 Гц),
  щадящая громкость (amp 0.16, фейды 40 мс) — кросс-корреляция не путает колонки.

Параметры взяты из Windows-эталона: SR 48000, блок 960 (~20 мс), кроссовер 120 Гц,
тон-тесты 440/660/550/330/770/220/880/494 Гц.

## Сборка и запуск

```bash
cd mac/ChannelSplitterMac
./build.sh release        # swift build + сборка ChannelSplitter.app + ad-hoc подпись
open ChannelSplitter.app
```

Для логов в консоли: `./ChannelSplitter.app/Contents/MacOS/ChannelSplitter`.

## Зависимости окружения

- **Command Line Tools** (`xcode-select --install`) — Swift 5.9+, macOS SDK.
- **Системный звук («+ System»):** на **macOS 14.2+** захватывается **нативно** через Core Audio
  process taps (`SystemAudioTap.swift`) — **BlackHole НЕ нужен**. Источник «System Audio» по
  умолчанию уже добавлен и тянет весь системный микс (наш собственный вывод исключён, без петли).
  - На **macOS младше 14.2** нативного тапа нет — для системного звука поставьте
    **BlackHole** (MIT, https://github.com/ExistentialAudio/BlackHole): системный выход → BlackHole,
    в приложении выберите BlackHole источником. Физический вход (микрофон/линейный) работает везде.
- Микрофон: при первой калибровке macOS спросит доступ (ключ `NSMicrophoneUsageDescription`).

## Ограничения текущей версии

- Многоканальный декод 5.1/7.1 и матрица ролей — **фаза 4** (не входит сюда).
- Aggregate Device + Drift Correction — **фаза 5**.
- Wi-Fi/AirPlay вывод — **фаза 6**.
- Пресеты EQ (JSON) и ScreenCaptureKit-захват пока не подключены.

## Структура

```
ChannelSplitterMac/
  Package.swift
  build.sh
  Sources/ChannelSplitter/
    ChannelSplitterApp.swift   // @main + AppModel
    ContentView.swift          // UI (тёмная тема Errarium™)
    Models.swift               // константы, Role, OutputSpeaker, SourceConfig, EffectState
    AudioDevices.swift         // перечисление устройств (Core Audio HAL)
    PartyEngine.swift          // граф: захват → ring → [mix→spatial→EQ→delay→gain]→выход
    Calibration.swift          // chirp + микрофон + кросс-корреляция
    DSP.swift                  // ring buffer, FFT-спектр, chirp, корреляция (Accelerate)
  Resources/
    Info.plist, ChannelSplitter.entitlements
```
