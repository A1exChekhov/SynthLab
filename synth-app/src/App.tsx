import { useState, useEffect } from 'react'
import SynthEditorPanel from './SynthEditorPanel'
import ClassicEditorPanel from './ClassicEditorPanel'
import SoundCapturerPanel from './SoundCapturerPanel'
import StudioPanel from './StudioPanel'
import { setGlobalVolume, globalMasterVolume } from './frequency-synth'

function App() {
  const [uiMode, setUiMode] = useState<'console' | 'classic' | 'capturer' | 'studio'>('console');
  const [volume, setVolume] = useState<number>(globalMasterVolume * 100);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Apply theme to document root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setVolume(val);
    setGlobalVolume(val / 100);
  };

  return (
    <>
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px',
        padding: '8px 16px',
        background: 'var(--panel-bg)',
        borderBottom: '1px solid var(--border-color)',
        backdropFilter: 'blur(10px)',
        fontFamily: "'Inter', 'Helvetica Neue', sans-serif",
        fontWeight: 300,
        boxShadow: theme === 'light' ? "0 2px 10px rgba(0,0,0,0.02)" : "0 2px 10px rgba(0,0,0,0.2)",
        transition: 'background 0.3s, border-color 0.3s'
      }}>
        <div style={{ marginRight: 'auto' }}>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '16px',
              padding: '4px',
              color: 'var(--text-primary)'
            }}
            title={`Переключить на ${theme === 'dark' ? 'светлую' : 'темную'} тему`}
          >
            {theme === 'dark' ? '🌞' : '🌙'}
          </button>
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 400 }}>UI MODE:</span>
        <button
          onClick={() => setUiMode('console')}
          style={{
            padding: '4px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 400,
            background: uiMode === 'console' ? '#e63946' : 'transparent',
            color: uiMode === 'console' ? '#fff' : 'var(--text-primary)',
            border: `1px solid ${uiMode === 'console' ? '#e63946' : 'var(--border-color)'}`,
            transition: 'all 0.2s'
          }}
        >
          🎛️ CONSOLE
        </button>
        <button
          onClick={() => setUiMode('classic')}
          style={{
            padding: '4px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 400,
            background: uiMode === 'classic' ? '#0077b6' : 'transparent',
            color: uiMode === 'classic' ? '#fff' : 'var(--text-primary)',
            border: `1px solid ${uiMode === 'classic' ? '#0077b6' : 'var(--border-color)'}`,
            transition: 'all 0.2s'
          }}
        >
          📋 CLASSIC
        </button>
        <button
          onClick={() => setUiMode('capturer')}
          style={{
            padding: '4px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 400,
            background: uiMode === 'capturer' ? 'var(--accent-cyan)' : 'transparent',
            color: uiMode === 'capturer' ? '#fff' : 'var(--text-primary)',
            border: `1px solid ${uiMode === 'capturer' ? 'var(--accent-cyan)' : 'var(--border-color)'}`,
            transition: 'all 0.2s'
          }}
        >
          🎙️ CAPTURE
        </button>
        <button
          onClick={() => setUiMode('studio')}
          style={{
            padding: '4px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 400,
            background: uiMode === 'studio' ? '#2dd36f' : 'transparent',
            color: uiMode === 'studio' ? '#fff' : 'var(--text-primary)',
            border: `1px solid ${uiMode === 'studio' ? '#2dd36f' : 'var(--border-color)'}`,
            transition: 'all 0.2s'
          }}
        >
          🎚️ STUDIO
        </button>

        {/* Master Volume Fader */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '1px' }}>
            МАСТЕР
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative' }}>
            <input 
              type="range" 
              min="0" 
              max="100" 
              value={volume} 
              onChange={handleVolumeChange}
              className="fader-input"
              style={{ 
                cursor: 'pointer', 
                width: '180px', 
                height: '4px',
                background: `linear-gradient(to right, var(--accent-cyan) ${volume}%, var(--border-color) ${volume}%)`,
                borderRadius: '2px',
                outline: 'none',
                margin: '8px 0'
              }}
            />
            {/* Scale Marks */}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px', pointerEvents: 'none' }}>
              {[0, 25, 50, 75, 100].map(tick => (
                <div key={tick} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '1px', height: '4px', background: 'var(--text-secondary)', opacity: 0.5 }} />
                  <span style={{ fontSize: '8px', color: 'var(--text-secondary)', marginTop: '2px', fontWeight: 500 }}>{tick}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div style={{ paddingTop: '44px', height: '100%', overflowY: 'auto' }}>
        {uiMode === 'console' ? (
          <SynthEditorPanel theme={theme} />
        ) : uiMode === 'classic' ? (
          <ClassicEditorPanel />
        ) : uiMode === 'studio' ? (
          <StudioPanel theme={theme} masterVolume={volume / 100} />
        ) : (
          <SoundCapturerPanel theme={theme} masterVolume={volume / 100} onSendToStudio={() => setUiMode('studio')} />
        )}
      </div>
    </>
  )
}

export default App

