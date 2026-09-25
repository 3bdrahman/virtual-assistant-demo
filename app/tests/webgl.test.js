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
