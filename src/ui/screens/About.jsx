import { PORTFOLIO } from '../../config/portfolio.js';
import { assetUrl } from '../../game/assetUrl.js';

function MultiplayerVideo() {
  const video = PORTFOLIO.multiplayerVideo;
  if (video.youtube) {
    return (
      <div className="video-frame">
        <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtube)}`} title="Primal multiplayer gameplay"
          allow="encrypted-media; picture-in-picture" allowFullScreen loading="lazy" />
      </div>
    );
  }
  if (video.file) {
    return (
      <div className="video-frame">
        <video controls preload="metadata" playsInline poster={video.poster ? assetUrl(`media/${video.poster}`) : undefined}>
          <source src={assetUrl(`media/${video.file}`)} />
          Your browser cannot play this video.
        </video>
      </div>
    );
  }
  // Integration point: no footage configured yet. Neutral card, never a broken player.
  return (
    <div className="video-frame placeholder">
      <span className="eyebrow">MULTIPLAYER FOOTAGE</span>
      <p>Gameplay recording of the original multiplayer build will appear here.</p>
      {import.meta.env?.DEV && <p className="field-note">Developer: set <code>multiplayerVideo</code> in <code>src/config/portfolio.js</code> (a file in <code>public/media/</code> or a YouTube ID).</p>}
    </div>
  );
}

export function About({ canPlay, onPlay, onBack }) {
  return (
    <section className="panel about" aria-labelledby="about-title">
      <span className="eyebrow">ABOUT THIS BUILD · {PORTFOLIO.edition.toUpperCase()}</span>
      <h2 id="about-title">From a co-op server to a browser demo.</h2>
      <div className="about-grid">
        <div>
          <p>
            Primal is a first-person prehistoric hunting prototype. The original is a four-player game: a Node.js server
            runs an authoritative 60&nbsp;Hz simulation and streams state to browsers over Socket.IO, while each client
            predicts its own movement and reconciles with the server.
          </p>
          <p>
            This edition runs that same simulation inside the page. The authoritative game state, boar AI, ellipsoid
            anatomy and wound model are reused unchanged; a local adapter replaces the network, and React replaces the
            hand-built DOM interface. It is a static site with no backend.
          </p>
          <div className="distinction">
            <div><b>Playable here</b><span>Single player · one or two boars · runs entirely in your browser</span></div>
            <div><b>Shown in video only</b><span>Original multiplayer build · up to four hunters · Node.js server</span></div>
          </div>
          <h3>What to look for</h3>
          <ul className="plain">
            <li>Boars perceive line of sight, remember threats, weigh pressure and temperament, and commit to warning, charging, bluffing, kicking or fleeing.</li>
            <li>Spears hit a per-region anatomy (head, neck, chest, belly, rump, legs). Depth, bleeding, limping and laboured breathing change behaviour.</li>
            <li>The telemetry panel (<kbd>T</kbd>) reads the live brain: behaviour state, stated intent, pressure history, blood and wounds.</li>
            <li>React draws the interface from throttled engine snapshots, so the 60&nbsp;Hz loop never waits on a render.</li>
          </ul>
        </div>
        <div>
          <MultiplayerVideo />
          <p className="caption">{PORTFOLIO.multiplayerVideo.caption}</p>
          <h3>Built with</h3>
          <dl className="tech">
            {PORTFOLIO.technologies.map(([name, use]) => <div key={name}><dt>{name}</dt><dd>{use}</dd></div>)}
          </dl>
          <nav className="link-row" aria-label="Project links">
            {PORTFOLIO.sourceUrl && <a href={PORTFOLIO.sourceUrl} target="_blank" rel="noreferrer">SOURCE CODE ↗</a>}
            {PORTFOLIO.multiplayerSourceUrl && <a href={PORTFOLIO.multiplayerSourceUrl} target="_blank" rel="noreferrer">MULTIPLAYER SOURCE ↗</a>}
            {PORTFOLIO.portfolioUrl && <a href={PORTFOLIO.portfolioUrl}>← PORTFOLIO</a>}
          </nav>
        </div>
      </div>
      <div className="button-row">
        <button type="button" className="primary" onClick={onPlay} disabled={!canPlay}>PLAY DEMO <span aria-hidden="true">↗</span></button>
        <button type="button" className="secondary" onClick={onBack}>BACK</button>
      </div>
    </section>
  );
}
