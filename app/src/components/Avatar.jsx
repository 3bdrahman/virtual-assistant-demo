/**
 * 3D Avatar component — renders the Ready Player Me GLB model
 * and drives lip-sync blendshapes from the AudioLipSync service.
 */

import { useRef, useEffect, useState, useMemo } from 'react';
import { LoopOnce } from 'three';
import { useAnimations } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { SpringDamper } from '../utils/springDamper';
import { applyVisemeWeights, prepareAvatarClips } from '../utils/avatarAnimation';

const BLINK_ATTACK_TAU = 0.020;
const BLINK_RELEASE_TAU = 0.110;
const HEAD_TRACK_TAU = 0.12;

export function Avatar({ audioLipSync, model, idleAnimation, greetingAnimation, ...props }) {
  const { nodes, materials } = model;
  const group = useRef();

  const clips = useMemo(
    () => prepareAvatarClips(idleAnimation, greetingAnimation),
    [idleAnimation, greetingAnimation],
  );
  const { actions, mixer } = useAnimations(clips, group);

  useEffect(() => {
    const greeting = actions.Greeting;
    const idle = actions.Idle;
    const startIdle = () => {
      idle?.reset().fadeIn(0.5).play();
      greeting?.fadeOut(0.5);
    };
    const onFinished = ({ action }) => {
      if (action === greeting) startIdle();
    };
    mixer.addEventListener('finished', onFinished);
    if (greeting) {
      greeting.setLoop(LoopOnce, 1);
      greeting.clampWhenFinished = true;
      greeting.reset().fadeIn(0.5).play();
    } else {
      startIdle();
    }
    return () => {
      mixer.removeEventListener('finished', onFinished);
      greeting?.stop();
      idle?.stop();
    };
  }, [actions, mixer]);

  const [blink, setBlink] = useState(0);
  const [springDamperMap] = useState(() => new Map());

  // Random blink interval
  useEffect(() => {
    let blinkTimer;
    let releaseTimer;
    const nextBlink = () => {
      setBlink(1);
      releaseTimer = setTimeout(() => setBlink(0), 150);
      blinkTimer = setTimeout(nextBlink, Math.random() * 4000 + 2000);
    };
    blinkTimer = setTimeout(nextBlink, 2000);
    return () => {
      clearTimeout(blinkTimer);
      clearTimeout(releaseTimer);
    };
  }, []);

  // Drive lip-sync blendshapes every frame
  useFrame((state, delta) => {
    if (!audioLipSync || !nodes.Wolf3D_Head) return;

    const headDict = nodes.Wolf3D_Head.morphTargetDictionary;
    const headInfluences = nodes.Wolf3D_Head.morphTargetInfluences;
    const teethInfluences = nodes.Wolf3D_Teeth?.morphTargetInfluences;
    if (!headDict || !headInfluences) return;

    const dt = Math.max(Math.min(Number.isFinite(delta) ? delta : 0.016, 0.1), 0);
    const weights = audioLipSync.visemeWeights || {};
    // AudioLipSync already smooths these weights. Bind them to the model's
    // actual shapes rather than translating them to absent ARKit targets.
    for (const mesh of [nodes.Wolf3D_Head, nodes.Wolf3D_Teeth, nodes.EyeLeft, nodes.EyeRight]) {
      applyVisemeWeights(mesh, weights);
    }

    // Handle eye blinks with SpringDamper
    const blinkTarget = blink;
    const blinkIdxL = headDict['eyeBlinkLeft'] ?? headDict['eyesClosed'];
    const blinkIdxR = headDict['eyeBlinkRight'] ?? headDict['eyesClosed'];
    if (blinkIdxL !== undefined) {
      const cur = headInfluences[blinkIdxL] || 0;
      let blinkDamperL = springDamperMap.get('blinkLeft');
      if (!blinkDamperL) {
        blinkDamperL = new SpringDamper(cur, blinkTarget > cur ? BLINK_ATTACK_TAU : BLINK_RELEASE_TAU, 'blink');
        springDamperMap.set('blinkLeft', blinkDamperL);
      } else {
        // Update parameters based on whether we're opening or closing eyes
        blinkDamperL.updateParameters(blinkTarget > cur ? BLINK_ATTACK_TAU : BLINK_RELEASE_TAU, 'blink');
      }
      headInfluences[blinkIdxL] = blinkDamperL.update(blinkTarget, dt);
    }
    if (blinkIdxR !== undefined) {
      const cur = headInfluences[blinkIdxR] || 0;
      let blinkDamperR = springDamperMap.get('blinkRight');
      if (!blinkDamperR) {
        blinkDamperR = new SpringDamper(cur, blinkTarget > cur ? BLINK_ATTACK_TAU : BLINK_RELEASE_TAU, 'blink');
        springDamperMap.set('blinkRight', blinkDamperR);
      } else {
        // Update parameters based on whether we're opening or closing eyes
        blinkDamperR.updateParameters(blinkTarget > cur ? BLINK_ATTACK_TAU : BLINK_RELEASE_TAU, 'blink');
      }
      headInfluences[blinkIdxR] = blinkDamperR.update(blinkTarget, dt);
    }

    // Apply clamping
    for (let i = 0; i < headInfluences.length; i++) {
      headInfluences[i] = Math.max(0, Math.min(1, headInfluences[i]));
    }
    if (teethInfluences) {
      for (let i = 0; i < teethInfluences.length; i++) {
        teethInfluences[i] = Math.max(0, Math.min(1, teethInfluences[i]));
      }
    }

    // Head tracking with SpringDamper
    if (nodes.Head) {
      const targetX = (state.pointer.x * Math.PI) / 4;
      const targetY = (state.pointer.y * Math.PI) / 6;

      let headYawDamper = springDamperMap.get('headYaw');
      if (!headYawDamper) {
        headYawDamper = new SpringDamper(nodes.Head.rotation.y, HEAD_TRACK_TAU, 'headTrack');
        springDamperMap.set('headYaw', headYawDamper);
      } else {
        headYawDamper.updateParameters(HEAD_TRACK_TAU, 'headTrack');
      }
      nodes.Head.rotation.y = headYawDamper.update(targetX * 0.5, dt);

      let headPitchDamper = springDamperMap.get('headPitch');
      if (!headPitchDamper) {
        headPitchDamper = new SpringDamper(nodes.Head.rotation.x, HEAD_TRACK_TAU, 'headTrack');
        springDamperMap.set('headPitch', headPitchDamper);
      } else {
        headPitchDamper.updateParameters(HEAD_TRACK_TAU, 'headTrack');
      }
      nodes.Head.rotation.x = headPitchDamper.update(-targetY * 0.5, dt);

      if (nodes.Neck) {
        let neckYawDamper = springDamperMap.get('neckYaw');
        if (!neckYawDamper) {
          neckYawDamper = new SpringDamper(nodes.Neck.rotation.y, HEAD_TRACK_TAU, 'headTrack');
          springDamperMap.set('neckYaw', neckYawDamper);
        } else {
          neckYawDamper.updateParameters(HEAD_TRACK_TAU, 'headTrack');
        }
        nodes.Neck.rotation.y = neckYawDamper.update(targetX * 0.3, dt);

        let neckPitchDamper = springDamperMap.get('neckPitch');
        if (!neckPitchDamper) {
          neckPitchDamper = new SpringDamper(nodes.Neck.rotation.x, HEAD_TRACK_TAU, 'headTrack');
          springDamperMap.set('neckPitch', neckPitchDamper);
        } else {
          neckPitchDamper.updateParameters(HEAD_TRACK_TAU, 'headTrack');
        }
        nodes.Neck.rotation.x = neckPitchDamper.update(-targetY * 0.3, dt);
      }

      if (nodes.Spine2) {
        let spineYawDamper = springDamperMap.get('spineYaw');
        if (!spineYawDamper) {
          spineYawDamper = new SpringDamper(nodes.Spine2.rotation.y, HEAD_TRACK_TAU, 'headTrack');
          springDamperMap.set('spineYaw', spineYawDamper);
        } else {
          spineYawDamper.updateParameters(HEAD_TRACK_TAU, 'headTrack');
        }
        nodes.Spine2.rotation.y = spineYawDamper.update(targetX * 0.2, dt);

        let spinePitchDamper = springDamperMap.get('spinePitch');
        if (!spinePitchDamper) {
          spinePitchDamper = new SpringDamper(nodes.Spine2.rotation.x, HEAD_TRACK_TAU, 'headTrack');
          springDamperMap.set('spinePitch', spinePitchDamper);
        } else {
          spinePitchDamper.updateParameters(HEAD_TRACK_TAU, 'headTrack');
        }
        nodes.Spine2.rotation.x = spinePitchDamper.update(-targetY * 0.2, dt);
      }
    }
  });

  return (
    <group {...props} dispose={null} ref={group}>
      <primitive object={nodes.Hips} />

      {nodes.Wolf3D_Body && (
        <skinnedMesh
          geometry={nodes.Wolf3D_Body.geometry}
          material={materials.Wolf3D_Body}
          skeleton={nodes.Wolf3D_Body.skeleton}
        />
      )}

      {nodes.Wolf3D_Outfit_Bottom && (
        <skinnedMesh
          geometry={nodes.Wolf3D_Outfit_Bottom.geometry}
          material={materials.Wolf3D_Outfit_Bottom}
          skeleton={nodes.Wolf3D_Outfit_Bottom.skeleton}
        />
      )}

      {nodes.Wolf3D_Outfit_Footwear && (
        <skinnedMesh
          geometry={nodes.Wolf3D_Outfit_Footwear.geometry}
          material={materials.Wolf3D_Outfit_Footwear}
          skeleton={nodes.Wolf3D_Outfit_Footwear.skeleton}
        />
      )}

      {nodes.Wolf3D_Outfit_Top && (
        <skinnedMesh
          geometry={nodes.Wolf3D_Outfit_Top.geometry}
          material={materials.Wolf3D_Outfit_Top}
          skeleton={nodes.Wolf3D_Outfit_Top.skeleton}
        />
      )}

      {nodes.Wolf3D_Outfit_Body && (
        <skinnedMesh
          geometry={nodes.Wolf3D_Outfit_Body.geometry}
          material={materials.Wolf3D_Outfit_Body}
          skeleton={nodes.Wolf3D_Outfit_Body.skeleton}
        />
      )}

      {nodes.Wolf3D_Hair && (
        <skinnedMesh
          geometry={nodes.Wolf3D_Hair.geometry}
          material={materials.Wolf3D_Hair}
          skeleton={nodes.Wolf3D_Hair.skeleton}
        />
      )}

      {nodes.EyeLeft && (
        <skinnedMesh
          name="EyeLeft"
          geometry={nodes.EyeLeft.geometry}
          material={materials.Wolf3D_Eye}
          skeleton={nodes.EyeLeft.skeleton}
          morphTargetDictionary={nodes.EyeLeft.morphTargetDictionary}
          morphTargetInfluences={nodes.EyeLeft.morphTargetInfluences}
        />
      )}

      {nodes.EyeRight && (
        <skinnedMesh
          name="EyeRight"
          geometry={nodes.EyeRight.geometry}
          material={materials.Wolf3D_Eye}
          skeleton={nodes.EyeRight.skeleton}
          morphTargetDictionary={nodes.EyeRight.morphTargetDictionary}
          morphTargetInfluences={nodes.EyeRight.morphTargetInfluences}
        />
      )}

      {nodes.Wolf3D_Head && (
        <skinnedMesh
          name="Wolf3D_Head"
          geometry={nodes.Wolf3D_Head.geometry}
          material={materials.Wolf3D_Skin}
          skeleton={nodes.Wolf3D_Head.skeleton}
          morphTargetDictionary={nodes.Wolf3D_Head.morphTargetDictionary}
          morphTargetInfluences={nodes.Wolf3D_Head.morphTargetInfluences}
        />
      )}

      {nodes.Wolf3D_Teeth && (
        <skinnedMesh
          name="Wolf3D_Teeth"
          geometry={nodes.Wolf3D_Teeth.geometry}
          material={materials.Wolf3D_Teeth}
          skeleton={nodes.Wolf3D_Teeth.skeleton}
          morphTargetDictionary={nodes.Wolf3D_Teeth.morphTargetDictionary}
          morphTargetInfluences={nodes.Wolf3D_Teeth.morphTargetInfluences}
        />
      )}
    </group>
  );
}
