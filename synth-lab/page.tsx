"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { playFrequency, stopFrequency, PRESETS, Harmonic, SynthPreset } from "@/lib/frequency-synth";
import { presetStore, UserPresetsMap, AuxTone } from "@/lib/synth-presets-store";

// ── Types ──────────────────────────────────────────────────────────────────

type FrequencyEntry = {
  hz: number;
  label: string;
  description: string;
  chakra?: string;
  planet?: string;
  note?: string;
  instrument?: string;
  /** If set — clicking the entry also loads this preset key from PRESETS into Lab. */
  preset?: string;
};

type FrequencySchool = {
  name: string;
  description: string;
  entries: FrequencyEntry[];
};

// ── Frequency Atlas Data ───────────────────────────────────────────────────

const FREQUENCY_ATLAS: Record<string, FrequencySchool> = {
  solfeggio: {
    name: "Solfeggio",
    description: "Древняя система 9 тонов, популяризована д-ром Джозефом Пулео. Оптимальный инструмент: цифровой генератор / аудиотрек.",
    entries: [
      { hz: 174, label: "Освобождение от боли", chakra: "Корневая", description: "Снижение боли и стресса, ощущение безопасности, анестезирующий эффект.", instrument: "синтезатор" },
      { hz: 285, label: "Восстановление тканей", chakra: "Сакральная", description: "Регенерация клеток и тканей, связь с физическим телом.", instrument: "синтезатор" },
      { hz: 396, label: "Освобождение от страха", chakra: "Корневая", description: "Освобождение от страха и вины, трансформация горя, заземление.", instrument: "синтезатор" },
      { hz: 417, label: "Трансформация", chakra: "Сакральная", description: "Фасилитация перемен, разрушение негативных паттернов, очищение.", instrument: "синтезатор" },
      { hz: 528, label: "Исцеление / ДНК", chakra: "Солнечное сплетение", description: "«Частота чуда», любовь, ясность, репарация ДНК по версии исследователей.", instrument: "синтезатор" },
      { hz: 639, label: "Связь и отношения", chakra: "Сердечная", description: "Гармонизация отношений, коммуникация, баланс эмоций.", instrument: "синтезатор" },
      { hz: 741, label: "Очищение и выражение", chakra: "Горловая", description: "Детоксикация, пробуждение интуиции, решение проблем.", instrument: "синтезатор" },
      { hz: 852, label: "Духовный порядок", chakra: "Третий глаз", description: "Возврат к духовному порядку, пробуждение интуиции, связь с высшим Я.", instrument: "синтезатор" },
      { hz: 963, label: "Единство / Коронная", chakra: "Коронная", description: "Активация шишковидной железы, единство с Вселенной, чистое сознание.", instrument: "синтезатор" },
    ],
  },

  cosmic_octave_chakras: {
    name: "Cosmic Octave — чакры (Hans Cousto)",
    description: "Чакральная карта по Hans Cousto: каждая чакра привязана к планетарной частоте через октавирование астрономических циклов. Альтернатива Solfeggio, цельная космическая логика.",
    entries: [
      { hz: 194.18, label: "Muladhara — корневая",        chakra: "Корневая",            planet: "Земля (день)", description: "Заземление, безопасность, связь с Землёй. Период суточного вращения." },
      { hz: 210.42, label: "Svadhisthana — сакральная",   chakra: "Сакральная",          planet: "Луна",         description: "Эмоции, цикличность, чувственность. Синодический лунный цикл." },
      { hz: 126.22, label: "Manipura — солнечное сплетение", chakra: "Солнечное сплетение", planet: "Солнце",       description: "Воля, центр, лидерство, действие." },
      { hz: 136.10, label: "Anahata — сердце (OM)",       chakra: "Сердечная",           planet: "Земля (год)",  description: "Сердечная чакра, медитация OM, центрирование. Период обращения Земли вокруг Солнца." },
      { hz: 141.27, label: "Vishuddha — горло",           chakra: "Горловая",            planet: "Меркурий",     description: "Коммуникация, ясность речи, ментальность." },
      { hz: 221.23, label: "Ajna — третий глаз",          chakra: "Третий глаз",         planet: "Венера",       description: "Тонкое восприятие, гармония, эстетика, интуиция." },
      { hz: 172.06, label: "Sahasrara — корона",          chakra: "Коронная",            planet: "Платонический год Земли", description: "Единство, прецессия равноденствий, ~25 800 лет." },
    ],
  },

  cosmic_octave_planets: {
    name: "Cosmic Octave — планетарные (Hans Cousto)",
    description: "Планетарные частоты, полученные октавированием астрономических циклов. Hans Cousto, 1978. Используются для планетарных камертонов и гонгов.",
    entries: [
      { hz: 194.18, label: "Земной день / Earth Day",     planet: "Земля (день)",  description: "Период суточного вращения Земли." },
      { hz: 136.10, label: "Земной год / OM",             planet: "Земля (год)",   description: "Период обращения Земли вокруг Солнца. Самый известный камертон Cosmic Octave." },
      { hz: 172.06, label: "Платонический год Земли",     planet: "Прецессия",     description: "Прецессия земной оси, ~25 800 лет." },
      { hz: 210.42, label: "Луна — синодическая",         planet: "Луна",          description: "Полный лунный цикл фаз, 29.53 дня." },
      { hz: 126.22, label: "Солнце",                       planet: "Солнце",        description: "Солнечный принцип: воля, центр." },
      { hz: 141.27, label: "Меркурий",                     planet: "Меркурий",      description: "Орбитальный период Меркурия, 88 дней." },
      { hz: 221.23, label: "Венера",                       planet: "Венера",        description: "Орбитальный период Венеры, 224.7 дня." },
      { hz: 144.72, label: "Марс",                         planet: "Марс",          description: "Орбитальный период Марса, 687 дней." },
      { hz: 183.58, label: "Юпитер",                       planet: "Юпитер",        description: "Орбитальный период Юпитера, 11.86 года." },
      { hz: 147.85, label: "Сатурн",                       planet: "Сатурн",        description: "Орбитальный период Сатурна, 29.46 года." },
      { hz: 207.36, label: "Уран",                         planet: "Уран",          description: "Орбитальный период Урана, 84 года." },
      { hz: 211.44, label: "Нептун",                       planet: "Нептун",        description: "Орбитальный период Нептуна, 164.8 года." },
      { hz: 140.64, label: "Плутон",                       planet: "Плутон",        description: "Орбитальный период Плутона, 248 лет." },
    ],
  },

  note_chakra_440: {
    name: "Нотная чакральная — строй 440 Hz (стандарт)",
    description: "Международный стандарт настройки A4=440 Hz (с 1939 г.). Используется в большинстве современных хрустальных чаш и инструментов фабричного производства.",
    entries: [
      { hz: 261.63, label: "C4 (Middle C) — Корневая",   note: "C", chakra: "Корневая",            description: "Стандартная нота C в строе 440. Теплота, стабильность, заземление.", instrument: "чаша / голос" },
      { hz: 293.66, label: "D4 — Сакральная",            note: "D", chakra: "Сакральная",          description: "Нота D в стандартном строе 440. Поток, чувственность.",              instrument: "чаша / голос" },
      { hz: 164.81, label: "E3 — Солнечное сплетение",   note: "E", chakra: "Солнечное сплетение", description: "Воля, уверенность, центр силы. Нота E третьей октавы.",              instrument: "чаша / камертон E" },
      { hz: 329.63, label: "E4 — Солнечное сплетение",   note: "E", chakra: "Солнечное сплетение", description: "Верхняя октава E. Активность, действие, тепло.",                     instrument: "хрустальная чаша" },
      { hz: 349.23, label: "F4 — Сердечная",             note: "F", chakra: "Сердечная",           description: "Нота F в стандартном строе 440. Любовь, интеграция.",                instrument: "чаша / голос" },
      { hz: 392,    label: "G4 — Горловая",              note: "G", chakra: "Горловая",            description: "Нота G в стандартном строе 440. Самовыражение, правда.",             instrument: "чаша / голос" },
      { hz: 440,    label: "A4 — Стандарт 440 Hz",       note: "A", chakra: "Третий глаз",         description: "Международный стандарт настройки с 1939 г.",                        instrument: "камертон 440" },
      { hz: 493.88, label: "B4 — Коронная",              note: "B", chakra: "Коронная",            description: "Нота B в стандартном строе 440. Единство.",                          instrument: "чаша / голос" },
    ],
  },

  note_chakra_432: {
    name: "Нотная чакральная — строй 432 Hz (альтернативный)",
    description: "«Природный» / «верди-строй» с A4=432 Hz. Альтернатива стандарту 440. Используется в некоторых эзотерических практиках, ручных тибетских чашах, sound healing наборах. Многие чаши настроены не точно — реальная частота может отклоняться на 20–30 центов (например, бытовая практическая E ≈ 167 Hz).",
    entries: [
      { hz: 256,    label: "C3 — Корневая (низкая)",     note: "C", chakra: "Корневая",            description: "Заземление, безопасность, выживание. Чистый математический строй (256 = 2⁸).", instrument: "чаша / колокол" },
      { hz: 288,    label: "D3 — Сакральная (низкая)",   note: "D", chakra: "Сакральная",          description: "Творчество, сексуальность, чувственность, поток.",                            instrument: "чаша" },
      { hz: 167,    label: "E3+ — Солнечное сплетение (практическая)", note: "E", chakra: "Солнечное сплетение", description: "Практический вариант E3 ≈ 167 Hz (E +28 центов) — реальная частота тибетских чаш для solar plexus.", instrument: "тибетская чаша" },
      { hz: 171,    label: "F3 — Сердечная (низкая)",    note: "F", chakra: "Сердечная",           description: "Любовь, сострадание, интеграция.",                                            instrument: "чаша" },
      { hz: 192,    label: "G3 — Горловая (низкая)",     note: "G", chakra: "Горловая",            description: "Самовыражение, коммуникация, правда.",                                        instrument: "чаша" },
      { hz: 216,    label: "A3 — Третий глаз",            note: "A", chakra: "Третий глаз",         description: "Интуиция, видение, ясность. Нота A в строе 432.",                            instrument: "камертон 432 / чаша" },
      { hz: 432,    label: "A4 — Третий глаз (эталон 432)", note: "A", chakra: "Третий глаз",      description: "«Природный» строй. Эталон альтернативной настройки.",                         instrument: "камертон 432" },
      { hz: 240,    label: "B3 — Коронная (низкая)",     note: "B", chakra: "Коронная",            description: "Единство, духовное пробуждение, связь с Вселенной.",                          instrument: "чаша" },
    ],
  },

  earth_moon_schumann: {
    name: "Земля / Луна / Шуман / звёзды",
    description: "Частоты процессов, а не нот: вращение Земли, лунные циклы, резонанс Шумана, геомагнитное поле, галактическая орбита, Сириус. Источник: Planetware, NASA.",
    entries: [
      { hz: 7.83,   label: "Шуман 1 — основной резонанс",  description: "Базовая резонансная частота полости Земля–ионосфера. Соответствует тета-волнам мозга. Слышимо только через бинауральные пары или октавирование.", instrument: "бинауральный (наушники)" },
      { hz: 14.3,   label: "Шуман 2",                      description: "Вторая гармоника резонанса Шумана. Альфа/бета-переход.", instrument: "бинауральный (наушники)" },
      { hz: 20.8,   label: "Шуман 3",                      description: "Третья гармоника. Бета-диапазон.", instrument: "бинауральный (наушники)" },
      { hz: 250.56, label: "Шуман — октавный тон",         description: "7.83 Hz × 2⁵ = 250.56 Hz. Слышимый аналог резонанса Шумана.", instrument: "генератор / камертон" },
      { hz: 9.36,   label: "Геомагнитное поле, максимум",  description: "Пик геомагнитного спектра.", instrument: "бинауральный" },
      { hz: 149.74, label: "Геомагнитное — октавный тон",  description: "Октавированная геомагнитная частота, слышимый аналог.", instrument: "генератор" },
      { hz: 194.71, label: "Сидерический день Земли",       description: "Вращение Земли относительно звёзд (≈23ч 56мин), октавированное.", instrument: "камертон / генератор" },
      { hz: 187.61, label: "Кульминация Луны",              description: "Время прохода Луны от одной кульминации до следующей.", instrument: "камертон" },
      { hz: 227.43, label: "Сидерическая Луна",             description: "Оборот Луны относительно звёзд.", instrument: "камертон" },
      { hz: 229.22, label: "Метонов цикл Луны",             description: "Лунно-солнечный цикл ~19 лет.", instrument: "камертон" },
      { hz: 241.56, label: "Сарос — цикл затмений",         description: "Повторение затмений похожего типа, ~18 лет 11 дней.", instrument: "камертон" },
      { hz: 246.04, label: "Лунные апсиды",                  description: "Перигей/апогей, ось лунной орбиты.", instrument: "камертон" },
      { hz: 234.16, label: "Лунные узлы",                    description: "Северный/Южный узел Луны — «голова и хвост дракона».", instrument: "камертон" },
      { hz: 154.15, label: "Орбита Солнечной системы вокруг центра Галактики", description: "Галактический год, ~225 млн лет.", instrument: "генератор / drone" },
      { hz: 174,    label: "Сириус — двойная звезда",        description: "Октавированная частота двойной системы Сириуса. Звёздный слой.", instrument: "генератор / drone" },
    ],
  },

  hydrogen: {
    name: "Водородный спектр",
    description: "Спектральные линии атома водорода (серия Бальмера), октавированные в слышимый диапазон. Редкая эзотерическая система — микрокосм и макрокосм. Оптимальный инструмент: синтезатор.",
    entries: [
      { hz: 207.67, label: "Hα — красная линия", description: "Первая линия серии Бальмера (656.3 нм). Самая интенсивная линия водорода. Близко к Урану (207.36).", instrument: "синтезатор / drone" },
      { hz: 140.18, label: "Hβ — голубая линия", description: "Вторая линия серии Бальмера (486.1 нм). Близко к Плутону (140.64) и Меркурию (141.27).", instrument: "синтезатор / drone" },
      { hz: 157,    label: "Hγ — фиолетовая линия", description: "Третья линия серии Бальмера (434.0 нм).", instrument: "синтезатор / drone" },
      { hz: 166.14, label: "Hδ — глубокая фиолетовая", description: "Четвёртая линия серии Бальмера (410.1 нм). Почти совпадает с нотой E (164.81–167 Hz) — солнечное сплетение.", instrument: "синтезатор / drone" },
      { hz: 171.65, label: "Hε — граница видимого", description: "Пятая линия серии Бальмера (397.0 нм). Граница видимого/ультрафиолетового. Близко к Hε = сердечная нота F (171 Hz).", instrument: "синтезатор / drone" },
    ],
  },

  // ─── Инструменты практики (полный пробор.md) — каждый отдельной школой ───

  tuning_forks: {
    name: "Камертоны",
    description: "Самый точный инструмент для индивидуальной настройки. Используется в Cosmic Octave / Hans Cousto. Утяжелённые камертоны ставят на тело — кости, суставы, точки.",
    entries: [
      { hz: 126.22, label: "Камертон Солнца",            planet: "Солнце",        description: "Воля, центр, лидерство, действие.",                                                instrument: "камертон",        preset: "tuning_fork" },
      { hz: 136.10, label: "Камертон OM / Earth Year",   planet: "Земля год", chakra: "Сердечная", description: "Самый распространённый камертон Cosmic Octave. OM, медитация.", instrument: "камертон",       preset: "tuning_fork" },
      { hz: 194.18, label: "Камертон Earth Day",         planet: "Земля день", chakra: "Корневая", description: "Утяжелённый — для тела, костей, заземления.",                  instrument: "камертон (тело)", preset: "tuning_fork" },
      { hz: 221.23, label: "Камертон Венеры",            planet: "Венера",        description: "Тонкое восприятие, красота, гармония.",                                            instrument: "камертон",        preset: "tuning_fork" },
      { hz: 147.85, label: "Камертон Сатурна",           planet: "Сатурн",        description: "Структура, границы, дисциплина.",                                                  instrument: "камертон",        preset: "tuning_fork" },
      { hz: 141.27, label: "Камертон Меркурия",          planet: "Меркурий",   chakra: "Горловая", description: "Коммуникация, ясность речи.",                                    instrument: "камертон",        preset: "tuning_fork" },
      { hz: 256,    label: "Master Fork — Steiner C=256", note: "C",              description: "Историческая нота C=256 Hz по Штайнеру / Verdi. Базовый научный строй.",          instrument: "камертон 256",    preset: "tuning_fork" },
      { hz: 128,    label: "Otto 128 (тело)",                                     description: "Низкий камертон для глубокой работы с телом, костями, фасциями.",                  instrument: "камертон (тело)", preset: "tuning_fork" },
    ],
  },

  singing_bowls: {
    name: "Поющие чаши",
    description: "Хрустальные и тибетские чаши. Работают через нотную чакральную систему (C-D-E-F-G-A-B), а не через точные Hz. Реальные чаши часто +20–30 центов от стандарта.",
    entries: [
      { hz: 261.63, label: "Хрустальная чаша C — Корневая",       note: "C", chakra: "Корневая",            description: "Кварцевая чаша на корневой ноте. Чистый высокий обертон, заземление.",                          instrument: "хрустальная чаша", preset: "bowl" },
      { hz: 293.66, label: "Хрустальная чаша D — Сакральная",     note: "D", chakra: "Сакральная",          description: "Поток, чувственность, творчество.",                                                              instrument: "хрустальная чаша", preset: "bowl" },
      { hz: 167,    label: "Тибетская чаша E (167 Hz, +28 cents)", note: "E", chakra: "Солнечное сплетение", description: "Реальная антикварная чаша E настроена ≈ 167 Hz. Solar plexus.",                                instrument: "тибетская чаша",   preset: "singing_bowl" },
      { hz: 349.23, label: "Хрустальная чаша F — Сердечная",      note: "F", chakra: "Сердечная",           description: "Любовь, сострадание, интеграция.",                                                               instrument: "хрустальная чаша", preset: "bowl" },
      { hz: 392,    label: "Хрустальная чаша G — Горловая",       note: "G", chakra: "Горловая",            description: "Самовыражение, правда.",                                                                         instrument: "хрустальная чаша", preset: "bowl" },
      { hz: 432,    label: "Чаша A=432 — Третий глаз",            note: "A", chakra: "Третий глаз",         description: "«Природный строй». A=432 — альтернатива стандарту 440.",                                         instrument: "чаша 432",         preset: "bowl" },
      { hz: 493.88, label: "Хрустальная чаша B — Коронная",       note: "B", chakra: "Коронная",            description: "Единство, духовное пробуждение.",                                                                instrument: "хрустальная чаша", preset: "bowl" },
    ],
  },

  gongs: {
    name: "Гонги",
    description: "Не точная частота, а облако обертонов. Планетарные гонги (Paiste и др.) настраиваются на Cosmic Octave частоты планет. Используются для трансовых и групповых практик.",
    entries: [
      { hz: 126.22, label: "Гонг Солнца",   planet: "Солнце",   description: "Архетип Солнца: воля, центр, лидерство.",                instrument: "планетарный гонг", preset: "gong" },
      { hz: 210.42, label: "Гонг Луны",     planet: "Луна",     description: "Эмоциональный мир, цикличность, женский поток.",         instrument: "планетарный гонг", preset: "gong" },
      { hz: 221.23, label: "Гонг Венеры",   planet: "Венера",   description: "Мягкость, красота, отношения, принятие.",                instrument: "планетарный гонг", preset: "gong" },
      { hz: 144.72, label: "Гонг Марса",    planet: "Марс",     description: "Воля, действие, преодоление. Резкое поле.",              instrument: "планетарный гонг", preset: "gong" },
      { hz: 183.58, label: "Гонг Юпитера",  planet: "Юпитер",   description: "Расширение, рост, изобилие.",                            instrument: "планетарный гонг", preset: "gong" },
      { hz: 147.85, label: "Гонг Сатурна",  planet: "Сатурн",   description: "Границы, структура, завершение, дисциплина.",            instrument: "планетарный гонг", preset: "gong" },
      { hz: 207.36, label: "Гонг Урана",    planet: "Уран",     description: "Прорыв, инновация, электрическая трансформация.",        instrument: "планетарный гонг", preset: "gong" },
      { hz: 211.44, label: "Гонг Нептуна",  planet: "Нептун",   description: "Растворение границ, мечта, мистика.",                    instrument: "планетарный гонг", preset: "gong" },
      { hz: 140.64, label: "Гонг Плутона",  planet: "Плутон",   description: "Глубинная трансформация, смерть-возрождение.",           instrument: "планетарный гонг", preset: "gong" },
      { hz: 136.10, label: "Гонг OM / Земля год", planet: "Земля год", chakra: "Сердечная", description: "Сердечный гонг, OM, центрирование.", instrument: "планетарный гонг", preset: "gong" },
    ],
  },

  chimes: {
    name: "Колокольчики",
    description: "Тонкий металлический звон, прочищает каналы. Часто используются перед практикой как «открытие пространства».",
    entries: [
      { hz: 141.27, label: "Колокольчики Меркурия", planet: "Меркурий", chakra: "Горловая", description: "Прочищают канал коммуникации, активируют горловой центр.", instrument: "колокольчики", preset: "bell" },
      { hz: 432,    label: "Колокольчики 432",      note: "A",          description: "Колокольчики в строе 432 Hz.",                                                  instrument: "колокольчики", preset: "bell" },
      { hz: 528,    label: "Колокольчики Solfeggio", chakra: "Солнечное сплетение", description: "Колокольчики на Solfeggio MI = «частота чуда».", instrument: "колокольчики", preset: "bell" },
    ],
  },

  drones: {
    name: "Монохорд / тамбура / шрути-бокс",
    description: "Дрон-инструменты — длительное непрерывное звучание. Хороши для удержания поля, OM-практик, медитации, дыхания. Не «частота включилась-выключилась», а удержание пространства.",
    entries: [
      { hz: 136.10, label: "Монохорд OM",         chakra: "Сердечная",            description: "Длинный смычковый дрон на OM, дыхательные практики.",        instrument: "монохорд",     preset: "monochord" },
      { hz: 432,    label: "Монохорд A=432",      note: "A",                       description: "Дрон в строе 432 Hz. Богатый обертоновый стек.",             instrument: "монохорд",     preset: "monochord" },
      { hz: 261.63, label: "Монохорд C — корень", note: "C", chakra: "Корневая",   description: "Низкий заземляющий дрон.",                                    instrument: "монохорд",     preset: "monochord" },
      { hz: 136.10, label: "Шрути-бокс OM",       chakra: "Сердечная",            description: "Индийский гармониум-дрон под мантру или дыхание.",            instrument: "шрути-бокс",   preset: "shruti_box" },
      { hz: 167,    label: "Шрути-бокс E",        note: "E", chakra: "Солнечное сплетение", description: "Шрути для солнечного сплетения через ноту E.",      instrument: "шрути-бокс",   preset: "shruti_box" },
      { hz: 220,    label: "Тамбура A — третий глаз", note: "A", chakra: "Третий глаз", description: "Индийский струнный дрон.",                                instrument: "тамбура",      preset: "monochord" },
    ],
  },

  drums: {
    name: "Барабаны",
    description: "Здесь Hz — это не тон, а ритм. Шаманский барабан работает в диапазоне 4–7 ударов/сек (тета). Для трансовых практик и шаманских путешествий.",
    entries: [
      { hz: 80,  label: "Фрейм-барабан — одиночный удар",   description: "Низкий короткий удар, тёмное тело. Мембрана (1,1) на 1.59×.",                                       instrument: "фрейм-барабан",     preset: "drum" },
      { hz: 100, label: "Шаманский барабан — тета 5 Hz",     description: "5 ударов в секунду, тета-ритм. Шаманские путешествия, трансовые практики.",                          instrument: "шаманский барабан", preset: "shamanic_drum" },
      { hz: 70,  label: "Шаманский барабан медленный",       description: "Тот же ритм 5 Hz, более низкий несущий тон — глубже.",                                               instrument: "шаманский барабан", preset: "shamanic_drum" },
      { hz: 90,  label: "Барабан — мягкий транс 4 Hz",       description: "Мягкое трансовое состояние (на самом пресете нужно вручную поменять Wobble Hz на 4).",                instrument: "шаманский барабан", preset: "shamanic_drum" },
      { hz: 110, label: "Барабан — более активный 7 Hz",     description: "Более активная настройка (вручную установить Wobble Hz=7 в Лаборатории).",                            instrument: "шаманский барабан", preset: "shamanic_drum" },
    ],
  },

  binaural: {
    name: "Бинауральные / монауральные биения",
    description: "Два близких тона = слышимое биение. ИСТИННЫЙ binaural требует наушников: левое ухо — одна частота, правое — другая, мозг создаёт разностный ритм. Пресет binaural_theta использует стерео-pan ±1.",
    entries: [
      { hz: 200,    label: "Бинауральный тета 7.8 Hz",  description: "Стерео-пара даёт ~7.8 Hz при базе 200 Hz. Тета: медитация, гипноз. ОБЯЗАТЕЛЬНО в наушниках.",      instrument: "бинауральный (наушники)", preset: "binaural_theta" },
      { hz: 136.10, label: "Бинауральный OM",            description: "Стерео-пара в районе OM. Релаксация.",                                                              instrument: "бинауральный (наушники)", preset: "binaural_theta" },
      { hz: 100,    label: "Бинауральный альфа ≈8–12 Hz", description: "При базе 100 Hz и multiple ≈1.08 даёт ~8 Hz (альфа-расслабление). Для тонкой настройки — Лаборатория.", instrument: "бинауральный (наушники)", preset: "binaural_theta" },
      { hz: 250.56, label: "Шуман — октавный тон",        description: "Слышимый аналог 7.83 Hz (× 2⁵). Без наушников.",                                                       instrument: "генератор" },
      { hz: 7.83,   label: "Шуман прямой 7.83 Hz",        description: "Базовый резонанс Шумана. На такой частоте слышимого тона нет — только бинауральная пара через наушники.", instrument: "бинауральный (наушники)", preset: "binaural_theta" },
    ],
  },

  digital_solfeggio: {
    name: "Цифровой генератор / синтезатор Solfeggio",
    description: "Самый точный способ для Solfeggio-тонов. Цифровой звук = идеальный sine на нужной частоте. Без пресета — стандартного sine достаточно.",
    entries: [
      { hz: 174, label: "UT — освобождение от боли",  chakra: "Корневая",            description: "Solfeggio 174 Hz: безопасность, обезболивание.",            instrument: "синтезатор" },
      { hz: 285, label: "Восстановление тканей",       chakra: "Сакральная",          description: "Solfeggio 285 Hz: регенерация, физическое тело.",          instrument: "синтезатор" },
      { hz: 396, label: "UT — освобождение от страха", chakra: "Корневая",            description: "Solfeggio 396 Hz: освобождение от страха, заземление.",     instrument: "синтезатор" },
      { hz: 417, label: "RE — трансформация",          chakra: "Сакральная",          description: "Solfeggio 417 Hz: фасилитация перемен.",                    instrument: "синтезатор" },
      { hz: 528, label: "MI — частота чуда",           chakra: "Солнечное сплетение", description: "Solfeggio 528 Hz: ДНК, ясность, любовь.",                   instrument: "синтезатор" },
      { hz: 639, label: "FA — связь и отношения",      chakra: "Сердечная",           description: "Solfeggio 639 Hz: гармонизация отношений.",                 instrument: "синтезатор" },
      { hz: 741, label: "SOL — очищение",              chakra: "Горловая",            description: "Solfeggio 741 Hz: детоксикация, выражение.",                instrument: "синтезатор" },
      { hz: 852, label: "LA — духовный порядок",       chakra: "Третий глаз",         description: "Solfeggio 852 Hz: интуиция, высшее Я.",                     instrument: "синтезатор" },
      { hz: 963, label: "SI — единство",               chakra: "Коронная",            description: "Solfeggio 963 Hz: чистое сознание, шишковидная железа.",    instrument: "синтезатор" },
    ],
  },

  voice: {
    name: "Голос / биджа-мантры",
    description: "Внутреннее включение — голос даёт не точную частоту, а живую вибрацию тела. Биджа-мантры активируют чакры через резонанс собственного тела. Без пресета (голос ≠ синтез).",
    entries: [
      { hz: 136.10, label: "OM на 136.10 Hz", chakra: "Сердечная",            description: "Пение OM на частоте Earth Year. Не каждый голос комфортно попадает в эту высоту." },
      { hz: 196,    label: "LAM — корневая",   chakra: "Корневая",             description: "Биджа-мантра корневой чакры. Заземление, безопасность." },
      { hz: 220,    label: "VAM — сакральная", chakra: "Сакральная",           description: "Биджа сакральной чакры. Творчество, поток." },
      { hz: 167,    label: "RAM — solar plexus", chakra: "Солнечное сплетение", note: "E", description: "Биджа солнечного сплетения. Воля, уверенность." },
      { hz: 174,    label: "YAM — сердечная",  chakra: "Сердечная",            description: "Биджа сердца. Любовь, сострадание." },
      { hz: 196,    label: "HAM — горловая",   chakra: "Горловая",             note: "G", description: "Биджа горла. Самовыражение, правда." },
      { hz: 220,    label: "OM — третий глаз / корона", chakra: "Третий глаз / Коронная", description: "Универсальная мантра, верхние центры." },
    ],
  },

  // ─── Снимок текущей конфигурации сайта ───
  site_resonance: {
    name: "Резонанс на сайте (/space/resonance)",
    description: "Текущие 7 карточек с вкладки «Звук» на странице резонанса. Источник: content/oil_sound_matrix.json. Клик по записи загружает в Лабораторию точно тот пресет, который сейчас играет на сайте — для тонкой подстройки.",
    entries: [
      { hz: 528,    label: "Хрустальная чаша · Личность · Солнце",   chakra: "Солнечное сплетение", description: "528 Hz — частота трансформации и витальной перестройки. Освобождает блоки самовыражения.", instrument: "хрустальная чаша",  preset: "bowl" },
      { hz: 210.42, label: "Тибетская поющая чаша · Эмоции · Луна",  chakra: "Сакральная", planet: "Луна", description: "210.42 Hz — синодическая частота Луны. Углубляет дыхание, готовит ко сну.",        instrument: "тибетская чаша",    preset: "singing_bowl" },
      { hz: 141.27, label: "Колокольчики · Ум · Меркурий",            chakra: "Горловая", planet: "Меркурий", description: "141.27 Hz — частота Меркурия. Прочищает канал коммуникации.",                  instrument: "колокольчики",      preset: "bell" },
      { hz: 639,    label: "Арфа · Чувства · Венера",                 chakra: "Сердечная", planet: "Венера", description: "639 Hz — гармонизация отношений. Мягкие волновые узоры.",                       instrument: "арфа",              preset: "harp" },
      { hz: 144.72, label: "Барабан · Действие · Марс",               planet: "Марс", description: "144.72 Hz — частота Марса. Возвращает ритм, активирует муладхару.",                                  instrument: "барабан",           preset: "drum" },
      { hz: 183.58, label: "Орган · Рост · Юпитер",                   planet: "Юпитер", description: "183.58 Hz — частота Юпитера. Расширяющие гармоники.",                                              instrument: "орган",             preset: "organ" },
      { hz: 147.85, label: "Контрабас · Закон · Сатурн",              planet: "Сатурн", description: "147.85 Hz — частота Сатурна. Глубокий удерживающий тон, структура.",                              instrument: "контрабас",         preset: "bass" },
    ],
  },
};

