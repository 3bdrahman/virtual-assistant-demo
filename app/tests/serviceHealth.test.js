import assert from 'node:assert/strict';
import test from 'node:test';
import { watchServiceHealth } from '../src/services/serviceHealth.js';

const settle = () => new Promise(setImmediate);
function fixture(probe) {
  const documentObject = new EventTarget();
  documentObject.visibilityState = 'visible';
  const windowObject = new EventTarget();
  windowObject.navigator = { onLine: true };
  const scheduled = new Map();
  const states = [];
  const stop = watchServiceHealth({ probe, onChange: (state) => states.push(state), documentObject, windowObject,
    schedule: (callback, ms) => { const handle = {}; scheduled.set(handle, { callback, ms }); return handle; },
    clear: (handle) => scheduled.delete(handle) });
  return { documentObject, windowObject, states, scheduled, stop,
    async poll() { const [handle, task] = scheduled.entries().next().value; scheduled.delete(handle); task.callback(); await settle(); } };
}

test('health polling confirms a transient failure before disconnecting and avoids unchanged renders', async () => {
  const results = [{ ok: true, requiresUserKey: true }, { ok: true, requiresUserKey: true }, { ok: false }, { ok: false }, { ok: true, requiresUserKey: true }];
  const f = fixture(async () => results.shift());
  try {
    await settle();
    assert.equal(f.states.length, 1);
    await f.poll();
    assert.equal(f.states.length, 1, 'unchanged health must not rerender the app');
    await f.poll();
    assert.equal(f.states.at(-1).online, true, 'one failed probe must not interrupt a working conversation');
    assert.equal([...f.scheduled.values()][0].ms, 5000);
    await f.poll();
    assert.equal(f.states.at(-1).online, false);
    assert.equal(f.states.at(-1).requiresUserKey, true, 'an outage must not forget the visitor-key mode');
    await f.poll();
    assert.equal(f.states.at(-1).online, true);
  } finally { f.stop(); }
});

test('hidden tabs abort their health probe and ignore late results, then reconnect on visibility', async () => {
  const pending = [];
  const f = fixture((signal) => new Promise((resolve) => pending.push({ signal, resolve })));
  try {
    f.documentObject.visibilityState = 'hidden';
    f.documentObject.dispatchEvent(new Event('visibilitychange'));
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(f.scheduled.size, 0);
    f.documentObject.visibilityState = 'visible';
    f.documentObject.dispatchEvent(new Event('visibilitychange'));
    assert.equal(pending.length, 2);
    pending[1].resolve({ ok: true, hasNvidiaKey: true });
    await settle();
    pending[0].resolve({ ok: false });
    await settle();
    assert.equal(f.states.length, 1);
    assert.equal(f.states[0].online, true);
  } finally { f.stop(); }
});

test('browser offline/online events update immediately and cleanup stops future polling', async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return { ok: true, hasNvidiaKey: true }; });
  await settle();
  f.windowObject.navigator.onLine = false;
  f.windowObject.dispatchEvent(new Event('offline'));
  assert.equal(f.states.at(-1).online, false);
  assert.equal(f.scheduled.size, 0);
  f.windowObject.navigator.onLine = true;
  f.windowObject.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(requests, 2);
  assert.equal(f.states.at(-1).online, true);
  f.stop();
  f.windowObject.dispatchEvent(new Event('online'));
  f.documentObject.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(requests, 2);
  assert.equal(f.scheduled.size, 0);
});
