import { memo } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { Experience } from './Experience';

const modelPath = `${import.meta.env.BASE_URL}models/64bb1d39ab757f1e75aaa1aa.glb`;
const animationPaths = [`${import.meta.env.BASE_URL}animations/Idle.fbx`, `${import.meta.env.BASE_URL}animations/Standing Greeting.fbx`];

// Start all three requests when the lazy scene module loads. Consecutive
// suspending hooks otherwise serialize the model and animation downloads.
useLoader.preload(GLTFLoader, modelPath);
useLoader.preload(FBXLoader, animationPaths);

function AvatarScene({ audioLipSync, onReady }) {
  // Load at the DOM boundary so missing assets are caught before the 3D renderer
  // reports them as global errors. App's Suspense and error fallback stay usable.
  const model = useLoader(GLTFLoader, modelPath);
  const [idle, greeting] = useLoader(FBXLoader, animationPaths);
  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [-0.5, 0.1, 8], fov: 38 }} gl={{ antialias: true, alpha: true }} onCreated={onReady}>
      <Experience audioLipSync={audioLipSync} model={model} idleAnimation={idle.animations} greetingAnimation={greeting.animations} />
    </Canvas>
  );
}

export default memo(AvatarScene);
