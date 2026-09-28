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

test('WebGL detection tries legacy context and releases probe contexts', () => {
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
        return type === 'experimental-webgl' ? context : null;
      },
    }),
  }), true);
  assert.deepEqual(calls, ['webgl2', 'webgl', 'experimental-webgl']);
  assert.equal(released, true);
});
