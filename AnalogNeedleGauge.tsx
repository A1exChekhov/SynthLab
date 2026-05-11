import React, { useEffect, useRef } from 'react';

interface AnalogNeedleGaugeProps {
  value: number;
  min?: number;
  max?: number;
  label: string;
  unit?: string;
  color?: string;
  title?: string;
}

const AnalogNeedleGauge: React.FC<AnalogNeedleGaugeProps> = ({
  value = 50,
  min = 0,
  max = 100,
  label,
  unit = '%',
  color = '#ff2a6d',
  title,
}) => {
  const needleRef = useRef<SVGPathElement>(null);
  const normalized = Math.max(min, Math.min(max, value));
  const angle = -135 + ((normalized - min) / (max - min)) * 270;

  useEffect(() => {
    if (needleRef.current) {
      needleRef.current.setAttribute('transform', `rotate(${angle} 100 100)`);
    }
  }, [angle]);

  return (
    <div style={{ width: '200px', textAlign: 'center', fontFamily: 'monospace', color: '#ddd' }}>
      {title && <div style={{fontSize: '12px', marginBottom: '4px', letterSpacing: '1px'}}>{title}</div>}
      <svg width="210" height="190" viewBox="0 0 210 190" style={{filter: 'drop-shadow(0 0 12px ' + color + ')'}}>
        {/* Background */}
        <circle cx="105" cy="105" r="82" fill="none" stroke="#1a1a1a" strokeWidth="28" />
        <circle cx="105" cy="105" r="82" fill="none" stroke="#222" strokeWidth="18" />
        
        {/* Tick marks */}
        {Array.from({length: 21}, (_, i) => {
          const tickAngle = -135 + (i * 13.5);
          const rad = (tickAngle * Math.PI) / 180;
          const x1 = 105 + Math.cos(rad) * 65;
          const y1 = 105 + Math.sin(rad) * 65;
          const x2 = 105 + Math.cos(rad) * 78;
          const y2 = 105 + Math.sin(rad) * 78;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#555" strokeWidth={i % 2 === 0 ? 3 : 1.5} />;
        })}
        
        {/* Colored arc */}
        <path d="M 40 145 A 78 78 0 0 1 170 145" fill="none" stroke={color} strokeWidth="12" strokeLinecap="round" />
        
        {/* Needle */}
        <g>
          <path
            ref={needleRef}
            d="M 105 105 L 105 32"
            fill="none"
            stroke="#f8f8f8"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <circle cx="105" cy="105" r="14" fill="#111" />
          <circle cx="105" cy="105" r="7" fill="#f8f8f8" />
        </g>
      </svg>
      <div style={{ marginTop: '-18px', fontSize: '14px', fontWeight: 'bold' }}>
        {label} <span style={{ color }}>{Math.round(normalized)}{unit}</span>
      </div>
    </div>
  );
};

export default AnalogNeedleGauge;
