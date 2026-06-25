import { useState, type ReactNode } from 'react'
import './App.css'
import bowlHero from './assets/sound-bowl-hero.png'
import { playPreset, setGlobalVolume, stopFrequency } from './frequency-synth'

type IconName =
  | 'leaf'
  | 'heart'
  | 'target'
  | 'moon'
  | 'wave'
  | 'star'
  | 'clock'
  | 'pin'
  | 'users'
  | 'layers'
  | 'bookmark'
  | 'spark'
  | 'volume'
  | 'shuffle'
  | 'skip'
  | 'repeat'
  | 'sun'
  | 'lotus'
  | 'bowl'
  | 'info'

type CardRow = {
  icon: IconName
  label: string
  value: string
}

const intentionFilters = [
  { icon: 'leaf' as const, label: 'Успокоиться' },
  { icon: 'heart' as const, label: 'Восстановиться' },
  { icon: 'target' as const, label: 'Сфокусироваться' },
  { icon: 'moon' as const, label: 'Сон' },
  { icon: 'wave' as const, label: 'Снять напряжение' },
]

const quickFacts: CardRow[] = [
  { icon: 'bowl', label: 'Категория', value: 'Звуковые практики' },
  { icon: 'users', label: 'Происхождение', value: 'Тибет, Азия' },
  { icon: 'spark', label: 'Тип метода', value: 'Вибрационная практика' },
  { icon: 'sun', label: 'Подход', value: 'Резонансный' },
  { icon: 'star', label: 'Уровень опыта', value: 'Для всех уровней' },
  { icon: 'clock', label: 'Время практики', value: '10-40 минут' },
]

const practiceInfo: CardRow[] = [
  { icon: 'clock', label: 'Лучшее время', value: 'Утро, вечер, перед сном' },
  { icon: 'pin', label: 'Место', value: 'Тихое пространство' },
  { icon: 'users', label: 'Формат', value: 'Аудио-практика' },
  { icon: 'layers', label: 'Необходимое', value: 'Наушники или колонки' },
  { icon: 'bookmark', label: 'Подготовка', value: 'Удобное положение' },
]

const conditionList = [
  'Тревога и беспокойство',
  'Усталость и истощение',
  'Эмоциональное напряжение',
  'Проблемы со сном',
  'Рассеянность и перегрузка',
]

