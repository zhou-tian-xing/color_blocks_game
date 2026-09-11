/**
 * 本地记录持久化（localStorage）。
 * 同一台机器、同一个浏览器上，历史最高纪录会一直保留。
 */

const KEY = 'chromatic-acuity.v1';
const MAX_HISTORY = 40;

const emptyState = () => ({
  version: 1,
  best: null, // 中值 ΔE00 最低的一次
  history: [], // 最近若干次，新的在前
  settings: { sound: true },
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      version: 1,
      best: parsed.best || null,
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY) : [],
      settings: { sound: true, ...(parsed.settings || {}) },
    };
  } catch {
    return emptyState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false; // 隐私模式 / 配额满
  }
}

export function saveSettings(state, patch) {
  state.settings = { ...state.settings, ...patch };
  save(state);
  return state.settings;
}

/**
 * 写入一次成绩。中值 ΔE00 越低代表色觉鉴别力越好，因此取最小值作为纪录。
 * @returns {{ state: object, isRecord: boolean, prevBest: object|null }}
 */
export function submitResult(state, result) {
  const prevBest = state.best;
  const isRecord = !prevBest || result.median < prevBest.median;

  state.history.unshift(result);
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  if (isRecord) state.best = result;

  save(state);
  return { state, isRecord, prevBest };
}

export function clearAll() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return emptyState();
}
