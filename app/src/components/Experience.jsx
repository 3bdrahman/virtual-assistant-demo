/**
 * Three.js scene setup — avatar, lighting, environment, background.
 */

import { Avatar } from './Avatar';

export function Experience({ audioLipSync }) {
  return (
    <>
      <ambientLight intensity={1.5} />
      <directionalLight position={[4, 6, 8]} intensity={2.2} />
      <directionalLight position={[-5, 2, 3]} intensity={1.2} color="#a99aff" />
      <Avatar
        audioLipSync={audioLipSync}
        position={[0, -3.5, 5]}
        scale={2}
      />
    </>
  );
}
