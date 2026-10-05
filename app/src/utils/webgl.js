export function canUseWebGL(documentObject = globalThis.document) {
  if (!documentObject?.createElement) return false;
  try {
    const canvas = documentObject.createElement('canvas');
    // The installed Three.js renderer requires WebGL 2. A WebGL 1 probe
    // would incorrectly enable a scene that cannot initialize.
    const context = canvas.getContext('webgl2');
    context?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return Boolean(context);
  } catch {
    return false;
  }
}
