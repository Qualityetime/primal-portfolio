export class InputController {
  constructor(canvas, onLockChange, onSoundToggle = () => {}) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    // Portfolio Edition: radians per pixel, adjustable from the React settings.
    this.sensitivity = 0.0022;
    this.jumpQueued = false;
    this.attackQueued = false;
    this.throwQueued = false;
    this.throwStartQueued = false;
    this.throwHeld = false;
    this.interactQueued = false;
    this.restartQueued = false;
    this.onLockChange = onLockChange;
    this.abort = new AbortController();
    const options = { signal: this.abort.signal };
    document.addEventListener('keydown', event => {
      if (!this.locked) return;
      if (event.code === 'Escape') {
        this.clear();
        document.exitPointerLock();
        return;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyE', 'KeyR', 'KeyQ'].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (event.code === 'Space' && !event.repeat) this.jumpQueued = true;
      if (event.code === 'KeyE' && !event.repeat) this.interactQueued = true;
      if (event.code === 'KeyR' && !event.repeat) this.restartQueued = true;
      if (event.code === 'KeyM' && !event.repeat) onSoundToggle();
    }, options);
    document.addEventListener('mousedown', event => {
      if (this.locked && event.button === 0) { event.preventDefault(); this.attackQueued = true; }
      if (this.locked && event.button === 2) {
        event.preventDefault();
        if (!this.throwHeld) this.throwStartQueued = true;
        this.throwHeld = true;
      }
    }, options);
    document.addEventListener('mouseup', event => {
      if (event.button !== 2) return;
      if (this.locked && this.throwHeld) this.throwQueued = true;
      this.throwHeld = false;
    }, options);
    canvas.addEventListener('contextmenu', event => event.preventDefault(), options);
    document.addEventListener('keyup', event => this.keys.delete(event.code), options);
    document.addEventListener('mousemove', event => {
      if (!this.locked) return;
      this.yaw -= event.movementX * this.sensitivity;
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - event.movementY * this.sensitivity));
    }, options);
    document.addEventListener('pointerlockchange', () => {
      this.clear();
      this.onLockChange(this.locked);
    }, options);
    window.addEventListener('blur', () => {
      this.clear();
      if (this.locked) document.exitPointerLock();
    }, options);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.clear();
        if (this.locked) document.exitPointerLock();
      }
    }, options);
  }

  get locked() { return document.pointerLockElement === this.canvas; }
  async lock() { await this.canvas.requestPointerLock(); }
  clear() {
    this.keys.clear();
    this.jumpQueued = this.attackQueued = this.throwQueued = this.interactQueued = this.restartQueued = false;
    this.throwStartQueued = this.throwHeld = false;
  }
  read() {
    const input = {
      forward: this.locked ? Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')) : 0,
      strafe: this.locked ? Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')) : 0,
      sprint: this.locked && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      jump: this.locked && this.jumpQueued,
      attack: this.locked && this.attackQueued,
      throw: this.locked && this.throwQueued,
      throwStart: this.locked && this.throwStartQueued,
      throwHeld: this.locked && this.throwHeld,
      brace: this.locked && this.keys.has('KeyQ'),
      interact: this.locked && this.interactQueued,
      restart: this.locked && this.restartQueued,
      yaw: this.yaw, pitch: this.pitch,
    };
    this.jumpQueued = this.attackQueued = this.throwQueued = this.interactQueued = this.restartQueued = false;
    this.throwStartQueued = false;
    return input;
  }
  destroy() { this.abort.abort(); this.clear(); }
}
