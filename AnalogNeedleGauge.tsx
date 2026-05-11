import React, { useEffect, useRef } from 'react';

interface AnalogNeedleGaugeProps {
  value: number;
  min?: number;
  max?: number;
  label: string;
  unit?: string;
  color?: string;
}

const AnalogNeedleGauge: React.FC<AnalogNeedleGaugeProps> = ({
  value = 50,
  min = 0,
  max = 100,
  label,
  unit = '%',
  color = '#ff2a6d',
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
    <div style={{ width: '180px', textAlign: 'center', fontFamily: 'monospace' }}>
      <svg width="200" height="180" viewBox="0 0 200 180" >
        <defs>
          <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#333" />
            <stop offset="100%" stopColor="#111" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="75" fill="none" stroke="#222" strokeWidth="25" />
        <circle cx="100" cy="100" r="75" fill="none" stroke="#1a1a1a" strokeWidth="18" />
        <path d="M 40 130 A 75 75 0 0 1 160 130" fill="none" stroke={color} strokeWidth="14" strokeLinecap="round" />
        <path
          ref={needleRef}
          d="M 100 100 L 100 35"
          fill="none"
          stroke="#f0f0f0"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <circle cx="100" cy="100" r="12" fill="#111" />
        <circle cx="100" cy="100" r="6" fill="#ddd" />
      </svg>
      <div style={{ marginTop: '-15px', color: '#ccc', fontSize: '13px' }}>
        {label}
        <span style={{ color, marginLeft: '8px', fontWeight: 'bold' }}>
          {Math.round(normalized)}{unit}
        </span>
      </div>
    </div>
  );
};

export default AnalogNeedleGauge;
