import { PORTFOLIO } from '../config/portfolio.js';

export function BrandMark() {
  return (
    <svg className="brand-mark" aria-hidden="true" viewBox="0 0 36 48">
      <path d="M18 43V6M5 13l13 13 13-13" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

export function Masthead() {
  return (
    <header className="masthead">
      <BrandMark />
      <div><strong>PROJECT PRIMAL</strong><span>{PORTFOLIO.edition.toUpperCase()}</span></div>
      <span className="version">v{PORTFOLIO.version}</span>
    </header>
  );
}

export function Controls({ compact = false }) {
  const rows = [
    ['W A S D', 'Move'], ['SHIFT', 'Sprint'], ['MOUSE', 'Look'], ['SPACE', 'Jump'],
    ['LMB', 'Thrust spear'], ['RMB', 'Hold to aim · release to throw'], ['Q', 'Hold to brace against a charge'],
    ['E', 'Harvest · cook · recover spear'], ['ESC', 'Pause & settings'], ['T', 'Toggle boar telemetry'], ['M', 'Mute'],
  ];
  return (
    <dl className={`control-list${compact ? ' compact' : ''}`}>
      {rows.map(([key, action]) => (
        <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>
      ))}
    </dl>
  );
}
