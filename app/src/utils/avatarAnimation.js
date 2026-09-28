// The shipped avatar exposes Oculus visemes directly on its facial meshes.
export function applyVisemeWeights(mesh, weights) {
  if (!mesh?.morphTargetDictionary || !mesh.morphTargetInfluences) return;
  for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
    if (!name.startsWith('viseme_')) continue;
    const value = weights[name];
    mesh.morphTargetInfluences[index] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }
}

export function prepareAvatarClips(idleAnimation, greetingAnimation) {
  return [[idleAnimation?.[0], 'Idle'], [greetingAnimation?.[0], 'Greeting']]
    .filter(([clip]) => clip)
    .map(([source, name]) => {
      // Loader results are shared. Prepare private clips before useAnimations
      // indexes their names, and memoize the returned array at the component.
      const clip = source.clone();
      clip.name = name;
      clip.tracks = clip.tracks.filter((track) => {
        track.name = track.name.replace(/^Armature[/.]/i, '').replace(/^mixamorig:?/i, '').replace(/^\./, '');
        if (track.name.endsWith('.scale')) return false;
        if (track.name.endsWith('.position') && track.name !== 'Hips.position') return false;
        const [node, property] = track.name.split('.');
        return Boolean(node?.trim() && property?.trim());
      });
      return clip;
    });
}
