// Own one health probe and one timer for the visible page. A failed refresh
// gets a quick confirmation before disabling an already working connection.
export function watchServiceHealth({ probe, onChange, documentObject = globalThis.document,
  windowObject = globalThis.window, schedule = setTimeout, clear = clearTimeout }) {
  let active = true;
  let timer;
  let pending;
  let last;
  let failures = 0;
  const hidden = () => documentObject?.visibilityState === 'hidden';
  const offline = () => windowObject?.navigator?.onLine === false;
  const cancel = () => { clear(timer); timer = undefined; pending?.abort(); pending = null; };
  const publish = (health) => {
    const online = health.ok === true;
    const next = { checked: true, online, hasNvidiaKey: online ? health.hasNvidiaKey === true : last?.hasNvidiaKey || false,
      requiresUserKey: online ? health.requiresUserKey === true : last?.requiresUserKey || false };
    if (!last || Object.keys(next).some((key) => next[key] !== last[key])) {
      last = next;
      onChange(next);
    }
  };
  const refresh = async () => {
    cancel();
    if (!active || hidden() || offline()) return;
    const controller = new AbortController();
    pending = controller;
    let health;
    try { health = await probe(controller.signal); }
    catch { health = { ok: false }; }
    if (!active || controller.signal.aborted || pending !== controller) return;
    pending = null;
    failures = health?.ok === true ? 0 : failures + 1;
    if (health?.ok === true || !last?.online || failures >= 2) publish(health || {});
    const ready = health?.ok === true && (health.hasNvidiaKey === true || health.requiresUserKey === true);
    timer = schedule(refresh, ready ? 30_000 : 5000);
  };
  const onVisibility = () => { if (hidden()) cancel(); else refresh(); };
  const onOffline = () => { cancel(); failures = 2; publish({ ok: false }); };
  documentObject?.addEventListener('visibilitychange', onVisibility);
  windowObject?.addEventListener('online', refresh);
  windowObject?.addEventListener('offline', onOffline);
  if (offline()) onOffline();
  else refresh();
  return () => {
    active = false;
    cancel();
    documentObject?.removeEventListener('visibilitychange', onVisibility);
    windowObject?.removeEventListener('online', refresh);
    windowObject?.removeEventListener('offline', onOffline);
  };
}
