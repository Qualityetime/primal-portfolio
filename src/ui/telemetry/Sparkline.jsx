import { useState } from 'react';
import { HISTORY_LENGTH } from '../../engine/telemetry.js';

// Single-series 0–1 trend over the last ~14 s, fixed domain so successive frames
// are comparable. Hover shows the sample under the pointer.
const W = 120, H = 26, SAMPLE_SECONDS = 0.2;
export function Sparkline({ values, label }) {
  const [hover, setHover] = useState(null);
  if (!values?.length) return <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" />;
  const x = i => (W * (HISTORY_LENGTH - values.length + i)) / (HISTORY_LENGTH - 1);
  const y = v => H - 2 - v * (H - 4);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${H} ${line} ${x(values.length - 1).toFixed(1)},${H}`;
  const onMove = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.round((px * (HISTORY_LENGTH - 1)) / W) - (HISTORY_LENGTH - values.length);
    setHover(i >= 0 && i < values.length ? i : null);
  };
  return (
    <span className="sparkline-wrap">
      <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${label}: ${Math.round(values.at(-1) * 100)}% now`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <line className="grid" x1="0" x2={W} y1={y(0.65)} y2={y(0.65)} />
        <polygon className="area" points={area} />
        <polyline className="line" points={line} />
        {hover !== null && <line className="cursor" x1={x(hover)} x2={x(hover)} y1="0" y2={H} />}
      </svg>
      {hover !== null && (
        <span className="spark-tip" role="tooltip">
          {Math.round(values[hover] * 100)}% · {((values.length - 1 - hover) * SAMPLE_SECONDS).toFixed(1)} s ago
        </span>
      )}
    </span>
  );
}
