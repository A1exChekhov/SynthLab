import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  analyzer: AnalyserNode | null;
  color?: string;
  height?: number;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ analyzer, color = '#05d9e8', height = 100 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyzer || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyzer.frequencyBinCount;
    const dataArrayTime = new Uint8Array(bufferLength);
    const dataArrayFreq = new Uint8Array(bufferLength);

    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyzer.getByteTimeDomainData(dataArrayTime);
      analyzer.getByteFrequencyData(dataArrayFreq);

      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const halfH = canvas.height / 2;

      // --- Draw Oscilloscope (Top Half) ---
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.shadowBlur = 8;
      ctx.shadowColor = color;
      ctx.beginPath();
      
      const sliceWidth = canvas.width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArrayTime[i] / 128.0; // 0 to 2, centered at 1
        // Map 0-2 to 0-halfH
        const y = (v * halfH) / 2 + (halfH / 4);

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);

        x += sliceWidth;
      }
      ctx.lineTo(canvas.width, halfH / 2);
      ctx.stroke();

      // --- Draw Frequency Spectrum (Bottom Half) ---
      ctx.shadowBlur = 0; // Turn off glow for bars to save performance
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barX = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArrayFreq[i] / 255) * halfH;

        // Gradient color based on frequency bin
        const r = barHeight + (25 * (i / bufferLength));
        const g = 50;
        const b = 250 - (barHeight * 2);
        
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(barX, canvas.height - barHeight, barWidth, barHeight);

        barX += barWidth + 1;
      }
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [analyzer, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={400} 
      height={height} 
      style={{ 
        width: '100%', 
        height: `${height}px`, 
        background: '#050508', 
        borderRadius: '8px',
        border: '1px solid #333344'
      }} 
    />
  );
};

export default AudioVisualizer;
