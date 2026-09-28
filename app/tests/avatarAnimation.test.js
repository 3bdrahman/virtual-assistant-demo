import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { applyVisemeWeights, prepareAvatarClips } from '../src/utils/avatarAnimation.js';

const bytes = fs.readFileSync(new URL('../public/models/64bb1d39ab757f1e75aaa1aa.glb', import.meta.url));
const model = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());

test('speech drives the mouth shapes present in the shipped head and teeth asset', () => {
  for (const name of ['Wolf3D_Head', 'Wolf3D_Teeth']) {
    const asset = model.meshes.find((mesh) => mesh.name === name);
    const names = asset.extras.targetNames;
    const mesh = { morphTargetDictionary: Object.fromEntries(names.map((key, index) => [key, index])), morphTargetInfluences: [...asset.weights] };
    assert.ok(names.includes('viseme_aa'));
    assert.equal(names.includes('jawOpen'), false);
    applyVisemeWeights(mesh, { viseme_aa: 0.8, viseme_O: 0.2, viseme_sil: 0 });
    assert.equal(mesh.morphTargetInfluences[mesh.morphTargetDictionary.viseme_aa], 0.8, `${name} mouth must open`);
    assert.equal(mesh.morphTargetInfluences[mesh.morphTargetDictionary.viseme_O], 0.2);
    applyVisemeWeights(mesh, { viseme_sil: 1 });
    assert.equal(mesh.morphTargetInfluences[mesh.morphTargetDictionary.viseme_aa], 0, `${name} must close on stop`);
    assert.equal(mesh.morphTargetInfluences[mesh.morphTargetDictionary.viseme_sil], 1);
  }
});

test('mouth weights stay finite and leave unrelated expressions alone', () => {
  const mesh = { morphTargetDictionary: { viseme_aa: 0, viseme_O: 1, viseme_E: 2, eyeBlinkLeft: 3 }, morphTargetInfluences: [0, 0, 0, 0.4] };
  applyVisemeWeights(mesh, { viseme_aa: 2, viseme_O: -1, viseme_E: NaN });
  assert.deepEqual(mesh.morphTargetInfluences, [1, 0, 0, 0.4]);
  assert.doesNotThrow(() => applyVisemeWeights(undefined, {}));
});

test('real animation clips have stable distinct names before binding and preserve cached assets', () => {
  const load = (name) => {
    const buffer = fs.readFileSync(new URL(`../public/animations/${name}`, import.meta.url));
    return new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '').animations;
  };
  const idle = load('Idle.fbx');
  const greeting = load('Standing Greeting.fbx');
  const original = [idle[0], greeting[0]].map((clip) => ({ name: clip.name, tracks: clip.tracks.map((track) => track.name) }));
  const clips = prepareAvatarClips(idle, greeting);
  assert.deepEqual(clips.map((clip) => clip.name), ['Idle', 'Greeting']);
  assert.notEqual(clips[0], idle[0]);
  assert.notEqual(clips[1], greeting[0]);
  assert.ok(clips[0].duration > 16);
  assert.ok(clips[1].duration > 5);
  for (const clip of clips) {
    assert.ok(clip.tracks.length > 0);
    assert.ok(clip.tracks.every((track) => !track.name.endsWith('.scale')));
    assert.ok(clip.tracks.every((track) => !track.name.endsWith('.position') || track.name === 'Hips.position'));
  }
  assert.deepEqual([idle[0], greeting[0]].map((clip) => ({ name: clip.name, tracks: clip.tracks.map((track) => track.name) })), original);
});
