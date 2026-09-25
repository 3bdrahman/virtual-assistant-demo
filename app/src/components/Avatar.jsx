/**
 * 3D Avatar component — renders the Ready Player Me GLB model
 * and drives lip-sync blendshapes from the AudioLipSync service.
 */

import { useRef, useEffect, useState } from 'react';
import { useAnimations, useFBX, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { SpringDamper } from '../utils/springDamper';

// Oculus Viseme → ARKit Morph Target Mapping for RPM avatars
// Optimized for natural mouth movements based on phonetic articulation
const ARKIT_MAP = {
  // Vowels - jaw opening, lip rounding/spreading
  viseme_aa: { 
    jawOpen: 0.85, jawForward: 0.45, mouthOpen: 0.85, 
    mouthLowerDownLeft: 0.40, mouthLowerDownRight: 0.40, 
    cheekPuffLeft: 0.10, cheekPuffRight: 0.10,
    lipCornerDepressorLeft: 0.15, lipCornerDepressorRight: 0.15
  },
  viseme_E:  { 
    jawOpen: 0.55, jawForward: 0.30, mouthOpen: 0.50, 
    mouthLowerDownLeft: 0.30, mouthLowerDownRight: 0.30, 
    lipStretchLeft: 0.45, lipStretchRight: 0.45,
    lipCornerPullerLeft: 0.35, lipCornerPullerRight: 0.35
  },
  viseme_I:  { 
    jawOpen: 0.20, mouthOpen: 0.25, 
    mouthSmileLeft: 0.55, mouthSmileRight: 0.55, 
    lipStretchLeft: 0.55, lipStretchRight: 0.55,
    lipCornerPullerLeft: 0.60, lipCornerPullerRight: 0.60,
    mouthUpperUpLeft: 0.25, mouthUpperUpRight: 0.25
  },
  viseme_O:  { 
    jawOpen: 0.60, jawForward: 0.35, mouthOpen: 0.55, 
    mouthFunnel: 0.85, mouthPucker: 0.70,
    lipCornerPullerLeft: -0.15, lipCornerPullerRight: -0.15,
    lipRollUpper: 0.15, lipRollLower: 0.10
  },
  viseme_U:  { 
    jawOpen: 0.20, mouthOpen: 0.30, 
    mouthPucker: 0.85, mouthFunnel: 0.35, 
    lipRollUpper: 0.30, lipRollLower: 0.20,
    lipCornerPullerLeft: -0.25, lipCornerPullerRight: -0.25
  },
  
  // Bilabial plosives - complete closure with pressure buildup
  viseme_PP: { 
    jawOpen: 0.03, mouthClose: 0.95, 
    lipPressLeft: 0.85, lipPressRight: 0.85, 
    cheekPuffLeft: 0.40, cheekPuffRight: 0.40,
    lipRollUpper: 0.10, lipRollLower: 0.10
  },
  
  // Labiodental fricatives - lower lip to upper teeth
  viseme_FF: { 
    lipRollUpper: 0.55, lipRollLower: 0.40, 
    jawOpen: 0.12, mouthOpen: 0.18,
    lipStretchLeft: 0.15, lipStretchRight: 0.15
  },
  
  // Dental fricatives - tongue between teeth
  viseme_TH: { 
    jawOpen: 0.28, mouthFunnel: 0.15, mouthOpen: 0.32, 
    tongueOut: 0.35, tongueTipUp: 0.20,
    lipRollUpper: 0.10, lipRollLower: 0.05
  },
  
  // Alveolar plosives - tongue tip to alveolar ridge
  viseme_DD: { 
    jawOpen: 0.32, mouthOpen: 0.40, 
    tongueOut: 0.25, tongueTipUp: 0.45,
    lipStretchLeft: 0.10, lipStretchRight: 0.10
  },
  
  // Velar plosives - tongue back to soft palate
  viseme_kk: { 
    jawOpen: 0.42, mouthOpen: 0.50, 
    tongueOut: 0.15, tongueTipUp: 0.10, tongueBackUp: 0.55,
    lipStretchLeft: 0.05, lipStretchRight: 0.05
  },
  
  // Postalveolar affricate/fricative - tongue blade behind alveolar
  viseme_CH: { 
    mouthFunnel: 0.55, jawOpen: 0.28, mouthOpen: 0.40, 
    tongueOut: 0.30, tongueTipUp: 0.35,
    lipCornerPullerLeft: 0.15, lipCornerPullerRight: 0.15
  },
  
  // Sibilants - tongue groove, high-velocity air
  viseme_SS: { 
    mouthSmileLeft: 0.50, mouthSmileRight: 0.50, 
    mouthUpperUpLeft: 0.35, mouthUpperUpRight: 0.35, 
    jawOpen: 0.12, teethShow: 0.70,
    lipStretchLeft: 0.30, lipStretchRight: 0.30,
    tongueTipUp: 0.30
  },
  
  // Alveolar nasal - tongue tip to alveolar, velum lowered
  viseme_nn: { 
    jawOpen: 0.22, mouthOpen: 0.28, 
    tongueOut: 0.35, tongueTipUp: 0.50,
    lipStretchLeft: 0.08, lipStretchRight: 0.08
  },
  
  // Rhotic - tongue bunching, F3 lowering
  viseme_RR: { 
    mouthPucker: 0.45, jawOpen: 0.32, mouthOpen: 0.35,
    tongueBackUp: 0.30, tongueTipUp: 0.15,
    lipCornerPullerLeft: 0.10, lipCornerPullerRight: 0.10
  },
  
  // Silence - relaxed neutral
  viseme_sil: { jawOpen: 0.04, mouthClose: 0.65, lipPressLeft: 0.10, lipPressRight: 0.10 },
};

// Viseme-specific morph damping for natural motion
// Faster for consonants (articulator precision), slower for vowels (sustained)
const VISeme_MORPH_TAU = {
  viseme_sil:  0.008,
  viseme_PP:   0.004,  // Fast bilabial closure
  viseme_FF:   0.005,  // Labiodental
  viseme_TH:   0.005,  // Dental
  viseme_DD:   0.004,  // Alveolar plosive
  viseme_kk:   0.0035, // Velar plosive - fastest
  viseme_CH:   0.0045, // Postalveolar
  viseme_SS:   0.006,  // Sibilant - sustained
  viseme_nn:   0.005,  // Nasal
  viseme_RR:   0.007,  // Rhotic
  viseme_aa:   0.009,  // Open vowel - slower
  viseme_E:    0.008,  // Mid vowel
  viseme_I:    0.0075, // Close vowel
  viseme_O:    0.009,  // Rounded vowel
  viseme_U:    0.010,  // Close rounded - slowest
};

const BASE_MORPH_TAU = 0.005;
const BLINK_ATTACK_TAU = 0.020;
const BLINK_RELEASE_TAU = 0.110;
const HEAD_TRACK_TAU = 0.12;

export function Avatar({ audioLipSync, ...props }) {
  const { nodes, materials } = useGLTF('/models/64bb1d39ab757f1e75aaa1aa.glb');
  const group = useRef();

  // Load animations and bind tracks cleanly to Ready Player Me skeleton
  const { animations: idleAnimation } = useFBX('/animations/Idle.fbx');
  const { animations: greetingAnimation } = useFBX('/animations/Standing Greeting.fbx');

  useEffect(() => {
    const processTracks = (clip, clipName) => {
      if (!clip || !clip.tracks) return;
      clip.name = clipName;
      const validTracks = [];
      for (const t of clip.tracks) {
        // Remove scale & non-Hips position tracks to prevent mesh stretching glitches
        if (t.name.endsWith('.position') && !t.name.toLowerCase().includes('hips')) continue;
        if (t.name.endsWith('.scale')) continue;

        // Clean Mixamo / Armature prefix so track targets GLB bone nodes directly
        let cleanName = t.name
          .replace(/^Armature[/.]/i, '')
          .replace(/^mixamorig:?/i, '');
        if (cleanName.startsWith('.')) cleanName = cleanName.slice(1);

        // Ensure track is in valid Three.js PropertyBinding format: "NodeName.propertyName"
        const parts = cleanName.split('.');
        if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
          t.name = cleanName;
          validTracks.push(t);
        }
      }
      clip.tracks = validTracks;
    };

    if (idleAnimation?.[0]) processTracks(idleAnimation[0], 'Idle');
    if (greetingAnimation?.[0]) processTracks(greetingAnimation[0], 'Greeting');
  }, [idleAnimation, greetingAnimation]);

  const [animation, setAnimation] = useState('Greeting');
  const { actions } = useAnimations(
    [idleAnimation?.[0], greetingAnimation?.[0]].filter(Boolean),
    group
  );

  // Switch to Idle after 3 seconds
  useEffect(() => {
    if (animation === 'Greeting') {
      const timer = setTimeout(() => setAnimation('Idle'), 3000);
      return () => clearTimeout(timer);
    }
  }, [animation]);

  // Play current animation
  useEffect(() => {
    actions[animation]?.reset().fadeIn(0.5).play();
    return () => actions[animation]?.fadeOut(0.5);
  }, [animation, actions]);

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
    const teethDict = nodes.Wolf3D_Teeth.morphTargetDictionary;
    const headInfluences = nodes.Wolf3D_Head.morphTargetInfluences;
    const teethInfluences = nodes.Wolf3D_Teeth.morphTargetInfluences;

    if (!headDict || !headInfluences) return;

    const dt = Math.max(Math.min(Number.isFinite(delta) ? delta : 0.016, 0.1), 0);

    const weights = audioLipSync.visemeWeights || {};
    const arkitTargets = {};

    // Determine primary viseme for adaptive damping
    let primaryViseme = 'viseme_sil';
    let maxWeight = 0;
    for (const name in weights) {
      if (weights[name] > maxWeight) {
        maxWeight = weights[name];
        primaryViseme = name;
      }
    }
    const morphTau = VISeme_MORPH_TAU[primaryViseme] || BASE_MORPH_TAU;

    for (const name in weights) {
      const target = weights[name] || 0;
      const arkitMapping = ARKIT_MAP[name];
      if (!arkitMapping || target <= 0.001) continue;
      for (const [arkitKey, multiplier] of Object.entries(arkitMapping)) {
        // Accumulate contributions from all visemes, then clamp ONCE per morph
        // target below (per-viseme clamping would under-weight multi-viseme
        // morph targets like jawOpen that several visemes map to).
        arkitTargets[arkitKey] = (arkitTargets[arkitKey] || 0) + target * multiplier;
      }
    }
    for (const k in arkitTargets) arkitTargets[k] = Math.max(0, Math.min(1, arkitTargets[k]));

    for (const arkitKey in headDict) {
      const target = arkitTargets[arkitKey] || 0;
      // Get or create SpringDamper for this morph target
      let damper = springDamperMap.get(arkitKey);
      if (!damper) {
        // Initialize with current position (we'll read it below)
        const current = headInfluences[headDict[arkitKey]] || 0;
        damper = new SpringDamper(current, morphTau, primaryViseme);
        springDamperMap.set(arkitKey, damper);
      } else {
        // Update damper parameters based on current morphTau and viseme
        damper.updateParameters(morphTau, primaryViseme);
      }
      const current = headInfluences[headDict[arkitKey]] || 0;
      if (target === 0 && current < 0.001) continue;
      
      const newPosition = damper.update(target, dt);
      headInfluences[headDict[arkitKey]] = newPosition;
      if (teethDict && teethDict[arkitKey] !== undefined) {
        const tcurrent = teethInfluences[teethDict[arkitKey]] || 0;
        let teethDamper = springDamperMap.get(arkitKey + '_teeth');
        if (!teethDamper) {
          teethDamper = new SpringDamper(tcurrent, morphTau, primaryViseme);
          springDamperMap.set(arkitKey + '_teeth', teethDamper);
        } else {
          teethDamper.updateParameters(morphTau, primaryViseme);
        }
        const tnewPosition = teethDamper.update(target, dt);
        teethInfluences[teethDict[arkitKey]] = tnewPosition;
      }
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

useGLTF.preload('/models/64bb1d39ab757f1e75aaa1aa.glb');
