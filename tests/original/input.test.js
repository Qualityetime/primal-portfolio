import test from 'node:test';
import assert from 'node:assert/strict';
import { InputController } from '../../src/game/input.js';

function setup(t) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const doc = new EventTarget(), win = new EventTarget(), canvas = new EventTarget();
  globalThis.document = doc; globalThis.window = win; doc.pointerLockElement = canvas;
  doc.exitPointerLock = () => { doc.pointerLockElement = null; doc.dispatchEvent(new Event('pointerlockchange')); };
  const input = new InputController(canvas, () => {});
  t.after(() => { input.destroy(); globalThis.document = previous.document; globalThis.window = previous.window; });
  function send(type, fields = {}, target = doc) {
    const event = new Event(type, { cancelable: true }); Object.assign(event, fields); target.dispatchEvent(event);
  }
  return { input, send, win, doc };
}

test('client RMB starts wind-up once, stays held, and throws only on release', t => {
  const { input, send } = setup(t);
  send('mousedown', { button: 2 });
  const first = input.read(); assert.equal(first.throwStart, true); assert.equal(first.throwHeld, true); assert.equal(first.throw, false);
  const held = input.read(); assert.equal(held.throwStart, false); assert.equal(held.throwHeld, true);
  send('mouseup', { button: 2 }); const release = input.read(); assert.equal(release.throw, true); assert.equal(release.throwHeld, false);
  assert.equal(input.read().throw, false, 'release is queued once');
});

test('a quick RMB click between ticks retains both the start and weak release', t => {
  const { input, send } = setup(t);
  send('mousedown', { button: 2 }); send('mouseup', { button: 2 });
  const tap = input.read(); assert.equal(tap.throwStart, true); assert.equal(tap.throw, true); assert.equal(tap.throwHeld, false);
});

test('Escape, blur, and hidden-tab input cancel the draw without accidentally throwing', t => {
  const { input, send, win, doc } = setup(t);
  for (const reason of ['Escape', 'blur', 'hidden']) {
    doc.pointerLockElement = input.canvas; doc.hidden = false;
    send('mousedown', { button: 2 }); input.read();
    if (reason === 'Escape') send('keydown', { code: 'Escape' });
    if (reason === 'blur') send('blur', {}, win);
    if (reason === 'hidden') { doc.hidden = true; send('visibilitychange'); }
    send('mouseup', { button: 2 }); const canceled = input.read();
    assert.equal(canceled.throwHeld, false); assert.equal(canceled.throw, false); assert.equal(canceled.throwStart, false);
  }
});
