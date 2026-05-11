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
  color = '#00ff9d',
  size = 180,
}) => {
  const needleRef = useRef<SVGGElement>(null);
  const normalized = Math.max(min, Math.min(max, value));
  const angle = -135 + ((normalized - min) / (max - min)) * 270;

  useEffect(() => {
    if (needleRef.current) {
      needleRef.current.setAttribute('transform', `rotate(${angle} ${size/2} ${size/2})`);
    }
  }, [angle, size]);

  return (
    <div className="analog-gauge flex flex-col items-center" style={{width: size}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-lg">
        {/* Background arc */}
        <circle 
          cx={size/2} 
          cy={size/2} 
          r={size * 0.42} 
          fill="none" 
          stroke="#1a1a1a" 
          strokeWidth={size * 0.1} 
        />
        {/* Scale arc */}
        <path
          d={`M ${size*0.2} ${size*0.75} A ${size*0.4} ${size*0.4} 0 0 1 ${size*0.8} ${size*0.75}`}
          fill="none"
          stroke="#333"
          strokeWidth={size * 0.08}
          strokeLinecap="round"
        />
        {/* Colored active arc */}
        <path
          d={`M ${size*0.2} ${size*0.75} A ${size*0.4} ${size*0.4} 0 0 1 ${size*0.8} ${size*0.75}`}
          fill="none"
          stroke={color}
          strokeWidth={size * 0.055}
          strokeDasharray={`${(normalized / max) * 200} 400`}
          strokeLinecap="round"
        />
        {/* Ticks */}
        {Array.from({length: 21}, (_, i) => {
          const tickAngle = -135 + (i * 270) / 20;
          const isMajor = i % 5 === 0;
          return (
            <line
              key={i}
              x1={size/2}
              y1={size/2}
              x2={size/2 + (isMajor ? 55 : 40) * Math.cos((tickAngle - 90) * Math.PI / 180)}
              y2={size/2 + (isMajor ? 55 : 40) * Math.sin((tickAngle - 90) * Math.PI / 180)}
              stroke={isMajor ? '#ddd' : '#666'}
              strokeWidth={isMajor ? 3 : 2}
              strokeLinecap="round"
            />
          );
        })}
        {/* Needle group */}
        <g ref={needleRef}>
          <line
            x1={size/2}
            y1={size/2}
            x2={size/2}
            y2={size * 0.18}
            stroke="#ff3366"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <circle cx={size/2} cy={size/2} r="12" fill="#111" />
          <circle cx={size/2} cy={size/2} r="6" fill="#ff3366" />
        </g>
        {/* Center highlight */}
        <circle cx={size/2} cy={size/2} r="8" fill="#222" />
      </svg>
      <div className="mt-1 text-center">
        <div className="text-xs font-mono tracking-widest text-gray-400">{label}</div>
        <div className="text-lg font-bold text-white">{Math.round(normalized)}{unit}</div>
      </div>
    </div>
  );
};

export default AnalogNeedleGauge;
