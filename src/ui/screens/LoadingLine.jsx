export function LoadingLine({ assets }) {
  if (!assets) return <p className="loading-line">Starting the 3D view…</p>;
  if (assets.ready) {
    return <p className="loading-line ready">{assets.failed ? 'Boar model unavailable · stand-in model ready' : 'Ravine and boar ready'}</p>;
  }
  const percent = Math.round(assets.progress * 100);
  return (
    <div className="loading-line" role="progressbar" aria-label="Downloading the boar model" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <span>Loading the boar · {percent}%</span>
      <div className="meter small"><span style={{ width: `${percent}%` }} /></div>
    </div>
  );
}
