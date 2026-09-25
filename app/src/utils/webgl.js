export function canUseWebGL(documentObject = globalThis.document) {
  if (!documentObject?.createElement) return false;
  try {
    const canvas = documentObject.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return Boolean(context);
  } catch {
    return false;
  }
}
