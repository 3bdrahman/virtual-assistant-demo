import { Suspense } from 'react';
import { Html } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Experience } from './Experience';

export default function AvatarScene({ audioLipSync }) {
  return (
    <Canvas camera={{ position: [-0.5, 0.1, 8], fov: 38 }} gl={{ antialias: true, alpha: true }}>
      <Suspense fallback={<Html center><div className="scene-loading-inline" role="status">Loading avatar…</div></Html>}>
        <Experience audioLipSync={audioLipSync} />
      </Suspense>
    </Canvas>
  );
}