function Icon({ name }: { name: IconName }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
  }

  const paths: Record<IconName, ReactNode> = {
    leaf: <path {...common} d="M5 19c8 0 14-7 14-14-8 0-14 6-14 14Zm0 0c0-5 4-9 10-10" />,
    heart: <path {...common} d="M12 20s-7-4.4-9-8.5C1.5 8.5 3.2 5 6.4 5c1.8 0 3.1 1 3.9 2.1C11.1 6 12.4 5 14.2 5c3.2 0 4.9 3.5 3.4 6.5C15.6 15.6 12 20 12 20Z" />,
    target: <><circle {...common} cx="12" cy="12" r="8" /><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="m15 9 4-4m-4 0h4v4" /></>,
    moon: <path {...common} d="M18 16.5A8 8 0 0 1 7.5 6 7 7 0 1 0 18 16.5Z" />,
    wave: <path {...common} d="M3 8c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2M3 13c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2M3 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2" />,
    star: <path {...common} d="m12 3 2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6-4.5-4.2 6.1-.8L12 3Z" />,
    clock: <><circle {...common} cx="12" cy="12" r="8" /><path {...common} d="M12 7v5l3 2" /></>,
    pin: <path {...common} d="M12 21s6-5.6 6-11A6 6 0 0 0 6 10c0 5.4 6 11 6 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
    users: <><path {...common} d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" /><circle {...common} cx="12" cy="9" r="3" /><path {...common} d="M19 18c0-1.7-1.1-3.1-2.6-3.7M16.8 6.4a2.6 2.6 0 0 1 0 5.2" /></>,
    layers: <><path {...common} d="m12 3 8 4-8 4-8-4 8-4Z" /><path {...common} d="m4 12 8 4 8-4" /><path {...common} d="m4 17 8 4 8-4" /></>,
    bookmark: <path {...common} d="M7 4h10v17l-5-3-5 3V4Z" />,
    spark: <path {...common} d="M12 3v5m0 8v5M3 12h5m8 0h5m-13-5 3 3m5 5 3 3m0-11-3 3m-5 5-3 3" />,
    volume: <path {...common} d="M4 10v4h4l5 4V6l-5 4H4Zm12-1c.8.8 1.2 1.8 1.2 3s-.4 2.2-1.2 3" />,
    shuffle: <path {...common} d="M4 7h3l9 10h4m-4 0v-4m0 4h-4M4 17h3l2.6-3M16 7h4m-4 0V3m0 4h-4" />,
    skip: <path {...common} d="M6 5v14l9-7-9-7Zm11 0v14" />,
    repeat: <path {...common} d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3" />,
    sun: <><circle {...common} cx="12" cy="12" r="4" /><path {...common} d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
    lotus: <path {...common} d="M12 20c-4 0-7-2.8-7-6 3 .1 5.4 1.3 7 4 1.6-2.7 4-3.9 7-4 0 3.2-3 6-7 6Zm0-2c-2.4-2.7-2.4-6.7 0-10 2.4 3.3 2.4 7.3 0 10Z" />,
    bowl: <path {...common} d="M4 10h16c-.3 5-3.5 8-8 8s-7.7-3-8-8Zm2-3h12" />,
    info: <><circle {...common} cx="12" cy="12" r="8" /><path {...common} d="M12 11v5m0-8h.01" /></>,
  }

  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function InfoPanel({ title, rows, action }: { title: string; rows: CardRow[]; action?: string }) {
  return (
    <section className="panel">
      <header className="panelHeader">
        <h2>{title}</h2>
        {title === 'Быстрые факты' && (
          <button className="iconButton" aria-label="Сохранить в избранное">
            <Icon name="star" />
          </button>
        )}
      </header>
      <div className="factRows">
        {rows.map((row) => (
          <div className="factRow" key={row.label}>
            <span className="factIcon"><Icon name={row.icon} /></span>
            <span className="factLabel">{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
      {action && <button className="outlineWide">{action}</button>}
    </section>
  )
}

function App() {
  const [activeFilter, setActiveFilter] = useState('Успокоиться')
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState(64)
  const [rating, setRating] = useState(0)

  const togglePlayback = () => {
    if (isPlaying) {
      stopFrequency()
      setIsPlaying(false)
      return
    }

    setGlobalVolume(volume / 100)
    const started = playPreset('solfeggio_528', 528, {
      loop: true,
      durationSec: 28,
      peakGain: 0.55,
    })
    setIsPlaying(started)
  }

  const handleVolume = (value: number) => {
    setVolume(value)
    setGlobalVolume(value / 100)
  }

  return (
    <main className="soundPage">
      <div className="shell">
        <div className="leftDecor" aria-hidden="true" />
        <div className="rightDecor" aria-hidden="true" />

        <div className="contentGrid">
          <div className="mainColumn">
            <nav className="breadcrumbs" aria-label="Навигация">
              <span>Атлас</span>
              <span>Методы</span>
              <span>Поле 7: Полевые методы и практики состояния</span>
              <strong>Звуковые практики</strong>
            </nav>

            <section className="heroSection">
              <div className="heroCopy">
                <h1>Звуковые практики <span aria-hidden="true">✶</span></h1>
                <p>Выбирайте желаемое состояние и входите в резонанс через звук.</p>
              </div>

              <div className="intentions" aria-label="Состояния">
                {intentionFilters.map((item) => (
                  <button
                    className={activeFilter === item.label ? 'pill active' : 'pill'}
                    key={item.label}
                    onClick={() => setActiveFilter(item.label)}
                  >
                    <Icon name={item.icon} />
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="heroVisual">
                <div className="heroText">
                  <p>Звук в этой практике используется как мягкий объект внимания: он помогает замедлиться, услышать тело и отметить собственный отклик.</p>
                  <button className="goldButton">Подобрать практику <Icon name="spark" /></button>
                </div>
                <img src={bowlHero} alt="Бронзовая поющая чаша с золотой звуковой волной" />
              </div>
            </section>

            <section className="playerPanel" aria-label="Текущая практика">
              <div className="cover">
                <img src={bowlHero} alt="Обложка практики с поющей чашей" />
                <button className="coverPlay" onClick={togglePlayback} aria-label={isPlaying ? 'Остановить практику' : 'Запустить практику'}>
                  {isPlaying ? 'II' : '▶'}
                </button>
              </div>
              <div className="playerContent">
                <div className="practiceTitle">
                  <span>Текущая практика</span>
                  <h2>Чаша — 528 Hz</h2>
                  <p>Мягкая аудио-практика для наблюдения за сердечным откликом.</p>
                </div>
                <button className="favorite" aria-label="Добавить практику в избранное">
                  <Icon name="heart" />
                </button>

                <div className="tags">
                  <span>528 Hz</span>
                  <span>Сольфеджио</span>
                  <span>Фокус сердца</span>
                  <span>28:00</span>
                </div>

                <div className="timeline">
                  <span>07:32</span>
                  <div className="track"><span /></div>
                  <span>28:00</span>
                </div>

                <div className="controls">
                  <button aria-label="Перемешать"><Icon name="shuffle" /></button>
                  <button aria-label="Предыдущий трек"><Icon name="skip" /></button>
                  <button className="mainPlay" onClick={togglePlayback} aria-label={isPlaying ? 'Пауза' : 'Играть'}>
                    {isPlaying ? 'II' : '▶'}
                  </button>
                  <button aria-label="Следующий трек"><Icon name="skip" /></button>
                  <button aria-label="Повтор"><Icon name="repeat" /></button>
                  <label className="volume">
                    <Icon name="volume" />
                    <input
                      aria-label="Громкость"
                      type="range"
                      min="0"
                      max="100"
                      value={volume}
                      onChange={(event) => handleVolume(Number(event.target.value))}
                    />
                  </label>
                </div>
              </div>
            </section>

            <div className="lowerGrid">
              <section className="panel processPanel">
                <h2>Как это работает <Icon name="info" /></h2>
                <div className="steps">
                  <div>
                    <span><Icon name="wave" /></span>
                    <strong>Вибрация</strong>
                    <p>Звуковые волны становятся объектом внимания и телесного наблюдения.</p>
                  </div>
                  <div>
                    <span><Icon name="bowl" /></span>
                    <strong>Резонанс</strong>
                    <p>Человек отмечает, какие частоты ощущаются мягче, яснее или напряжённее.</p>
                  </div>
                  <div>
                    <span><Icon name="lotus" /></span>
                    <strong>Интеграция</strong>
                    <p>После практики фиксируются состояние, дыхание и субъективный отклик.</p>
                  </div>
                </div>
              </section>

              <section className="panel recommendations">
                <h2>Рекомендованные состояния</h2>
                <div className="imageSlot small">
                  <strong>sound-lotus.png</strong>
                  <span>320x240 px → src/assets/</span>
                </div>
                <div className="stateButtons">
                  {intentionFilters.map((item) => (
                    <button
                      className={activeFilter === item.label ? 'state active' : 'state'}
                      key={item.label}
                      onClick={() => setActiveFilter(item.label)}
                    >
                      <Icon name={item.icon} />
                      {item.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel diary">
                <h2>Дневник состояния <Icon name="info" /></h2>
                <label>
                  Как вы себя чувствуете после практики?
                  <textarea placeholder="Поделитесь своими ощущениями, инсайтами или изменениями..." />
                </label>
                <div className="rating">
                  <span>Оцените своё состояние</span>
                  <div>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        className={rating >= value ? 'star active' : 'star'}
                        key={value}
                        onClick={() => setRating(value)}
                        aria-label={`Оценка ${value}`}
                      >
                        ☆
                      </button>
                    ))}
                  </div>
                </div>
                <button className="outlineWide">Сохранить запись</button>
              </section>
            </div>
          </div>

          <aside className="sideColumn">
            <InfoPanel title="Быстрые факты" rows={quickFacts} />
            <InfoPanel title="Практическая информация" rows={practiceInfo} action="Смотреть рекомендации" />
            <section className="panel fitPanel">
              <h2>Подходит для состояний</h2>
              <div className="conditionList">
                {conditionList.map((condition, index) => (
                  <div key={condition}>
                    <span>{index + 1}</span>
                    {condition}
                  </div>
                ))}
              </div>
              <div className="imageSlot crystal">
                <strong>sound-crystals.png</strong>
                <span>420x320 px → src/assets/</span>
              </div>
              <button className="outlineWide">Сохранить все состояния</button>
            </section>
          </aside>
        </div>
      </div>
    </main>
  )
}

export default App
