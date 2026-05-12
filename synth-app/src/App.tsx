import { useState } from 'react'
import SynthEditorPanel from './SynthEditorPanel'
import ClassicEditorPanel from './ClassicEditorPanel'

function App() {
  const [uiMode, setUiMode] = useState<'console' | 'classic'>('console');

  return (
    <>
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px',
        padding: '8px 16px',
        background: uiMode === 'console' ? 'rgba(5,5,8,0.95)' : 'rgba(255,255,255,0.95)',
        borderBottom: uiMode === 'console' ? '1px solid #333' : '1px solid #ddd',
        backdropFilter: 'blur(10px)',
        fontFamily: 'monospace'
      }}>
        <span style={{ fontSize: '12px', color: uiMode === 'console' ? '#888' : '#666' }}>UI MODE:</span>
        <button
          onClick={() => setUiMode('console')}
          style={{
            padding: '4px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
            background: uiMode === 'console' ? '#ff2a6d' : 'transparent',
            color: uiMode === 'console' ? '#000' : '#d73a49',
            border: `1px solid ${uiMode === 'console' ? '#ff2a6d' : '#d73a49'}`,
            transition: 'all 0.2s'
          }}
        >
          🎛️ CONSOLE
        </button>
        <button
          onClick={() => setUiMode('classic')}
          style={{
            padding: '4px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
            background: uiMode === 'classic' ? '#0366d6' : 'transparent',
            color: uiMode === 'classic' ? '#fff' : (uiMode === 'console' ? '#05d9e8' : '#0366d6'),
            border: `1px solid ${uiMode === 'classic' ? '#0366d6' : (uiMode === 'console' ? '#05d9e8' : '#0366d6')}`,
            transition: 'all 0.2s'
          }}
        >
          📋 CLASSIC
        </button>
      </div>
      <div style={{ paddingTop: '44px' }}>
        {uiMode === 'console' ? <SynthEditorPanel /> : <ClassicEditorPanel />}
      </div>
    </>
  )
}

export default App
