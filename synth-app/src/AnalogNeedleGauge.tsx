import React, { useEffect, useRef } from 'react';

interface AnalogNeedleGaugeProps {
  value: number;
  min?: number;
  max?: number;
  label: string;
  unit?: string;
  color?: string;
  size?: number;
}

const AnalogNeedleGauge: React.FC<AnalogNeedleGaugeProps> = ({
  value = 50,
  min = 0,
  max = 100,
  label,
  unit = '',
  color = '#ff2a6d',
  size = 160,
}) => {
  const needleRef = useRef<SVGPathElement>(null);
  const normalized = Math.max(min, Math.min(max, value));
  const percentage = (normalized - min) / (max - min);
  const angle = -135 + percentage * 270; // -135° to +135°

  useEffect(() => {
    if (needleRef.current) {
      needleRef.current.setAttribute('transform', `rotate(${angle} 80 80)`);
    }
  }, [angle]);

  return (
    <div style={{ width: size, textAlign: 'center', fontFamily: 'monospace' }}>
      <svg width={size} height={size} viewBox="0 0 160 160" className="gauge">
        {/* Background arc */}
        <path
          d="M 30 120 A 60 60 0 0 1 130 120"
          fill="none"
          stroke="#222222"
          strokeWidth="18"
          strokeLinecap="round"
        />
        {/* Colored arc */}
        <path
          d="M 30 120 A 60 60 0 0 1 130 120"
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${percentage * 190} 400`}
        />
        {/* Needle */}
        <g>
          <path
            ref={needleRef}
            d="M 80 80 L 80 35"
            fill="none"
            stroke="#eeeeee"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <circle cx="80" cy="80" r="10" fill="#111111" />
          <circle cx="80" cy="80" r="5" fill="#eeeeee" />
        </g>
        {/* Tick marks */}
        <g>
          {Array.from({ length: 21 }).map((_, i) => {
            const tickAngle = -135 + (i * 270) / 20;
            const x1 = 80 + Math.cos((tickAngle * Math.PI) / 180) * 65;
            const y1 = 80 + Math.sin((tickAngle * Math.PI) / 180) * 65;
            const x2 = 80 + Math.cos((tickAngle * Math.PI) / 180) * 72;
            const y2 = 80 + Math.sin((tickAngle * Math.PI) / 180) * 72;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#555" strokeWidth="2" />;
          })}
        </g>
      </svg>
      <div style={{ marginTop: '-15px', fontSize: '13px', color: '#ccc' }}>
        {label} <span style={{ color, fontWeight: 'bold' }}>{Math.round(normalized)}{unit}</span>
      </div>
    </div>
  );
};

export default AnalogNeedleGauge;
