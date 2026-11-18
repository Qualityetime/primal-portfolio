import { useState } from 'react';
import { useStore } from '../useStore.js';
import { TacticalMap } from './TacticalMap.jsx';
import { Sparkline } from './Sparkline.jsx';

const PRESSURE_LABELS = {
  proximity: 'Proximity', closing: 'Closing speed', hunters: 'Hunters', geometry: 'Flanked',
  blocked: 'Escape blocked', injury: 'Injury', pursuit: 'Pursuit', reapproach: 'Re-approach',
  sustained: 'Sustained', trauma: 'Fresh trauma',
};

// Live read-out of the boar brains (5 Hz) and a tactical map (10 Hz).
export function TelemetryPanel({ engine }) {
  const telemetry = useStore(engine.telemetry);
  return (
    <aside className="telemetry" aria-label="Boar telemetry">
      <header>
        <span className="eyebrow">BOAR TELEMETRY · LIVE</span>
        <span className="mono">t {telemetry ? telemetry.seconds.toFixed(1) : '0.0'} s</span>
      </header>
      <TacticalMap engine={engine} />
      {telemetry?.animals.map(animal => <BoarCard key={animal.id} animal={animal} />)}
      <p className="telemetry-foot">Values are read from the running AI each 0.2 s. <kbd>T</kbd> hides this panel.</p>
    </aside>
  );
}

function Bar({ label, value, tone = '', note }) {
  return (
    <div className="t-bar">
      <span>{label}</span>
      <div className="meter small"><span className={tone} style={{ width: `${Math.round(value * 100)}%` }} /></div>
      <b>{note ?? `${Math.round(value * 100)}%`}</b>
    </div>
  );
}

function BoarCard({ animal: a }) {
  const [open, setOpen] = useState(false);
  const parts = Object.entries(a.pressureParts).filter(([, v]) => v > 0.01).sort((x, y) => y[1] - x[1]).slice(0, 4);
  const regions = a.wounds.reduce((acc, w) => { if (!w.glancing) acc[w.region] = (acc[w.region] ?? 0) + 1; return acc; }, {});
  return (
    <section className={`boar-card group-${a.behaviour.group}`} aria-label={`${a.label} telemetry`}>
      <div className="boar-head">
        <b>{a.label}</b>
        <span className="state-chip"><i aria-hidden="true" />{a.behaviour.label}</span>
        <span className="mono">{a.alive ? `${a.distance} m` : '—'}</span>
      </div>
      <p className="intent">“{a.reason}”</p>
      {a.alive && (
        <div className="awareness">
          <span className={a.perceivesHunter ? 'sees' : ''}>{a.perceivesHunter ? 'SEES YOU' : a.stage === 'remembered' ? 'REMEMBERS YOU' : 'UNAWARE'}</span>
          <span>suspicion {Math.round(a.suspicion * 100)}%</span>
          <span>speed {a.speed.toFixed(1)} m/s</span>
        </div>
      )}
      <Bar label="Health" value={a.health} />
      <Bar label="Blood" value={a.blood} tone={a.blood < 0.6 ? 'low' : ''} note={a.bleedRate > 0 ? `${Math.round(a.blood * 100)}% ↓` : undefined} />
      <div className="spark-row">
        <span>Pressure</span>
        <Sparkline values={a.history.pressure} label={`${a.label} pressure`} />
        <b>{Math.round(a.pressure * 100)}%</b>
      </div>
      {(a.limp > 0.02 || a.lung > 0.02 || a.embeddedSpears > 0 || Object.keys(regions).length > 0) && (
        <div className="conditions">
          {Object.entries(regions).map(([region, n]) => <span key={region}>{region}{n > 1 ? ` ×${n}` : ''}</span>)}
          {a.limp > 0.02 && <span>limp {Math.round(a.limp * 100)}%</span>}
          {a.lung > 0.02 && <span>lung {Math.round(a.lung * 100)}%</span>}
          {a.embeddedSpears > 0 && <span>{a.embeddedSpears} spear{a.embeddedSpears > 1 ? 's' : ''} lodged</span>}
        </div>
      )}
      <button type="button" className="text-button" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} decision detail
      </button>
      {open && (
        <div className="boar-detail">
          <h4>Pressure drivers</h4>
          {parts.length ? parts.map(([k, v]) => <Bar key={k} label={PRESSURE_LABELS[k] ?? k} value={v} />) : <p className="field-note">No pressure.</p>}
          <h4>Temperament</h4>
          {Object.entries(a.temperament).map(([k, v]) => <Bar key={k} label={k} value={v} />)}
          <h4>Recent decisions</h4>
          <ol className="trace">
            {a.trace.map(t => <li key={`${t.tick}-${t.state}`}><span className="mono">−{t.ago.toFixed(1)}s</span> <b>{t.state}</b> {t.reason !== t.state ? t.reason : ''}</li>)}
          </ol>
          <p className="field-note">Decision interval {a.decisionSeconds.toFixed(2)} s (shorter under pressure).</p>
        </div>
      )}
    </section>
  );
}
