// Small synthesized cues: no audio downloads, and sound starts only after a click.
export class GameSound {
  constructor() { this.context = null; this.muted = false; }
  unlock() {
    try {
      this.context ??= new (window.AudioContext || window.webkitAudioContext)();
      this.context.resume().catch(() => {});
    } catch { /* The game remains playable when audio is unavailable. */ }
  }
  toggle() { this.muted = !this.muted; if (this.muted) this.ambient(null); return this.muted; }

  // Hunt Slice 0.1 ambience, synthesized like the cues: running water whose
  // level follows distance to the falls and the creek, an occasional crackle by
  // the fire and sparse bird calls. Nothing is downloaded.
  ambient(position, sources = {}) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.bed) {
      const length = ctx.sampleRate * 2, buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < length; i++) { brown = (brown + (Math.random() * 2 - 1) * 0.06) * 0.985; data[i] = brown * 3 + (Math.random() * 2 - 1) * 0.08; }
      const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 1400;
      const gain = ctx.createGain(); gain.gain.value = 0;
      source.connect(low); low.connect(gain); gain.connect(ctx.destination); source.start();
      this.bed = { gain, buffer, nextBird: ctx.currentTime + 4, nextCrackle: 0 };
    }
    const now = ctx.currentTime, bed = this.bed;
    if (!position || this.muted) { bed.gain.gain.setTargetAtTime(0, now, 0.4); return; }
    const falls = sources.falls ? Math.hypot(position.x - sources.falls.x, position.z - sources.falls.z) : Infinity;
    let creek = Infinity;
    const line = sources.creek ?? [];
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1], [bx, bz] = line[i], dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((position.x - ax) * dx + (position.z - az) * dz) / l));
      creek = Math.min(creek, Math.hypot(ax + dx * t - position.x, az + dz * t - position.z));
    }
    const level = Math.max(0, 1 - falls / 45) ** 2 * 0.06 + Math.max(0, 1 - creek / 16) * 0.022 + 0.004;
    bed.gain.gain.setTargetAtTime(level, now, 0.5);
    const camp = sources.camp ? Math.hypot(position.x - sources.camp.x, position.z - sources.camp.z) : Infinity;
    if (camp < 9 && now > bed.nextCrackle) {
      bed.nextCrackle = now + 0.08 + Math.random() * 0.5;
      const burst = ctx.createBufferSource(); burst.buffer = bed.buffer;
      const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 1800 + Math.random() * 1500;
      const g = ctx.createGain(); g.gain.setValueAtTime((1 - camp / 9) * 0.05 * Math.random(), now); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
      burst.connect(high); high.connect(g); g.connect(ctx.destination);
      burst.start(now, Math.random() * 1.5, 0.05); burst.onended = () => { burst.disconnect(); high.disconnect(); g.disconnect(); };
    }
    if (now > bed.nextBird) {
      bed.nextBird = now + 5 + Math.random() * 9;
      const base = 1900 + Math.random() * 900;
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) this.tone(base * (1 + i * 0.06), 0.09, 0.006, base * 1.25, 'sine', i * 0.13);
    }
  }
  tone(frequency, duration, volume = 0.04, endFrequency = frequency, type = 'sine', delay = 0) {
    if (this.muted || this.context?.state !== 'running') return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator(), gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(10, endFrequency), start + duration);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.connect(gain); gain.connect(this.context.destination);
    oscillator.start(start); oscillator.stop(start + duration + 0.02);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  play(type) {
    if (type === 'throw') this.tone(330, 0.16, 0.035, 80, 'triangle');
    if (type === 'thrust') this.tone(190, 0.13, 0.025, 70, 'triangle');
    if (type === 'braced') this.tone(75, 0.21, 0.08, 28, 'triangle');
    if (type === 'hit') { this.tone(105, 0.12, 0.09, 35, 'triangle'); this.tone(650, 0.09, 0.025, 200); }
    if (type === 'hurt') this.tone(90, 0.3, 0.08, 30, 'sawtooth');
    if (type === 'warning') this.tone(65, 0.4, 0.045, 42, 'sawtooth');
    if (type === 'kill') this.tone(110, 0.32, 0.06, 35, 'triangle');
    if (type === 'harvest' || type === 'cooked') { this.tone(440, 0.13); this.tone(660, 0.2, 0.035, 660, 'sine', 0.12); }
    if (type === 'complete') [0, 1, 2].forEach(i => this.tone([330, 440, 660][i], 0.45, 0.045, [330, 440, 660][i], 'triangle', i * 0.16));
  }
}
