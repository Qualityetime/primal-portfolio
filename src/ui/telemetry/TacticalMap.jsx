import { useEffect, useRef } from 'react';
import { HUNT } from '../../../shared/hunt.js';

// Top-down situational map, north up, centred on the hunter. Drawn
// imperatively from the engine's map store (10 Hz): subscribing in an effect
// and painting the canvas directly means no React re-render per update.
const SIZE = 216, RANGE = 30; // metres from centre to edge
const COLORS = {
  calm: '#9aa394', alert: '#c98500', aggressive: '#d55181', evasive: '#3987e5', hurt: '#9aa394', dead: '#5d635a',
  ink: '#e9e2cf', muted: '#7f8a7c', grid: '#ffffff14', obstacle: '#ffffff1f', water: '#5f8fa0', blood: '#8a2f22', camp: '#d2b68c',
};

export function TacticalMap({ engine }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
    const world = engine.world, creek = engine.environment.sounds.creek ?? [];
    const scale = SIZE / 2 / RANGE;
    const draw = () => {
      const data = engine.map.get();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      if (!data) return;
      const { player } = data;
      const sx = x => SIZE / 2 + (x - player.x) * scale, sy = z => SIZE / 2 + (z - player.z) * scale;
      // Range rings every 10 m.
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
      for (let r = 10; r <= RANGE; r += 10) { ctx.beginPath(); ctx.arc(SIZE / 2, SIZE / 2, r * scale, 0, Math.PI * 2); ctx.stroke(); }
      // Static terrain: obstacles (rocks, trunks, cliff colliders) and the creek.
      ctx.fillStyle = COLORS.obstacle;
      for (const o of world.obstacles) {
        if (Math.abs(o.x - player.x) > RANGE + o.radius || Math.abs(o.z - player.z) > RANGE + o.radius) continue;
        ctx.beginPath(); ctx.arc(sx(o.x), sy(o.z), Math.max(1, o.radius * scale), 0, Math.PI * 2); ctx.fill();
      }
      if (creek.length > 1) {
        ctx.strokeStyle = COLORS.water; ctx.lineWidth = 2; ctx.globalAlpha = 0.6; ctx.beginPath();
        creek.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))));
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      // Camp and its safe radius.
      ctx.strokeStyle = COLORS.camp; ctx.setLineDash([3, 3]); ctx.beginPath();
      ctx.arc(sx(HUNT.camp.x), sy(HUNT.camp.z), HUNT.campSafeRange * scale, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS.camp; ctx.fillRect(sx(HUNT.camp.x) - 3, sy(HUNT.camp.z) - 3, 6, 6);
      // Blood trail and loose spears.
      ctx.fillStyle = COLORS.blood;
      for (const t of data.tracks) { ctx.beginPath(); ctx.arc(sx(t.x), sy(t.z), 1.6, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 1.5;
      for (const s of data.spears) { ctx.beginPath(); ctx.moveTo(sx(s.x) - 3, sy(s.z) + 3); ctx.lineTo(sx(s.x) + 3, sy(s.z) - 3); ctx.stroke(); }
      ctx.fillStyle = COLORS.ink;
      for (const p of data.projectiles) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.z), 2, 0, Math.PI * 2); ctx.fill(); }
      // Boars: heading triangle in behaviour colour; ring when it perceives you; X when down.
      data.animals.forEach((a, i) => {
        const x = Math.max(8, Math.min(SIZE - 8, sx(a.x))), y = Math.max(8, Math.min(SIZE - 8, sy(a.z)));
        ctx.save(); ctx.translate(x, y);
        if (!a.alive) {
          ctx.strokeStyle = COLORS.dead; ctx.lineWidth = 2; ctx.beginPath();
          ctx.moveTo(-4, -4); ctx.lineTo(4, 4); ctx.moveTo(4, -4); ctx.lineTo(-4, 4); ctx.stroke();
        } else {
          if (a.sees) { ctx.strokeStyle = COLORS[a.group]; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke(); }
          ctx.rotate(-a.yaw); // forward is (-sin yaw, -cos yaw) in x/z
          ctx.fillStyle = COLORS[a.group]; ctx.strokeStyle = '#141c17'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.stroke(); ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = COLORS.ink; ctx.font = '9px Consolas, monospace'; ctx.fillText(String(i + 1), x + 8, y - 6);
      });
      // Hunter at the centre.
      ctx.save(); ctx.translate(SIZE / 2, SIZE / 2);
      ctx.rotate(-player.yaw);
      ctx.fillStyle = COLORS.ink; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(4.5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4.5, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = COLORS.muted; ctx.font = '9px Consolas, monospace'; ctx.fillText('N', SIZE / 2 - 3, 10); ctx.fillText(`${RANGE} m`, SIZE - 30, SIZE - 6);
    };
    draw();
    return engine.map.subscribe(draw);
  }, [engine]);

  return (
    <figure className="tactical-map">
      <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE }} role="img" aria-label="Top-down map of the hunter, boars, camp and blood trail" />
      <figcaption className="map-legend">
        <span><i className="sw alert" />Alert</span><span><i className="sw aggressive" />Aggressive</span>
        <span><i className="sw evasive" />Evasive</span><span><i className="sw calm" />Calm / recovering</span>
        <span>◯ sees you</span><span className="blood">● blood</span>
      </figcaption>
    </figure>
  );
}
