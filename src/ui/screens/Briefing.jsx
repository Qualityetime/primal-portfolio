import { useStore } from '../useStore.js';
import { Controls } from '../Masthead.jsx';
import { LoadingLine } from './LoadingLine.jsx';
import { HUNT } from '../../../shared/hunt.js';

export function Briefing({ engine, onStart, onBack }) {
  const assets = useStore(engine.assets);
  const settings = useStore(engine.settingsStore);
  const ready = assets?.ready;
  return (
    <section className="panel briefing" aria-labelledby="briefing-title">
      <span className="eyebrow">BEFORE YOU GO · {settings.boarCount === 1 ? 'ONE BOAR' : 'TWO BOARS'} IN THE RAVINE</span>
      <h2 id="briefing-title">Bring home the first meal.</h2>
      <ol className="steps">
        <li><b>Hunt.</b> Find a boar. Thrust at close range or throw from a distance; the chest and neck bleed most.</li>
        <li><b>Harvest.</b> Walk up to the carcass and press <kbd>E</kbd>.</li>
        <li><b>Cook.</b> Return to the campfire and cook {HUNT.mealGoal} pieces of meat with <kbd>E</kbd>.</li>
      </ol>
      <p className="field-note">Boars notice you, warn, charge, bluff, kick or flee depending on temperament, pressure and their wounds. Hold <kbd>Q</kbd> to brace a spear against a charge. The camp is safe ground.</p>
      <Controls />
      <button type="button" className="primary" onClick={onStart} disabled={!ready}>
        {ready ? 'ENTER THE RAVINE' : 'PREPARING THE RAVINE…'} <span aria-hidden="true">↗</span>
      </button>
      {!ready && <LoadingLine assets={assets} />}
      <p className="field-note">Your mouse is captured while you play. Press <kbd>ESC</kbd> to pause, change settings or end the hunt.</p>
      <button type="button" className="secondary" onClick={onBack}>BACK</button>
    </section>
  );
}
