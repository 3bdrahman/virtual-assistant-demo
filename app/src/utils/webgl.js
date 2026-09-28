export function canUseWebGL(documentObject = globalThis.document) {
  if (!documentObject?.createElement) return false;
  try {
    const canvas = documentObject.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    context?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return Boolean(context);
  } catch {
    return false;
  }
}
