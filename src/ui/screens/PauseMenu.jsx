import { useStore } from '../useStore.js';
import { Controls } from '../Masthead.jsx';

export function PauseMenu({ engine, reason, onQuit }) {
  const settings = useStore(engine.settingsStore);
  const set = partial => engine.updateSettings(partial);
  return (
    <section className="panel pause" role="dialog" aria-modal="true" aria-labelledby="pause-title">
      <span className="eyebrow">PAUSED · THE SIMULATION IS STOPPED</span>
      <h2 id="pause-title">Hold still in the ravine.</h2>
      {reason === 'pointer' && <p className="error">Your browser needs one more click to capture the mouse. Press Resume.</p>}
      <div className="button-row stack">
        <button type="button" className="primary" onClick={() => engine.resume()} autoFocus>RESUME <span aria-hidden="true">↗</span></button>
        <button type="button" className="secondary" onClick={() => engine.restart()}>RESTART HUNT</button>
        <button type="button" className="secondary" onClick={() => engine.endHunt()}>END HUNT · SEE RESULTS</button>
        <button type="button" className="secondary" onClick={onQuit}>MAIN MENU</button>
      </div>

      <fieldset className="settings">
        <legend className="eyebrow">SETTINGS</legend>
        <label>
          <span>Mouse sensitivity <b>{settings.sensitivity.toFixed(2)}×</b></span>
          <input type="range" min="0.3" max="2.5" step="0.05" value={settings.sensitivity} onChange={e => set({ sensitivity: Number(e.target.value) })} />
        </label>
        <label>
          <span>Field of view <b>{settings.fov}°</b></span>
          <input type="range" min="60" max="100" step="1" value={settings.fov} onChange={e => set({ fov: Number(e.target.value) })} />
        </label>
        <label>
          <span>Render quality</span>
          <select value={settings.quality} onChange={e => set({ quality: e.target.value })}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low (shadows update 4×/s)</option>
          </select>
        </label>
        <label>
          <span>Boars in the ravine <small>(applies on restart)</small></span>
          <select value={settings.boarCount} onChange={e => set({ boarCount: Number(e.target.value) })}>
            <option value={1}>One</option>
            <option value={2}>Two</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={settings.telemetry} onChange={e => set({ telemetry: e.target.checked })} /> Boar telemetry overlay <kbd>T</kbd></label>
        <label className="check"><input type="checkbox" checked={!settings.muted} onChange={e => set({ muted: !e.target.checked })} /> Sound <kbd>M</kbd></label>
        <button type="button" className="text-button" onClick={() => engine.resetSettings()}>Reset to defaults</button>
      </fieldset>
      <Controls compact />
    </section>
  );
}
