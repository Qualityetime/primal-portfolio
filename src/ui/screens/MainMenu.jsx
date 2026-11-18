import { useStore } from '../useStore.js';
import { PORTFOLIO } from '../../config/portfolio.js';
import { LoadingLine } from './LoadingLine.jsx';

const touchOnly = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

export function MainMenu({ engine, bootError, onPlay, onAbout }) {
  const assets = useStore(engine?.assets);
  return (
    <section className="panel lobby" aria-labelledby="menu-title">
      <span className="eyebrow">SINGLE-PLAYER DEMO · RUNS IN YOUR BROWSER</span>
      <h1 id="menu-title">Project<br />Primal</h1>
      <p className="intro">{PORTFOLIO.tagline} One hunter, wild boars with their own read of the situation, and a spear.</p>

      {bootError ? <p className="error" role="alert">{bootError}</p> : (
        <>
          {touchOnly && <p className="error">This demo needs a keyboard and mouse. Open it on a desktop browser to play; the project overview works anywhere.</p>}
          <button type="button" className="primary" onClick={onPlay} disabled={!engine}>PLAY DEMO <span aria-hidden="true">↗</span></button>
          <LoadingLine assets={assets} />
        </>
      )}
      <button type="button" className="secondary" onClick={onAbout}>ABOUT THIS BUILD · MULTIPLAYER FOOTAGE</button>
      <nav className="link-row" aria-label="Project links">
        {PORTFOLIO.sourceUrl && <a href={PORTFOLIO.sourceUrl} target="_blank" rel="noreferrer">SOURCE CODE ↗</a>}
        {PORTFOLIO.portfolioUrl && <a href={PORTFOLIO.portfolioUrl}>← PORTFOLIO</a>}
      </nav>
      <p className="field-note">Desktop browser with keyboard &amp; mouse. No install, account or server: the full simulation runs locally.</p>
    </section>
  );
}
