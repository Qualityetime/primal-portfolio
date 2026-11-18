import { useStore } from '../useStore.js';
import { OBJECTIVES } from '../../engine/hudModel.js';

// The gameplay HUD. Re-renders only when the engine publishes a changed HUD
// model (≤ 20 Hz); nothing here runs per frame.
export function Hud({ engine, paused }) {
  const hud = useStore(engine.hud);
  if (!hud) return null;
  return (
    <div className={`hud${paused ? ' is-paused' : ''}`}>
      <Objective hud={hud} />
      <CampBearing hud={hud} />
      <Vitals hud={hud} />
      <Weapon hud={hud} />
      {!paused && <Crosshair charge={hud.charge} />}
      {hud.hint && !paused && <div className="interaction-prompt" role="status">{hud.hint}</div>}
      {hud.cooking > 0 && (
        <div className="cook-progress"><span>COOKING</span><div className="meter"><span style={{ width: `${hud.cooking * 100}%` }} /></div></div>
      )}
      {hud.hurt && <div className="damage-flash" aria-hidden="true" />}
      {hud.lowHealth && <div className="low-health" aria-hidden="true" />}
      {hud.down && <div className="knockdown" role="status">{hud.down === 'down' ? 'Returning to camp…' : 'Knocked down · getting up…'}</div>}
      <BottomStrip engine={engine} hud={hud} />
    </div>
  );
}

function Objective({ hud }) {
  return (
    <section className={`hud-card objective${hud.complete ? ' complete' : ''}`} aria-label="Objective">
      <span className="eyebrow">HUNT {String(hud.round).padStart(2, '0')} · {hud.boarsAlive}/{hud.boarsTotal} BOARS ALIVE</span>
      <h2>{hud.objective}</h2>
      <p>{hud.note}</p>
      <ol className="hunt-steps">
        {OBJECTIVES.slice(0, 3).map((o, i) => (
          <li key={o.step} className={i < hud.stage ? 'done' : i === hud.stage ? 'current' : ''}>{o.step}</li>
        ))}
      </ol>
      <div className="meals">{hud.meals} / {hud.mealGoal} MEALS</div>
    </section>
  );
}

function CampBearing({ hud }) {
  return (
    <div className="camp-bearing" aria-label={`Camp ${hud.campDistance} metres away`}>
      <span className="arrow" aria-hidden="true" style={{ transform: `rotate(${-hud.campTurn}rad)` }}>↑</span>
      <span>CAMP</span><b>{hud.campDistance} m</b>
    </div>
  );
}

function Meter({ value, className = '', small = false, wrap = '' }) {
  return <div className={`meter${small ? ' small' : ''}${wrap ? ` ${wrap}` : ''}`}><span className={className} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

function Vitals({ hud }) {
  return (
    <section className={`hud-card vitals${hud.bleeding ? ' bleeding' : ''}`} aria-label="Health and stamina">
      <div className="vital"><span>HEALTH{hud.bleeding ? ' · BLEEDING' : ''}</span><b>{hud.health}</b></div>
      <Meter value={hud.health} className={hud.health <= 25 ? 'low' : ''} wrap="health" />
      <div className="vital small"><span>STAMINA</span><b>{hud.stamina}</b></div>
      <Meter value={hud.stamina} small />
      <div className="inventory"><span>RAW MEAT <b>{hud.rawMeat}</b></span><span>COOKED <b>{hud.cookedMeat}</b></span></div>
    </section>
  );
}

function Weapon({ hud }) {
  return (
    <section className="hud-card weapon" aria-label="Spears">
      <div className="spear-pips" aria-hidden="true">
        {Array.from({ length: hud.spearCapacity }, (_, i) => <i key={i} className={i >= hud.spears ? 'spent' : ''} />)}
      </div>
      <span className="spear-label">{hud.spears} SPEAR{hud.spears === 1 ? '' : 'S'}{hud.spearStatus ? ` · ${hud.spearStatus}` : ''}</span>
      <Meter value={hud.spearReady * 100} small />
      <div className="weapon-keys"><span><kbd>LMB</kbd>THRUST</span><span><kbd>RMB</kbd>THROW</span><span><kbd>Q</kbd>BRACE</span></div>
    </section>
  );
}

function Crosshair({ charge }) {
  return (
    <div className="crosshair" aria-hidden="true">
      {charge > 0 && (
        <svg className={`charge-ring${charge >= 1 ? ' full' : ''}`} viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="16" pathLength="100" style={{ strokeDasharray: `${charge * 100} 100` }} />
        </svg>
      )}
    </div>
  );
}

function BottomStrip({ engine, hud }) {
  const perf = useStore(engine.perf);
  return (
    <div className="bottom-strip">
      <span><kbd>ESC</kbd> PAUSE <kbd>T</kbd> TELEMETRY <kbd>M</kbd> SOUND</span>
      <span>{hud.movement} · {perf.fps} FPS · LOCAL SIMULATION</span>
    </div>
  );
}
