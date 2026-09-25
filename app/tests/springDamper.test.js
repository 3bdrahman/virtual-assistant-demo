import test from 'node:test';
import assert from 'node:assert/strict';
import { SpringDamper } from '../src/utils/springDamper.js';

test('viseme damping remains bounded and converges at a normal frame rate', () => {
  const damper = new SpringDamper(0, 0.005, 'viseme_aa');
  let value = 0;
  for (let frame = 0; frame < 120; frame++) {
    value = damper.update(1, 1 / 60);
    assert.ok(Number.isFinite(value), 'position stays finite');
    assert.ok(value >= 0 && value <= 1, `frame ${frame}: ${value}`);
  }
  assert.ok(value > 0.95, 'position converges to its target');
});

test('viseme damping returns toward silence after a target change', () => {
  const damper = new SpringDamper(0, 0.02, 'viseme_PP');
  for (let frame = 0; frame < 30; frame++) damper.update(1, 1 / 60);
  const beforeRelease = damper.position;
  for (let frame = 0; frame < 120; frame++) damper.update(0, 1 / 60);
  assert.ok(damper.position < beforeRelease);
  assert.ok(damper.position < 0.05);
});