// ── Tab label map ──────────────────────────────────────────────────────────

// Читаемые имена пресетов для отображения в плеере
const PRESET_LABELS: Record<string, string> = {
  bowl:           "Хрустальная чаша",
  singing_bowl:   "Тибетская поющая чаша",
  bell:           "Колокольчики",
  harp:           "Арфа",
  drum:           "Фрейм-барабан",
  organ:          "Орган",
  bass:           "Контрабас",
  gong:           "Гонг",
  tuning_fork:    "Камертон",
  monochord:      "Монохорд",
  shruti_box:     "Шрути-бокс",
  shamanic_drum:  "Шаманский барабан",
  binaural_theta: "Бинауральный тета",
};

const TAB_LABELS: Record<string, string> = {
  atlas: "Атлас частот",
  presets: "Пресеты",
  lab: "Лаборатория",
};

// ── Component ──────────────────────────────────────────────────────────────

export default function SynthLabPage() {
  const router = useRouter();

  // Navigation
  const [activeTab, setActiveTab] = useState<"atlas" | "presets" | "lab">("atlas");

  // Tab-aware history: switching tabs pushes a state, browser/mouse back
  // navigates between tabs in reverse order. Back from atlas → leaves page.
  useEffect(() => {
    window.history.replaceState({ synthLabTab: "atlas" }, "", window.location.href);
    const handlePop = (e: PopStateEvent) => {
      const tab = e.state?.synthLabTab;
      if (tab === "atlas" || tab === "presets" || tab === "lab") {
        setActiveTab(tab);
      }
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  function changeTab(next: "atlas" | "presets" | "lab") {
    if (next === activeTab) return;
    setActiveTab(next);
    window.history.pushState({ synthLabTab: next }, "", window.location.href);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Playback
  const [isPlaying, setIsPlaying] = useState(false);

  // Synth state (shared across tabs)
  const [baseHz, setBaseHz] = useState<number>(136.10);
  const [waveform, setWaveform] = useState<OscillatorType>("sine");
  const [attackSec, setAttackSec] = useState<number>(0.6);
  const [releaseSec, setReleaseSec] = useState<number>(1.2);
  const [lowpassHz, setLowpassHz] = useState<number | "">(4500);
  const [peakGain, setPeakGain] = useState<number>(0.18);
  const [harmonics, setHarmonics] = useState<Harmonic[]>([
    { multiple: 1.000, gainRatio: 1.00, detuneCentsRange: 3 },
    { multiple: 2.400, gainRatio: 0.18, detuneCentsRange: 5, wobbleHz: 0.4 },
    { multiple: 4.500, gainRatio: 0.08, detuneCentsRange: 5, wobbleHz: 0.3 },
    { multiple: 7.200, gainRatio: 0.03, detuneCentsRange: 5 },
  ]);

  // Auxiliary independent tones
  const [auxTones, setAuxTones] = useState<AuxTone[]>([
    { hz: 528, gainRatio: 0.3, wobbleHz: 0.2, wobbleDepth: 0.5 },
    { hz: 194.18, gainRatio: 0.2, wobbleHz: 0.5, wobbleDepth: 0.6 },
  ]);

  // Preset state
  const [activePresetKey, setActivePresetKey] = useState<string | null>(null);
  const [currentLabel, setCurrentLabel] = useState<string | null>(null); // "что сейчас играет" — для шапки
  const [exportCopied, setExportCopied] = useState(false);

  // Player master volume + mute (поверх Peak Gain пресета)
  const [masterVolume, setMasterVolume] = useState<number>(1.0);
  const [muted, setMuted] = useState<boolean>(false);
  const effectivePeakGain = peakGain * masterVolume * (muted ? 0 : 1);

  // ── User presets (localStorage) ──
  const [userPresets, setUserPresets] = useState<UserPresetsMap>({});
  const [presetName, setPresetName] = useState<string>("");
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    void presetStore.list().then(setUserPresets);
  }, []);

  // Effective preset lookup: user override first, then default
  function resolvePreset(key: string): SynthPreset | null {
    return userPresets[key] ?? PRESETS[key] ?? null;
  }

  function buildCurrentPresetForSave(): SynthPreset & { auxTones?: AuxTone[] } {
    return {
      waveform,
      attackSec,
      releaseSec,
      lowpassHz: lowpassHz === "" ? undefined : Number(lowpassHz),
      harmonics: [...harmonics],
      auxTones: auxTones.length > 0 ? [...auxTones] : undefined,
    };
  }

  async function handleSaveUserPreset() {
    const name = presetName.trim();
    if (!name) { setSavedHint("Введи имя пресета"); return; }

    // Confirm overwrite
    const isDefault = !!PRESETS[name];
    const isUserOverride = !!userPresets[name];
    if (isDefault || isUserOverride) {
      const msg = isDefault
        ? `«${name}» — это дефолтный пресет. Твоя версия его перекроет (дефолт сохранён, можно сбросить через ↺).`
        : `«${name}» уже есть в твоих пресетах. Перезаписать?`;
      if (!window.confirm(msg)) return;
    }

    const saved = await presetStore.save(name, buildCurrentPresetForSave());
    setUserPresets(prev => ({ ...prev, [name]: saved }));
    setActivePresetKey(name);
    setSavedHint(`✓ Сохранён «${name}»`);
    setTimeout(() => setSavedHint(null), 2500);
  }

  async function handleDeleteUserPreset(name: string) {
    if (!window.confirm(`Удалить «${name}»?${PRESETS[name] ? " (Дефолт остаётся)" : ""}`)) return;
    await presetStore.delete(name);
    setUserPresets(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (activePresetKey === name) setActivePresetKey(null);
  }

  async function handleResetToDefault(name: string) {
    if (!PRESETS[name]) return;
    if (!window.confirm(`Сбросить «${name}» к дефолту? Твоя версия удалится.`)) return;
    await presetStore.delete(name);
    setUserPresets(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setSavedHint(`↺ «${name}» восстановлен`);
    setTimeout(() => setSavedHint(null), 2500);
  }

  // Поиск контекста (школа, чакра, планета, назначение) по текущей Hz
  function findHzContext(hz: number): { school: string; entry: FrequencyEntry } | null {
    for (const [, school] of Object.entries(FREQUENCY_ATLAS)) {
      const match = school.entries.find(e => Math.abs(e.hz - hz) < 0.05);
      if (match) return { school: school.name, entry: match };
    }
    return null;
  }
  const currentHzContext = findHzContext(baseHz);

  // Custom tooltip — event-delegated, reads `data-tip` from any element under cursor
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  function handleTipOver(e: React.MouseEvent<HTMLDivElement>) {
    let el = e.target as HTMLElement | null;
    while (el && el !== e.currentTarget && !el.dataset.tip) el = el.parentElement;
    if (el?.dataset.tip) {
      // Привязываем к label-обёртке, чтобы тултип был выше заголовка поля, а не над инпутом
      const anchor = (el.closest("label") as HTMLElement | null) ?? el;
      const r = anchor.getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.top - 14 + window.scrollY, text: el.dataset.tip });
    }
  }
  function handleTipOut() { setTip(null); }

  // ── Computed current options ──
  // Aux tones are merged into harmonics as absoluteHz partials before playback.

  function buildAllHarmonics(h: Harmonic[], aux: AuxTone[]): Harmonic[] {
    return [
      ...h,
      ...aux.map(t => ({
        multiple: 1,
        gainRatio: t.gainRatio,
        absoluteHz: t.hz,
        waveform: t.waveform,
        wobbleHz: t.wobbleHz,
        wobbleDepth: t.wobbleDepth,
        detuneCentsRange: t.detuneCentsRange,
        attackSec: t.attackSec,
        releaseSec: t.releaseSec,
      })),
    ];
  }

  const currentOptions = {
    waveform,
    attackSec,
    releaseSec,
    lowpassHz: lowpassHz === "" ? undefined : Number(lowpassHz),
    harmonics: buildAllHarmonics(harmonics, auxTones),
    peakGain: effectivePeakGain,
    loop: true as const,
  };

  // ── Playback handlers ──

  function handlePlay(hz = baseHz, opts = currentOptions) {
    stopFrequency();
    playFrequency(hz, opts);
    setIsPlaying(true);
  }

  // Live-restart — rebuilds full harmonics (main + aux) and restarts playback.
  // Pass pre-flush values as overrides since React state hasn't updated yet.
  function liveRestart(overrides: {
    baseHz?: number; waveform?: OscillatorType;
    attackSec?: number; releaseSec?: number;
    lowpassHz?: number; peakGain?: number;
    harmonics?: Harmonic[]; auxTones?: AuxTone[];
  } = {}) {
    if (!isPlaying) return;
    const hz = overrides.baseHz ?? baseHz;
    const allHarmonics = buildAllHarmonics(
      overrides.harmonics ?? harmonics,
      overrides.auxTones ?? auxTones,
    );
    const opts = { ...currentOptions, ...overrides, harmonics: allHarmonics };
    setTimeout(() => {
      stopFrequency();
      playFrequency(hz, opts);
    }, 0);
  }

  function handleStop() {
    stopFrequency();
    setIsPlaying(false);
  }

  function handleTogglePlay() {
    if (isPlaying) handleStop();
    else handlePlay();
  }

  // ── Atlas → Lab sync ──

  function handleFrequencySelect(entry: FrequencyEntry) {
    setBaseHz(entry.hz);

    // Resolve playback params: preset (if any) overrides current Lab state
    // Lookup priority: user override → default
    let harmonicsV = harmonics;
    const p = entry.preset ? resolvePreset(entry.preset) : null;
    if (p && entry.preset) {
      harmonicsV = [...p.harmonics];
      // Sync Lab state — параметры всегда отражают то, что играет (или будет играть)
      setWaveform(p.waveform);
      setAttackSec(p.attackSec);
      setReleaseSec(p.releaseSec);
      setLowpassHz(p.lowpassHz ?? "");
      setHarmonics([...p.harmonics]);
      setActivePresetKey(entry.preset);
      setPresetName(entry.preset);
      setCurrentLabel(entry.label);
    } else {
      // No preset — clear active preset so badge/highlight stay in sync
      setActivePresetKey(null);
      setCurrentLabel(entry.label);
    }

    // НЕ запускаем звук насильно. Только переключаем если уже играет.
    // Стартовать = только Play в шапке.
    liveRestart({ baseHz: entry.hz, harmonics: harmonicsV });
  }

  // ── Preset handlers ──

  function handleLoadPreset(key: string) {
    const p = resolvePreset(key);
    if (!p) return;
    setWaveform(p.waveform);
    setAttackSec(p.attackSec);
    setReleaseSec(p.releaseSec);
    setLowpassHz(p.lowpassHz ?? "");
    setHarmonics([...p.harmonics]);
    setAuxTones((p as { auxTones?: AuxTone[] }).auxTones ? [...((p as { auxTones?: AuxTone[] }).auxTones!)] : []);
    setActivePresetKey(key);
    setPresetName(key);
    setCurrentLabel(PRESET_LABELS[key] ?? key);
  }

  function handlePlayPreset(key: string) {
    const p = resolvePreset(key);
    if (!p) return;
    // Set state for Lab display
    setWaveform(p.waveform);
    setAttackSec(p.attackSec);
    setReleaseSec(p.releaseSec);
    setLowpassHz(p.lowpassHz ?? "");
    setHarmonics([...p.harmonics]);
    const presetAux = (p as { auxTones?: AuxTone[] }).auxTones ? [...((p as { auxTones?: AuxTone[] }).auxTones!)] : [];
    setAuxTones(presetAux);
    setActivePresetKey(key);
    setPresetName(key);
    setCurrentLabel(PRESET_LABELS[key] ?? key);
    // Play directly from preset params (not state — batching)
    stopFrequency();
    playFrequency(baseHz, {
      waveform: p.waveform,
      attackSec: p.attackSec,
      releaseSec: p.releaseSec,
      lowpassHz: p.lowpassHz,
      harmonics: p.harmonics,
      peakGain,
      loop: true,
    });
    setIsPlaying(true);
  }

  // ── Harmonics editor ──

  function addHarmonic() {
    setHarmonics([...harmonics, { multiple: 2.0, gainRatio: 0.3 }]);
  }

  function removeHarmonic(index: number) {
    const next = harmonics.filter((_, i) => i !== index);
    setHarmonics(next);
    liveRestart({ harmonics: next });
  }

  function updateHarmonic(index: number, field: keyof Harmonic, value: number | string) {
    const next = [...harmonics];
    if (value === "" || value === undefined) {
      const h = { ...next[index] };
      delete h[field];
      next[index] = h;
    } else {
      next[index] = { ...next[index], [field]: Number(value) };
    }
    setHarmonics(next);
    liveRestart({ harmonics: next });
  }

  // ── Auxiliary tones ──

  function addAuxTone() {
    const next = [...auxTones, { hz: 432, gainRatio: 0.2, wobbleHz: 0.3, wobbleDepth: 0.6 }];
    setAuxTones(next);
    liveRestart({ auxTones: next });
  }

  function removeAuxTone(index: number) {
    const next = auxTones.filter((_, i) => i !== index);
    setAuxTones(next);
    liveRestart({ auxTones: next });
  }

  function updateAuxTone(index: number, field: keyof AuxTone, value: number | string) {
    const next = [...auxTones];
    if (value === "" || value === undefined) {
      const t = { ...next[index] };
      delete t[field as keyof typeof t];
      next[index] = t as AuxTone;
    } else {
      next[index] = { ...next[index], [field]: field === "waveform" ? value : Number(value) };
    }
    setAuxTones(next);
    liveRestart({ auxTones: next });
  }

  // ── Export ──

  function exportPreset() {
    const code = `my_custom_preset: {
  waveform: "${waveform}",
  attackSec: ${attackSec},
  releaseSec: ${releaseSec},${lowpassHz !== "" ? `\n  lowpassHz: ${lowpassHz},` : ""}
  harmonics: ${JSON.stringify(harmonics, null, 4).replace(/"([^"]+)":/g, "$1:")},
},`;
    navigator.clipboard.writeText(code);
    setExportCopied(true);
    setTimeout(() => setExportCopied(false), 2000);
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  const S = {
    root: { background: "#0a0a0f", color: "#e0d6c8", minHeight: "100vh" } as const,
    container: { maxWidth: "980px", margin: "0 auto", padding: "24px" } as const,
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #2a2a35", paddingBottom: "16px", marginBottom: "0" } as const,
    h1: { margin: 0, fontSize: "18px", color: "#d4a83a", letterSpacing: "0.05em" } as const,
    playBar: { display: "flex", alignItems: "center", gap: "12px" } as const,
    hzBadge: { background: "#1a1a24", border: "1px solid #2a2a35", borderRadius: "4px", padding: "4px 10px", fontSize: "14px", color: "#d4a83a", letterSpacing: "0.05em" } as const,
    playBtn: (active: boolean) => ({ background: active ? "#6b0000" : "#d4a83a", color: active ? "#fff" : "#000", border: "none", padding: "8px 18px", borderRadius: "6px", cursor: "pointer", fontWeight: "bold", fontSize: "14px" }) as const,
    dot: (on: boolean) => ({ width: "8px", height: "8px", borderRadius: "50%", background: on ? "#4caf50" : "#333", flexShrink: 0 }) as const,
    tabNav: { display: "flex", borderBottom: "1px solid #2a2a35", marginBottom: "24px" } as const,
    tab: (active: boolean) => ({ background: "none", border: "none", borderBottom: active ? "2px solid #d4a83a" : "2px solid transparent", color: active ? "#d4a83a" : "#666", padding: "12px 22px", cursor: "pointer", fontSize: "14px", transition: "color 0.15s" }) as const,
    section: { background: "#14141c", border: "1px solid #2a2a35", borderRadius: "8px", padding: "20px", marginBottom: "16px" } as const,
    sectionTitle: { color: "#d4a83a", margin: "0 0 16px 0", fontSize: "14px", textTransform: "uppercase" as const, letterSpacing: "0.08em" },
    sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" } as const,
    schoolTitle: { color: "#d4a83a", margin: "0 0 12px 0", fontSize: "15px" } as const,
    schoolDesc: { color: "#888", fontSize: "12px", margin: "0 0 14px 0", lineHeight: "1.5" } as const,
    table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "13px" } as const,
    th: { textAlign: "left" as const, padding: "6px 10px", color: "#555", fontSize: "11px", textTransform: "uppercase" as const, letterSpacing: "0.06em", borderBottom: "1px solid #2a2a35" },
    row: (selected: boolean) => ({ borderBottom: "1px solid #1e1e28", cursor: "pointer", background: selected ? "#1e1a0e" : "transparent", transition: "background 0.1s" }) as const,
    hzCell: (selected: boolean) => ({ padding: "8px 12px", fontWeight: "bold", color: selected ? "#d4a83a" : "#b89a2a", minWidth: "70px", fontSize: "14px" }) as const,
    labelCell: { padding: "8px 12px", color: "#d4c8a0" } as const,
    descCell: { padding: "8px 12px", color: "#888", fontSize: "12px", lineHeight: "1.4" } as const,
    metaCell: { padding: "8px 12px" } as const,
    tag: { display: "inline-block", background: "#1e1e28", border: "1px solid #2a2a35", borderRadius: "3px", padding: "2px 6px", fontSize: "11px", color: "#999", marginRight: "4px" } as const,
    presetsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" } as const,
    presetCard: (active: boolean) => ({ background: "#14141c", border: `1px solid ${active ? "#d4a83a" : "#2a2a35"}`, borderRadius: "8px", padding: "16px", transition: "border-color 0.15s" }) as const,
    presetCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" } as const,
    presetName: { color: "#d4a83a", fontWeight: "bold", fontSize: "14px" } as const,
    presetMeta: { display: "flex", gap: "10px", flexWrap: "wrap" as const, marginBottom: "12px" } as const,
    presetMetaItem: { color: "#666", fontSize: "11px" } as const,
    harmonicsTable: { width: "100%", borderCollapse: "collapse" as const, fontSize: "12px" } as const,
    harmonicsTh: { textAlign: "left" as const, padding: "4px 8px", color: "#555", fontSize: "10px", textTransform: "uppercase" as const, borderBottom: "1px solid #1e1e28" },
    harmonicsTd: { padding: "4px 8px", color: "#888" } as const,
    btn: { background: "transparent", border: "1px solid #2a2a35", color: "#ccc", padding: "5px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" } as const,
    btnGold: { background: "#d4a83a", border: "none", color: "#000", padding: "5px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" } as const,
    btnRed: { background: "#6b0000", border: "none", color: "#fff", padding: "5px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" } as const,
    cardActions: { display: "flex", gap: "6px" } as const,
    controlsRow: { display: "flex", gap: "20px", flexWrap: "wrap" as const } as const,
    fieldLabel: { display: "flex", flexDirection: "column" as const, gap: "5px", fontSize: "12px", color: "#888" } as const,
    input: { background: "#1a1a24", border: "1px solid #333", color: "#fff", padding: "6px 8px", borderRadius: "4px", width: "100px", fontSize: "13px" } as const,
    inputNarrow: { background: "#1a1a24", border: "1px solid #333", color: "#fff", padding: "6px 8px", borderRadius: "4px", width: "80px", fontSize: "13px" } as const,
    harmonicRow: { display: "flex", gap: "12px", alignItems: "flex-end", background: "#1a1a24", padding: "10px 12px", borderRadius: "6px", marginBottom: "8px", border: "1px solid #222" } as const,
    harmonicIdx: { color: "#555", width: "24px", fontSize: "12px", paddingBottom: "7px" } as const,
    removeBtnSmall: { background: "transparent", color: "#8b0000", border: "1px solid #3a1a1a", padding: "5px 8px", borderRadius: "4px", cursor: "pointer", height: "30px", } as const,
    exportRow: { display: "flex", alignItems: "center", gap: "16px" } as const,
    exportBtn: (copied: boolean) => ({ background: copied ? "#1e3a1e" : "transparent", border: `1px solid ${copied ? "#4caf50" : "#d4a83a"}`, color: copied ? "#4caf50" : "#d4a83a", padding: "10px 20px", borderRadius: "6px", cursor: "pointer", fontSize: "13px", transition: "all 0.2s" }) as const,
    exportHint: { color: "#555", fontSize: "12px" } as const,
    addBtn: { background: "#2a2a35", color: "#ccc", border: "none", padding: "6px 14px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" } as const,
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={S.root}>
      <div style={S.container}>

        {/* Header */}
        <div style={S.header}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={() => router.back()}
              style={{ background: "transparent", border: "1px solid #2a2a35", color: "#888", padding: "5px 10px", borderRadius: "4px", cursor: "pointer", fontSize: "14px" }}
              title="Назад"
            >←</button>
            <h1 style={S.h1}>Synth Lab · Frequency Atlas</h1>
          </div>
          <div style={S.playBar}>
            <span style={S.hzBadge}>
              {baseHz} Hz
              {activePresetKey && <span style={{ color: "#888", marginLeft: 8, fontSize: "12px" }}>· {activePresetKey}</span>}
            </span>

            {/* Mute */}
            <button
              onClick={() => { const n = !muted; setMuted(n); if (isPlaying) { setTimeout(() => { stopFrequency(); playFrequency(baseHz, { ...currentOptions, peakGain: peakGain * masterVolume * (n ? 0 : 1) }); }, 0); } }}
              style={{ background: "transparent", border: "1px solid #2a2a35", color: muted ? "#8b0000" : "#888", padding: "5px 10px", borderRadius: "4px", cursor: "pointer", fontSize: "14px" }}
              title={muted ? "Включить звук" : "Заглушить"}
            >
              {muted ? "🔇" : "🔊"}
            </button>

            {/* Volume slider */}
            <input
              type="range"
              min="0" max="1" step="0.01"
              value={masterVolume}
              onChange={e => {
                const v = Number(e.target.value);
                setMasterVolume(v);
                if (isPlaying) setTimeout(() => { stopFrequency(); playFrequency(baseHz, { ...currentOptions, peakGain: peakGain * v * (muted ? 0 : 1) }); }, 0);
              }}
              style={{ width: "90px", accentColor: "#d4a83a" }}
              title={`Громкость ${Math.round(masterVolume * 100)}%`}
            />

            <button onClick={handleTogglePlay} style={S.playBtn(isPlaying)}>
              {isPlaying ? "■ Stop" : "▶ Play"}
            </button>
            <div style={S.dot(isPlaying)} title={isPlaying ? "Играет" : "Остановлено"} />
          </div>
        </div>

        {/* Tab nav */}
        <nav style={{ ...S.tabNav, alignItems: "center", gap: "20px" }}>
          {(["atlas", "presets", "lab"] as const).map(tab => (
            <button key={tab} onClick={() => changeTab(tab)} style={S.tab(activeTab === tab)}>
              {TAB_LABELS[tab]}
            </button>
          ))}
          {isPlaying && (currentLabel || activePresetKey || currentHzContext) && (
            <span style={{ color: "#d4a83a", fontSize: "13px", paddingBottom: "10px", maxWidth: "640px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ▶ {currentLabel || (activePresetKey ? PRESET_LABELS[activePresetKey] ?? activePresetKey : "—")}
              {currentHzContext && (
                <span style={{ color: "#888", marginLeft: 8, fontSize: "12px" }}>
                  · {[currentHzContext.entry.planet, currentHzContext.entry.chakra, currentHzContext.school].filter(Boolean).join(" · ")}
                </span>
              )}
            </span>
          )}
        </nav>

        {/* ── Tab: Atlas ── */}
        {activeTab === "atlas" && (
          <div>
            {Object.entries(FREQUENCY_ATLAS).map(([key, school]) => (
              <div key={key} style={S.section}>
                <h2 style={S.schoolTitle}>{school.name}</h2>
                <p style={S.schoolDesc}>{school.description}</p>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Hz</th>
                      <th style={S.th}>Название</th>
                      <th style={S.th}>Описание</th>
                      <th style={S.th}>Контекст</th>
                    </tr>
                  </thead>
                  <tbody>
                    {school.entries.map(entry => {
                      // Подсветка по Hz (с допуском на float-точность). Если играет — добавляем ▶ маркер.
                      const hzMatch = Math.abs(baseHz - entry.hz) < 0.05;
                      const selected = hzMatch;
                      const playingHere = hzMatch && isPlaying;
                      return (
                        <tr
                          key={entry.hz + entry.label}
                          style={S.row(selected)}
                          onClick={() => handleFrequencySelect(entry)}
                          onDoubleClick={() => changeTab("lab")}
                          title="Клик — загрузить параметры (звук переключится если уже играет). Двойной клик — перейти в Лабораторию."
                        >
                          <td style={S.hzCell(selected)}>
                            {playingHere && <span style={{ color: "#4caf50", marginRight: 6 }}>▶</span>}
                            {entry.hz}
                          </td>
                          <td style={S.labelCell}>{entry.label}</td>
                          <td style={S.descCell}>{entry.description}</td>
                          <td style={S.metaCell}>
                            {entry.chakra && <span style={S.tag}>{entry.chakra}</span>}
                            {entry.planet && <span style={S.tag}>{entry.planet}</span>}
                            {entry.note && <span style={S.tag}>nota {entry.note}</span>}
                            {entry.instrument && <span style={{ ...S.tag, color: "#666" }}>{entry.instrument}</span>}
                            {entry.preset && <span style={{ ...S.tag, color: "#000", background: "#d4a83a", borderColor: "#d4a83a" }} title={`Загрузит пресет «${entry.preset}» в Лабораторию`}>♪ {entry.preset}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {/* ── Tab: Presets ── */}
        {activeTab === "presets" && (
          <div>
            {/* Мои пресеты */}
            {Object.keys(userPresets).length > 0 && (
              <>
                <h2 style={{ color: "#d4a83a", fontSize: 16, marginBottom: 12, marginTop: 0 }}>Мои пресеты</h2>
                <p style={{ color: "#888", fontSize: 12, marginTop: 0, marginBottom: 16 }}>
                  Сохранены локально на этом устройстве. Совпадение имени с дефолтным = override (дефолт сохранён, кнопка ↺ восстанавливает).
                </p>
                <div style={{ ...S.presetsGrid, marginBottom: 24 }}>
                  {Object.entries(userPresets).map(([key, preset]) => {
                    const isActive = activePresetKey === key;
                    const isOverride = !!PRESETS[key];
                    return (
                      <div key={key} style={{ ...S.presetCard(isActive), borderLeft: "3px solid #d4a83a" }}>
                        <div style={S.presetCardHeader}>
                          <span style={S.presetName} title={isOverride ? `Перекрывает дефолт «${key}»` : `Свой пресет «${key}»`}>
                            {key} {isOverride && <span style={{ color: "#888", fontSize: 11 }}>(override)</span>}
                          </span>
                          <div style={S.cardActions}>
                            <button onClick={() => handleLoadPreset(key)} style={S.btn}>Загрузить</button>
                            <button
                              onClick={() => isActive && isPlaying ? handleStop() : handlePlayPreset(key)}
                              style={isActive && isPlaying ? S.btnRed : S.btnGold}
                            >
                              {isActive && isPlaying ? "■ Stop" : "▶ Play"}
                            </button>
                          </div>
                        </div>
                        <div style={S.presetMeta}>
                          <span style={S.presetMetaItem}>wave: {preset.waveform}</span>
                          <span style={S.presetMetaItem}>attack: {preset.attackSec}s</span>
                          <span style={S.presetMetaItem}>release: {preset.releaseSec}s</span>
                          {preset.lowpassHz && <span style={S.presetMetaItem}>LP: {preset.lowpassHz} Hz</span>}
                          {preset.auxTones && preset.auxTones.length > 0 && (
                            <span style={S.presetMetaItem}>aux: {preset.auxTones.length}</span>
                          )}
                          <span style={S.presetMetaItem}>{new Date(preset.savedAt).toLocaleDateString("ru")}</span>
                        </div>
                        <table style={S.harmonicsTable}>
                          <thead>
                            <tr>
                              <th style={S.harmonicsTh}>×</th>
                              <th style={S.harmonicsTh}>gain</th>
                              <th style={S.harmonicsTh}>wobble</th>
                              <th style={S.harmonicsTh}>detune ¢</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preset.harmonics.map((h, i) => (
                              <tr key={i}>
                                <td style={S.harmonicsTd}>{h.multiple}</td>
                                <td style={S.harmonicsTd}>{h.gainRatio}</td>
                                <td style={S.harmonicsTd}>{h.wobbleHz ?? "—"}</td>
                                <td style={S.harmonicsTd}>{h.detuneCentsRange ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{ display: "flex", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid #2a2a35" }}>
                          {isOverride && (
                            <button onClick={() => handleResetToDefault(key)} style={{ ...S.btn, color: "#d4a83a", borderColor: "#d4a83a" }} title="Удалить твою версию, вернуться к дефолту">
                              ↺ Сбросить к дефолту
                            </button>
                          )}
                          <button onClick={() => handleDeleteUserPreset(key)} style={{ ...S.btn, color: "#8b0000", borderColor: "#3a1a1a" }}>
                            🗑 Удалить
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Дефолтные пресеты */}
            <h2 style={{ color: "#d4a83a", fontSize: 16, marginBottom: 12, marginTop: 0 }}>Дефолтные пресеты</h2>
            <p style={{ color: "#888", fontSize: 12, marginTop: 0, marginBottom: 16 }}>
              Базовая библиотека звуков. Read-only. Можно «Загрузить» в Лабораторию, изменить и сохранить под своим именем.
            </p>
            <div style={S.presetsGrid}>
              {Object.entries(PRESETS).map(([key, preset]) => {
                const isActive = activePresetKey === key;
                const overridden = !!userPresets[key];
                return (
                  <div key={key} style={{ ...S.presetCard(isActive), opacity: overridden ? 0.55 : 1 }}>
                    <div style={S.presetCardHeader}>
                      <span style={S.presetName} title={`Технический ключ: ${key}`}>
                        {PRESET_LABELS[key] ?? key}
                        {overridden && <span style={{ color: "#888", fontSize: 11, marginLeft: 6 }}>(перекрыт твоим)</span>}
                      </span>
                      <div style={S.cardActions}>
                        <button onClick={() => handleLoadPreset(key)} style={S.btn} title="Загрузить параметры в Лабораторию без воспроизведения">
                          Загрузить
                        </button>
                        <button
                          onClick={() => isActive && isPlaying ? handleStop() : handlePlayPreset(key)}
                          style={isActive && isPlaying ? S.btnRed : S.btnGold}
                        >
                          {isActive && isPlaying ? "■ Stop" : "▶ Play"}
                        </button>
                      </div>
                    </div>
                    <div style={S.presetMeta}>
                      <span style={S.presetMetaItem}>wave: {preset.waveform}</span>
                      <span style={S.presetMetaItem}>attack: {preset.attackSec}s</span>
                      <span style={S.presetMetaItem}>release: {preset.releaseSec}s</span>
                      {preset.lowpassHz && <span style={S.presetMetaItem}>LP: {preset.lowpassHz} Hz</span>}
                    </div>
                    <table style={S.harmonicsTable}>
                      <thead>
                        <tr>
                          <th style={S.harmonicsTh}>×</th>
                          <th style={S.harmonicsTh}>gain</th>
                          <th style={S.harmonicsTh}>wobble</th>
                          <th style={S.harmonicsTh}>detune ¢</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preset.harmonics.map((h, i) => (
                          <tr key={i}>
                            <td style={S.harmonicsTd}>{h.multiple}</td>
                            <td style={S.harmonicsTd}>{h.gainRatio}</td>
                            <td style={S.harmonicsTd}>{h.wobbleHz ?? "—"}</td>
                            <td style={S.harmonicsTd}>{h.detuneCentsRange ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Tab: Lab ── */}
        {activeTab === "lab" && (
          <div onMouseOver={handleTipOver} onMouseOut={handleTipOut}>

            {/* Envelope */}
            <div style={S.section}>
              <h3 style={S.sectionTitle}>Глобальная огибающая</h3>
              <div style={S.controlsRow}>
                <label style={S.fieldLabel}>
                  Базовая частота (Hz)
                  <input type="number" step="0.01" value={baseHz}
                    onChange={e => { const v = Number(e.target.value); setBaseHz(v); liveRestart({ baseHz: v }); }}
                    style={S.input}
                    data-tip="Основная нота. Все гармоники строятся как Multiple × этой частоты." />
                </label>
                <label style={S.fieldLabel}>
                  Peak Gain (0..1)
                  <input type="number" step="0.01" min="0.01" max="1" value={peakGain}
                    onChange={e => { const v = Number(e.target.value); setPeakGain(v); liveRestart({ peakGain: v }); }}
                    style={S.input}
                    data-tip="Общая громкость синтеза, 0–1. Стандарт 0.18 — безопасный уровень без перегрузки." />
                </label>
                <label style={S.fieldLabel}>
                  Форма волны
                  <select value={waveform} onChange={e => { const v = e.target.value as OscillatorType; setWaveform(v); liveRestart({ waveform: v }); }} style={S.input}
                    data-tip="Тембр осциллятора. Sine — мягко и чисто. Triangle — теплее. Sawtooth — ярко, со всеми обертонами. Square — жёстко, полое.">
                    <option value="sine">Sine</option>
                    <option value="triangle">Triangle</option>
                    <option value="sawtooth">Sawtooth</option>
                    <option value="square">Square</option>
                  </select>
                </label>
                <label style={S.fieldLabel}>
                  Атака (сек)
                  <input type="number" step="0.05" value={attackSec}
                    onChange={e => { const v = Number(e.target.value); setAttackSec(v); liveRestart({ attackSec: v }); }}
                    style={S.input}
                    data-tip="Время плавного нарастания громкости от 0 до Peak Gain при старте. Малое значение = резкая атака (ударные), большое = мягкий вход (чаши, гонги)." />
                </label>
                <label style={S.fieldLabel}>
                  Затухание (сек)
                  <input type="number" step="0.1" value={releaseSec}
                    onChange={e => { const v = Number(e.target.value); setReleaseSec(v); liveRestart({ releaseSec: v }); }}
                    style={S.input}
                    data-tip="Время плавного спада громкости после остановки. Большое значение = долгий хвост (гонг, чаша), малое = быстрый обрыв." />
                </label>
                <label style={S.fieldLabel}>
                  Lowpass (Hz)
                  <input type="number" placeholder="Выкл" value={lowpassHz}
                    onChange={e => { const v = e.target.value ? Number(e.target.value) : ""; setLowpassHz(v); liveRestart({ lowpassHz: v === "" ? undefined : Number(v) }); }}
                    style={S.input}
                    data-tip="Срез НЧ-фильтра. Все частоты выше указанной приглушаются. Смягчает резкость верхних обертонов. Пусто — фильтр выключен." />
                </label>
              </div>
            </div>

            {/* Harmonics editor */}
            <div style={S.section}>
              <div style={S.sectionHeader}>
                <h3 style={{ ...S.sectionTitle, margin: 0 }}>Гармоники (Обертона)</h3>
                <button onClick={addHarmonic} style={S.addBtn}
                  data-tip="Добавить новый обертон. По умолчанию Multiple = 2 (октава), Gain = 0.3.">+ Добавить слой</button>
              </div>
              {harmonics.length === 0 && (
                <div style={{ background: "#1a1a14", border: "1px solid #3a2a14", borderRadius: 6, padding: "12px 16px", marginBottom: 12, fontSize: 13, color: "#d4a83a" }}>
                  ⚠ Пустой массив — звука не будет. Базовый тон = слой с Multiple=1.
                  <button
                    onClick={() => {
                      const next: Harmonic[] = [{ multiple: 1, gainRatio: 1.0 }];
                      setHarmonics(next);
                      liveRestart({ harmonics: next });
                    }}
                    style={{ marginLeft: 12, background: "#d4a83a", color: "#000", border: "none", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
                  >Восстановить базовый тон</button>
                </div>
              )}
              {harmonics.map((h, i) => {
                const computedHz = Number((baseHz * h.multiple).toFixed(2));
                return (
                <div key={i} style={S.harmonicRow}>
                  <span style={S.harmonicIdx}>#{i + 1}</span>
                  <label style={S.fieldLabel}>
                    Multiple
                    <input type="number" step="0.01" value={h.multiple}
                      onChange={e => {
                        // Меняя Multiple — автоматически очищаем Abs Hz, чтобы кратность вступила в силу
                        const next = [...harmonics];
                        const updated = { ...next[i], multiple: Number(e.target.value) };
                        delete updated.absoluteHz;
                        next[i] = updated;
                        setHarmonics(next);
                        liveRestart({ harmonics: next });
                      }}
                      style={S.inputNarrow}
                      data-tip="Кратность к базовой частоте. 1 = основной тон, 2 = октава. Дробные (1.34, 2.4) дают неточные обертоны — характер гонгов и чаш. При изменении автоматически снимается Abs Hz." />
                  </label>
                  <span style={{ fontSize: "11px", color: "#d4a83a", paddingBottom: "8px", minWidth: "90px" }}
                        title={h.absoluteHz ? `Играет на ${h.absoluteHz} Hz (Abs Hz). Multiple игнорируется.` : `${h.multiple} × ${baseHz} Hz`}>
                    = {h.absoluteHz ?? computedHz} Hz {h.absoluteHz && <span style={{ color: "#888" }}>(abs)</span>}
                  </span>
                  <label style={S.fieldLabel}>
                    Gain 0..1
                    <input type="number" step="0.05" value={h.gainRatio}
                      onChange={e => updateHarmonic(i, "gainRatio", e.target.value)}
                      style={S.inputNarrow}
                      data-tip="Относительная громкость этого слоя, 0–1. 1 = на уровне основного тона, 0.5 = вдвое тише. Сумма всех слоёв ограничивается через Peak Gain." />
                  </label>
                  <label style={S.fieldLabel}>
                    Abs Hz
                    <input type="number" step="0.01" placeholder={String(computedHz)} value={h.absoluteHz ?? ""}
                      onChange={e => updateHarmonic(i, "absoluteHz", e.target.value)}
                      style={S.inputNarrow}
                      data-tip="Фиксированная частота слоя в Hz. Если задано — Multiple игнорируется, частота не зависит от базовой. Пусто — частота вычисляется как Multiple × базовая." />
                  </label>
                  <label style={S.fieldLabel}>
                    Wobble Hz
                    <input type="number" step="0.1" placeholder="—" value={h.wobbleHz ?? ""}
                      onChange={e => updateHarmonic(i, "wobbleHz", e.target.value)}
                      style={S.inputNarrow}
                      data-tip="Скорость пульсации громкости (LFO). 0.5 Hz = одна волна за 2 секунды. Создаёт эффект ‘дыхания’ слоя. Пусто — без пульсации." />
                  </label>
                  <label style={S.fieldLabel}>
                    Wobble Depth
                    <input type="number" step="0.05" min="0" max="1" placeholder="0.8" value={h.wobbleDepth ?? ""}
                      onChange={e => updateHarmonic(i, "wobbleDepth", e.target.value)}
                      style={S.inputNarrow}
                      data-tip="Глубина пульсации, 0–1. 0 = эффекта нет, 0.3 = лёгкое колебание, 0.8 = стандартное дыхание, 1.0 = громкость полностью обнуляется на минимуме. По умолчанию 0.8." />
                  </label>
                  <label style={S.fieldLabel}>
                    Detune ¢
                    <input type="number" step="1" placeholder="—" value={h.detuneCentsRange ?? ""}
                      onChange={e => updateHarmonic(i, "detuneCentsRange", e.target.value)}
                      style={S.inputNarrow}
                      data-tip="Диапазон случайного сдвига частоты в центах (1 цент = 1/100 полутона). При каждом запуске частота слоя смещается в пределах ±значения. Ломает математическую точность, добавляет живость." />
                  </label>
                  <button onClick={() => removeHarmonic(i)} style={S.removeBtnSmall} data-tip="Удалить этот обертон">✕</button>
                </div>
                );
              })}
            </div>

            {/* Auxiliary tones */}
            <div style={S.section}>
              <div style={S.sectionHeader}>
                <div>
                  <h3 style={{ ...S.sectionTitle, margin: 0 }}>Вспомогательные тоны</h3>
                  <p style={{ color: "#666", fontSize: "12px", margin: "4px 0 0 0" }}>
                    Независимые осцилляторы на абсолютных Hz — генерируются параллельно с основным тоном.
                  </p>
                </div>
                <button onClick={addAuxTone} style={S.addBtn}
                  data-tip="Добавить независимый вспомогательный тон. По умолчанию 432 Hz, Gain 0.2, мягкая пульсация 0.3 Hz.">+ Добавить тон</button>
              </div>

              {auxTones.length === 0 && (
                <p style={{ color: "#555", fontSize: "12px", margin: 0 }}>Нет вспомогательных тонов.</p>
              )}

              {auxTones.map((t, i) => (
                <div key={i} style={{ ...S.harmonicRow, borderLeft: "2px solid #2a4a2a" }}>
                  <span style={{ ...S.harmonicIdx, color: "#4a8a4a" }}>A{i + 1}</span>

                  <label style={S.fieldLabel}>
                    Hz (абс.)
                    <input type="number" step="0.01" value={t.hz}
                      onChange={e => updateAuxTone(i, "hz", e.target.value)}
                      style={{ ...S.inputNarrow, width: "90px" }}
                      title="Абсолютная частота этого тона в Hz. Не зависит от базовой частоты — например, 528 Hz останется 528 Hz при любом изменении основного тона." />
                  </label>

                  <label style={S.fieldLabel}>
                    Gain 0..1
                    <input type="number" step="0.05" min="0" max="1" value={t.gainRatio}
                      onChange={e => updateAuxTone(i, "gainRatio", e.target.value)}
                      style={S.inputNarrow}
                      title="Громкость этого тона, 0–1. 1 = наравне с основным тоном, 0.2 = тихий фоновый слой." />
                  </label>

                  <label style={S.fieldLabel}>
                    Форма
                    <select value={t.waveform ?? "sine"}
                      onChange={e => updateAuxTone(i, "waveform", e.target.value)}
                      style={{ ...S.inputNarrow, width: "90px" }}
                      title="Тембр для этого тона. Может отличаться от глобальной формы волны — например, основной тон Sine + вспомогательный Triangle.">
                      <option value="sine">Sine</option>
                      <option value="triangle">Triangle</option>
                      <option value="sawtooth">Saw</option>
                      <option value="square">Square</option>
                    </select>
                  </label>

                  <label style={S.fieldLabel}>
                    Атака (сек)
                    <input type="number" step="0.05" placeholder={String(attackSec)} value={t.attackSec ?? ""}
                      onChange={e => updateAuxTone(i, "attackSec", e.target.value)}
                      style={S.inputNarrow}
                      title="Своё время плавного нарастания громкости этого тона. Если пусто — берётся глобальная Атака." />
                  </label>

                  <label style={S.fieldLabel}>
                    Затухание (сек)
                    <input type="number" step="0.1" placeholder={String(releaseSec)} value={t.releaseSec ?? ""}
                      onChange={e => updateAuxTone(i, "releaseSec", e.target.value)}
                      style={S.inputNarrow}
                      title="Своё время плавного спада этого тона при остановке. Если пусто — берётся глобальное Затухание." />
                  </label>

                  <label style={S.fieldLabel}>
                    Wobble Hz
                    <input type="number" step="0.1" placeholder="—" value={t.wobbleHz ?? ""}
                      onChange={e => updateAuxTone(i, "wobbleHz", e.target.value)}
                      style={S.inputNarrow}
                      title="Свой ритм пульсации этого тона (LFO). Каждый вспомогательный тон может иметь свою скорость дыхания — например 0.3 Hz и 0.5 Hz создадут эффект биения." />
                  </label>

                  <label style={S.fieldLabel}>
                    Depth
                    <input type="number" step="0.05" min="0" max="1" placeholder="0.8" value={t.wobbleDepth ?? ""}
                      onChange={e => updateAuxTone(i, "wobbleDepth", e.target.value)}
                      style={S.inputNarrow}
                      title="Глубина пульсации, 0–1. 0 = ровно, 0.5 = заметное колебание, 1.0 = тон полностью затихает на минимуме LFO. По умолчанию 0.8." />
                  </label>

                  <label style={S.fieldLabel}>
                    Detune ¢
                    <input type="number" step="1" placeholder="—" value={t.detuneCentsRange ?? ""}
                      onChange={e => updateAuxTone(i, "detuneCentsRange", e.target.value)}
                      style={S.inputNarrow}
                      title="Случайный сдвиг частоты в центах при каждом запуске. Ломает математическую чистоту, делает звук ‘живым’. Для стабильных тонов оставь пустым." />
                  </label>

                  <button onClick={() => removeAuxTone(i)} style={S.removeBtnSmall} title="Удалить этот вспомогательный тон">✕</button>
                </div>
              ))}
            </div>

            {/* Save preset */}
            <div style={S.section}>
              <h3 style={{ ...S.sectionTitle, margin: "0 0 12px 0" }}>Сохранение пресета</h3>
              <p style={{ color: "#888", fontSize: 12, margin: "0 0 14px 0", lineHeight: 1.5 }}>
                Сохрани текущую конфигурацию (форма, огибающая, гармоники, вспомогательные тоны) под именем — она будет в твоей коллекции и доступна во вкладке Пресеты. Дефолтные пресеты не затрагиваются.
              </p>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="Имя пресета (например: my_om_bowl)"
                  value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  style={{ ...S.input, width: 280 }}
                />
                <button
                  onClick={handleSaveUserPreset}
                  style={{ background: "#d4a83a", color: "#000", border: "none", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontWeight: "bold", fontSize: 13 }}
                >Сохранить</button>
                {savedHint && <span style={{ color: savedHint.startsWith("✓") || savedHint.startsWith("↺") ? "#4caf50" : "#d4a83a", fontSize: 12 }}>{savedHint}</span>}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 6, paddingTop: 12, borderTop: "1px solid #2a2a35" }}>
                <button onClick={exportPreset} style={S.exportBtn(exportCopied)}
                  data-tip="Скопировать TS-объект текущей конфигурации в буфер обмена — для коммита в frequency-synth.ts (постоянно, для всех пользователей).">
                  {exportCopied ? "✓ Скопировано!" : "Экспорт TS в буфер"}
                </button>
                <span style={S.exportHint}>
                  Альтернатива: код для вставки в PRESETS в <code style={{ color: "#d4a83a" }}>src/lib/frequency-synth.ts</code>
                </span>
              </div>
            </div>

          </div>
        )}

      </div>

      {tip && (
        <div style={{
          position: "fixed",
          left: tip.x,
          top: tip.y - window.scrollY,
          transform: "translate(-50%, -100%)",
          background: "#000",
          color: "#fff",
          border: "1px solid #2a2a35",
          padding: "8px 12px",
          borderRadius: "6px",
          fontSize: "12px",
          fontWeight: 300,
          maxWidth: "320px",
          width: "max-content",
          lineHeight: "1.5",
          zIndex: 9999,
          pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          whiteSpace: "normal",
        }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
