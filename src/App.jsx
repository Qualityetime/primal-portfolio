import { useEffect, useRef, useState, useCallback } from 'react';
import { GameEngine, WebGLUnavailableError } from './engine/GameEngine.js';
import { useStore } from './ui/useStore.js';
import { MainMenu } from './ui/screens/MainMenu.jsx';
import { Briefing } from './ui/screens/Briefing.jsx';
import { About } from './ui/screens/About.jsx';
import { PauseMenu } from './ui/screens/PauseMenu.jsx';
import { Results } from './ui/screens/Results.jsx';
import { Hud } from './ui/hud/Hud.jsx';
import { Toast } from './ui/hud/Toast.jsx';
import { TelemetryPanel } from './ui/telemetry/TelemetryPanel.jsx';
import { Masthead } from './ui/Masthead.jsx';

const VIEWS = ['menu', 'briefing', 'about'];
const viewFromHash = () => {
  const hash = location.hash.replace('#', '');
  return VIEWS.includes(hash) ? hash : 'menu';
};

export default function App() {
  const stageRef = useRef(null);
  const [engine, setEngine] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [view, setViewState] = useState(viewFromHash);

  // The engine (Three.js, simulation, input) lives outside React's render
  // cycle. React owns its lifetime: create on mount, dispose on unmount.
  useEffect(() => {
    let instance = null;
    try {
      const debug = new URLSearchParams(location.search).has('debug');
      instance = new GameEngine(stageRef.current, { debug });
      setEngine(instance);
    } catch (error) {
      console.error(error);
      setBootError(error instanceof WebGLUnavailableError ? error.message
        : 'The 3D view could not start in this browser. Try an up-to-date desktop Chrome, Edge or Firefox.');
    }
    return () => { instance?.dispose(); setEngine(null); };
  }, []);

  const setView = useCallback(next => {
    setViewState(next);
    const url = new URL(location.href);
    url.hash = next === 'menu' ? '' : next;
    history.replaceState(null, '', url);
  }, []);
  useEffect(() => {
    const onHash = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const app = useStore(engine?.app);
  const settings = useStore(engine?.settingsStore);
  const phase = app?.phase ?? 'lobby';
  const inHunt = phase === 'playing' || phase === 'paused';

  // T toggles the telemetry overlay during a hunt (pointer lock keeps keys on document).
  useEffect(() => {
    if (!engine || !inHunt) return undefined;
    const onKey = event => {
      if (event.code === 'KeyT' && !event.repeat) engine.updateSettings({ telemetry: !engine.settings.telemetry });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [engine, inHunt]);

  const startHunt = () => { setView('menu'); engine?.startHunt(); };
  const toLobby = target => { engine?.quitToLobby(); setView(target); };

  return (
    <>
      <div className="stage" ref={stageRef} />
      <div className="vignette" aria-hidden="true" />
      {phase === 'lobby' && view !== 'about' && <Masthead />}

      {phase === 'lobby' && view === 'menu' && (
        <MainMenu engine={engine} bootError={bootError} onPlay={() => setView('briefing')} onAbout={() => setView('about')} />
      )}
      {phase === 'lobby' && view === 'briefing' && engine && <Briefing engine={engine} onStart={startHunt} onBack={() => setView('menu')} />}
      {phase === 'lobby' && view === 'about' && <About canPlay={!!engine} onPlay={() => setView('briefing')} onBack={() => setView('menu')} />}

      {inHunt && engine && <Hud engine={engine} paused={phase === 'paused'} />}
      {inHunt && engine && settings?.telemetry && <TelemetryPanel engine={engine} />}
      {phase === 'paused' && engine && <PauseMenu engine={engine} reason={app.pauseReason} onQuit={() => toLobby('menu')} />}
      {phase === 'results' && engine && (
        <Results engine={engine} onRestart={() => engine.restart()} onMenu={() => toLobby('menu')} onAbout={() => toLobby('about')} />
      )}
      {engine && <Toast store={engine.toasts} visible={inHunt} />}

      {app?.notice && phase === 'lobby' && <p className="notice" role="status">{app.notice}</p>}
      {app?.fatal && (
        <div className="fatal" role="alert">
          <h2>The hunt stopped.</h2>
          <p>{app.fatal}</p>
          <button type="button" onClick={() => location.reload()}>RELOAD</button>
        </div>
      )}
    </>
  );
}
