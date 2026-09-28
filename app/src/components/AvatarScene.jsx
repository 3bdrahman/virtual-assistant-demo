import { useFBX, useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Experience } from './Experience';

export default function AvatarScene({ audioLipSync, onReady }) {
  // Load at the DOM boundary so missing assets are caught before the 3D renderer
  // reports them as global errors. App's Suspense and error fallback stay usable.
  const model = useGLTF(`${import.meta.env.BASE_URL}models/64bb1d39ab757f1e75aaa1aa.glb`);
  const idle = useFBX(`${import.meta.env.BASE_URL}animations/Idle.fbx`);
  const greeting = useFBX(`${import.meta.env.BASE_URL}animations/Standing Greeting.fbx`);
  return (
    <Canvas camera={{ position: [-0.5, 0.1, 8], fov: 38 }} gl={{ antialias: true, alpha: true }} onCreated={onReady}>
      <Experience audioLipSync={audioLipSync} model={model} idleAnimation={idle.animations} greetingAnimation={greeting.animations} />
    </Canvas>
  );
}
