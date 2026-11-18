import { useStore } from '../useStore.js';

const OUTCOMES = {
  complete: { eyebrow: 'HUNT COMPLETE', title: 'The first meal is cooked.' },
  ended: { eyebrow: 'HUNT ENDED', title: 'You walked back to camp.' },
};
const REGIONS = ['head', 'neck', 'chest', 'belly', 'rump', 'legs'];
const formatTime = seconds => {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function Results({ engine, onRestart, onMenu, onAbout }) {
  const r = useStore(engine.results);
  if (!r) return null;
  const outcome = OUTCOMES[r.outcome] ?? OUTCOMES.ended;
  const maxRegion = Math.max(1, ...REGIONS.map(k => r.hitsByRegion[k] ?? 0));
  return (
    <section className="panel results" role="dialog" aria-modal="true" aria-labelledby="results-title">
      <span className="eyebrow">{outcome.eyebrow} · HUNT TIME {formatTime(r.duration)}</span>
      <h2 id="results-title">{outcome.title}</h2>

      <div className="stat-tiles">
        <div><span>Attacks</span><b>{r.attacks}</b><small>{r.thrusts} thrust · {r.throws} thrown · {r.braces} braced</small></div>
        <div><span>Hits</span><b>{r.hits}</b><small>{r.accuracy}% of attacks · {r.glancing} glancing</small></div>
        <div><span>Meals cooked</span><b>{r.cooked} / {r.mealGoal}</b><small>{r.harvested} raw meat harvested</small></div>
        <div><span>Damage taken</span><b>{r.damageTaken}</b><small>{r.timesHurt} hits · {r.knockdowns} knockdowns · {r.respawns} returns to camp</small></div>
      </div>

      <div className="results-grid">
        <div>
          <h3>Where your spear landed</h3>
          {r.hits === 0 ? <p className="field-note">No hits this hunt.</p> : (
            <table className="bar-table">
              <caption className="sr-only">Hits by body region</caption>
              <tbody>
                {REGIONS.map(region => {
                  const count = r.hitsByRegion[region] ?? 0;
                  return (
                    <tr key={region}>
                      <th scope="row">{region}</th>
                      <td>{count > 0 && <span className="bar" style={{ width: `${(count / maxRegion) * 100}%` }} />}</td>
                      <td className="num">{count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3>The boars</h3>
          <ul className="boar-fates">
            {r.boars.map(b => (
              <li key={b.label}>
                <b>{b.label}</b><span className={`fate fate-${b.fate.split(' ')[0].toLowerCase()}`}>{b.fate}</span>
                <small>{b.wounds} wound{b.wounds === 1 ? '' : 's'}{b.regions.length ? ` · ${b.regions.join(', ')}` : ''} · blood {b.blood}%</small>
              </li>
            ))}
          </ul>
          <dl className="timeline">
            <div><dt>First blood</dt><dd>{formatTime(r.firstBlood)}</dd></div>
            <div><dt>First kill</dt><dd>{formatTime(r.firstKill)}</dd></div>
            <div><dt>Meal complete</dt><dd>{formatTime(r.completedAt)}</dd></div>
            <div><dt>Spears recovered</dt><dd>{r.recovered}</dd></div>
          </dl>
        </div>
      </div>

      <div className="button-row">
        <button type="button" className="primary" onClick={onRestart} autoFocus>HUNT AGAIN <span aria-hidden="true">↗</span></button>
        <button type="button" className="secondary" onClick={onMenu}>MAIN MENU</button>
        <button type="button" className="secondary" onClick={onAbout}>ABOUT THIS BUILD</button>
      </div>
    </section>
  );
}
