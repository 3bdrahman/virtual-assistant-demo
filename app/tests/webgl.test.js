import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseWebGL } from '../src/utils/webgl.js';

test('WebGL detection handles missing and blocked contexts', () => {
  assert.equal(canUseWebGL(null), false);
  assert.equal(canUseWebGL({ createElement: () => ({ getContext: () => null }) }), false);
  assert.equal(canUseWebGL({ createElement: () => ({ getContext: () => { throw new Error('blocked'); } }) }), false);
});

test('WebGL detection recognizes a usable context', () => {
  const context = {};
  assert.equal(canUseWebGL({ createElement: () => ({ getContext: () => context }) }), true);
});

test('WebGL detection releases its WebGL 2 probe context', () => {
  const calls = [];
  let released = false;
  const context = {
    getExtension: (name) => {
      assert.equal(name, 'WEBGL_lose_context');
      return { loseContext: () => { released = true; } };
    },
  };

  assert.equal(canUseWebGL({
    createElement: () => ({
      getContext: (type) => {
        calls.push(type);
        return type === 'webgl2' ? context : null;
      },
    }),
  }), true);
  assert.deepEqual(calls, ['webgl2']);
  assert.equal(released, true);
});

test('WebGL 1-only browsers get text controls instead of a renderer initialization failure', () => {
  assert.equal(canUseWebGL({ createElement: () => ({ getContext: (type) => type === 'webgl2' ? null : {} }) }), false);
});
