// Strengths tuned to this model: O/aa have the largest vertex displacement;
// closed-lip and teeth/lip consonants need a clearer, less volume-driven pose.
const STRENGTH = {
  viseme_PP: 1, viseme_FF: 0.92, viseme_TH: 0.85,
  viseme_DD: 0.65, viseme_kk: 0.55, viseme_CH: 0.8,
  viseme_SS: 0.72, viseme_nn: 0.65, viseme_RR: 0.68,
  viseme_aa: 0.76, viseme_E: 0.72, viseme_I: 0.7,
  viseme_O: 0.68, viseme_U: 0.86,
};

export function articulationTargets(timeline, time, rms) {
  const index = timeline.findIndex((unit) => time >= unit.start && time < unit.end);
  if (index < 0) return { viseme: 'viseme_sil', intensity: 0, weights: { viseme_sil: 1 } };
  const current = timeline[index];
  const next = timeline[index + 1];
  const intensity = Math.min(1, Math.sqrt(Math.max(0, rms) / 0.12));
  const weights = {};
  let blend = 0;
  const contiguous = next && next.start - current.end < 0.005;
  // P/B/M is a held seal. Do not open the lips early by blending a vowel into it.
  if (contiguous && current.viseme !== 'viseme_PP' && next.viseme !== 'viseme_sil') {
    const span = Math.min(next.viseme === 'viseme_PP' ? 0.045 : 0.035, (current.end - current.start) * 0.45);
    const fraction = Math.max(0, Math.min(1, (time - (current.end - span)) / span));
    blend = fraction * fraction * (3 - 2 * fraction);
  }
  const add = (viseme, amount) => {
    if (!amount || viseme === 'viseme_sil') return;
    let level = intensity;
    if (viseme === 'viseme_PP') level = 1;
    else if (rms < 0.0025) return;
    else if (['viseme_FF', 'viseme_TH', 'viseme_SS', 'viseme_CH'].includes(viseme)) level = Math.max(level, 0.55);
    weights[viseme] = (weights[viseme] || 0) + amount * (STRENGTH[viseme] || 0.65) * level;
  };
  add(current.viseme, 1 - blend);
  if (next) add(next.viseme, blend);
  if (!Object.keys(weights).length) weights.viseme_sil = 1;
  return { viseme: blend > 0.5 ? next.viseme : current.viseme, intensity, weights };
}
