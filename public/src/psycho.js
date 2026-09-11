/**
 * 心理测量学引擎。
 *
 * 模型：被试在 N×N 阵列中作答，
 *   P(正确 | ΔE, 格数 m) = γ + (1 − γ − λ)·Φ( (ln ΔE − ln θ) / σ )
 * 其中 γ = 1/m 是"纯猜"的下限（格子越多越难蒙中），λ 为失误率（lapse），
 * θ 即我们要估计的"最小可鉴别 ΔE"（50% 检测阈），σ 为心理测量函数在对数轴上的陡度。
 *
 * 采用 (θ, σ) 二维网格上的**精确贝叶斯后验**：
 *   · 每一轮作答后按似然更新 → 后验自动收窄，直接对应"不确定度的减小"；
 *   · 下一轮的 ΔE 取"期望后验熵最小"的水平（信息量最大化），收敛远快于固定阶梯；
 *   · 结果报告后验中值与 68% / 90% 可信区间 —— 中值 ΔE 与误差范围。
 */

export const DE_MIN = 0.45; // 显示下限：8bit 色深已无法可靠表达更小的色差
export const DE_MAX = 45;

const NT = 220; // θ 网格
const NS = 24; // σ 网格
const SIG_MIN = 0.05;
const SIG_MAX = 0.9;
const LAPSE = 0.02; // 2% 失误率，避免似然出现 0/1 导致后验退化

const NCAND = 96; // 候选刺激强度数量

export const THETA = new Float64Array(NT);
export const SIGMA = new Float64Array(NS);
const THETA_LN = new Float64Array(NT);
const CAND = new Float64Array(NCAND);

const LN_MIN = Math.log(DE_MIN);
const LN_MAX = Math.log(DE_MAX);
const LN_SPAN = LN_MAX - LN_MIN;

for (let i = 0; i < NT; i++) {
  THETA_LN[i] = LN_MIN + (LN_SPAN * i) / (NT - 1);
  THETA[i] = Math.exp(THETA_LN[i]);
}
for (let j = 0; j < NS; j++) {
  SIGMA[j] = SIG_MIN + ((SIG_MAX - SIG_MIN) * j) / (NS - 1);
}
for (let c = 0; c < NCAND; c++) {
  CAND[c] = Math.exp(LN_MIN + (LN_SPAN * c) / (NCAND - 1));
}

const CELLS = NT * NS;

/* ─────────────────────────────── 数学工具 ─────────────────────────────── */

/** 标准正态 CDF（Zelen & Severo 近似，绝对误差 < 1e-7） */
export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const SQRT2 = Math.SQRT2;
export const erf = (x) => 2 * normCdf(x * SQRT2) - 1;

/** 指定检测正确率下的分位数（Φ⁻¹），用于把 θ(50%) 换算到其它正确率水平 */
export function probit(p) {
  // Acklam 有理逼近
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const Z75 = probit(0.75); // ≈ 0.6745

/* ─────────────────────────────── 日程 ─────────────────────────────── */

/**
 * 阵列日程：把 2×2 到 9×9 均匀铺在 total 轮里。
 * buildSchedule(21) → 2,2,3,3,3,4,4,4,5,5,6,6,6,7,7,7,8,8,8,9,9
 */
export function buildSchedule(total) {
  const n = Math.max(1, Math.floor(total) || 1);
  if (n === 1) return [9];
  return Array.from({ length: n }, (_, i) => 2 + Math.round((i / (n - 1)) * 7));
}

/* ─────────────────────────────── 后验 ─────────────────────────────── */

/** 均匀先验（θ 在 log 轴上均匀、σ 均匀，二者独立） */
export function createPosterior() {
  const post = new Float64Array(CELLS);
  post.fill(1 / CELLS);
  return post;
}

/** P(正确 | ΔE, 格数, θ, σ) */
export function pCorrect(de, cells, thetaLn, sigma) {
  const gamma = 1 / cells;
  const z = (Math.log(de) - thetaLn) / sigma;
  return gamma + (1 - gamma - LAPSE) * normCdf(z);
}

/** 用一轮结果更新后验（原地修改并归一化） */
export function updatePosterior(post, de, cells, correct) {
  const lde = Math.log(de);
  const gamma = 1 / cells;
  const spread = 1 - gamma - LAPSE;

  let sum = 0;
  for (let i = 0; i < NT; i++) {
    const dz = lde - THETA_LN[i];
    const row = i * NS;
    for (let j = 0; j < NS; j++) {
      const k = row + j;
      const p = gamma + spread * normCdf(dz / SIGMA[j]);
      const v = post[k] * (correct ? p : 1 - p);
      post[k] = v;
      sum += v;
    }
  }

  if (sum > 0 && Number.isFinite(sum)) {
    for (let k = 0; k < CELLS; k++) post[k] /= sum;
  } else {
    post.fill(1 / CELLS);
  }
  return post;
}

/* ─────────────────────── 刺激强度的自适应选取 ─────────────────────── */

const _pcs = new Float64Array(CELLS);

/**
 * 选取能把"θ 的期望后验熵"降得最多的刺激强度（贝叶斯信息最大化）。
 * 相比固定步长的阶梯法，它每一轮都直接朝"缩小不确定度"最快的方向走。
 *
 * @param {number} warmupMul 热身系数：前几轮故意放大 ΔE，让开局不至于劝退
 */
export function selectDeltaE(post, cells, warmupMul = 1) {
  const gamma = 1 / cells;
  const spread = 1 - gamma - LAPSE;

  let bestDE = CAND[0];
  let bestH = Infinity;

  for (let c = 0; c < NCAND; c++) {
    const de = CAND[c];
    const lde = Math.log(de);

    let pBar = 0;
    for (let i = 0; i < NT; i++) {
      const dz = lde - THETA_LN[i];
      const row = i * NS;
      for (let j = 0; j < NS; j++) {
        const k = row + j;
        const p = gamma + spread * normCdf(dz / SIGMA[j]);
        _pcs[k] = p;
        pBar += post[k] * p;
      }
    }

    const pWrong = 1 - pBar;
    if (pBar <= 1e-9 || pWrong <= 1e-9) continue;

    let hCorrect = 0;
    let hWrong = 0;
    for (let k = 0; k < CELLS; k++) {
      const pk = post[k];
      if (pk <= 0) continue;
      const a = (pk * _pcs[k]) / pBar;
      if (a > 1e-300) hCorrect -= a * Math.log(a);
      const b = (pk * (1 - _pcs[k])) / pWrong;
      if (b > 1e-300) hWrong -= b * Math.log(b);
    }

    const expected = pBar * hCorrect + pWrong * hWrong;
    if (expected < bestH - 1e-12) {
      bestH = expected;
      bestDE = de;
    }
  }

  return Math.min(DE_MAX, Math.max(DE_MIN, bestDE * warmupMul));
}

/* ─────────────────────────── 结果汇总与区间 ─────────────────────────── */

/**
 * 取加权分位数。
 * 若 values 已按升序排列（θ 相关的那几组天然如此），传 sorted=true 即可免去排序，
 * 一次遍历同时求出所有分位点 —— summarize 每轮都要跑，这里省掉的是主要开销。
 */
function quantiles(values, weights, probs, sorted) {
  const n = values.length;
  let order = null;

  if (!sorted) {
    order = new Array(n);
    for (let k = 0; k < n; k++) order[k] = k;
    order.sort((x, y) => values[x] - values[y]);
  }

  let total = 0;
  for (let k = 0; k < n; k++) total += weights[k];

  const out = new Array(probs.length).fill(NaN);
  if (!(total > 0)) return out;

  // 单次遍历要求目标累积量递增，所以按分位概率重排后再按原顺序写回结果
  const byProb = probs.map((_, i) => i).sort((a, b) => probs[a] - probs[b]);
  const targets = byProb.map((i) => probs[i] * total);

  let acc = 0;
  let idx = 0;
  for (let t = 0; t < n && idx < byProb.length; t++) {
    const k = sorted ? t : order[t];
    acc += weights[k];
    while (idx < byProb.length && acc >= targets[idx]) out[byProb[idx++]] = values[k];
  }
  const last = values[sorted ? n - 1 : order[n - 1]];
  while (idx < byProb.length) out[byProb[idx++]] = last;
  return out;
}

/** θ 的边缘后验密度（供绘图） */
export function marginalTheta(post) {
  const m = new Float64Array(NT);
  for (let i = 0; i < NT; i++) {
    let s = 0;
    const row = i * NS;
    for (let j = 0; j < NS; j++) s += post[row + j];
    m[i] = s;
  }
  return m;
}

/**
 * 汇总后验：θ 的中值与可信区间，以及其它正确率水平对应的色差。
 * 置信区间由**联合后验**计算，因此已经把 σ 的不确定性一并计入误差范围。
 */
// 复用同一组缓冲，避免每次都分配 ~26KB 的临时数组
const _v75 = new Float64Array(CELLS);
const _v90 = new Float64Array(CELLS);
const _vSigma = new Float64Array(CELLS);
const _vTheta = new Float64Array(CELLS);
const _wJoint = new Float64Array(CELLS);
const _wTheta = new Float64Array(NT);
const Z90 = probit(0.9);

export function summarize(post) {
  for (let i = 0; i < NT; i++) {
    let s = 0;
    const row = i * NS;
    for (let j = 0; j < NS; j++) s += post[row + j];
    _wTheta[i] = s;
  }

  // θ 在 75% / 90% 检测正确率处对应的 ΔE（用联合后验传播 σ 的不确定性）
  for (let i = 0; i < NT; i++) {
    const th = THETA[i];
    const row = i * NS;
    for (let j = 0; j < NS; j++) {
      const k = row + j;
      const s = SIGMA[j];
      _v75[k] = th * Math.exp(Z75 * s);
      _v90[k] = th * Math.exp(Z90 * s);
      _vSigma[k] = s;
      _vTheta[k] = th;
      _wJoint[k] = post[k];
    }
  }

  let mode = THETA[0];
  let modeW = -1;
  for (let i = 0; i < NT; i++) {
    if (_wTheta[i] > modeW) {
      modeW = _wTheta[i];
      mode = THETA[i];
    }
  }

  // _vTheta 随索引单调不减，可直接走免排序的快路径
  const [median, lo68, hi68, lo90, hi90] = quantiles(_vTheta, _wJoint, [0.5, 0.16, 0.84, 0.05, 0.95], true);
  const [t75, t75Lo, t75Hi] = quantiles(_v75, _wJoint, [0.5, 0.16, 0.84], false);
  const [t90] = quantiles(_v90, _wJoint, [0.5], false);
  const [sigma, sigmaLo, sigmaHi] = quantiles(_vSigma, _wJoint, [0.5, 0.16, 0.84], false);

  return { median, lo68, hi68, lo90, hi90, mode, t75, t75Lo, t75Hi, t90, sigma, sigmaLo, sigmaHi };
}

/** 后验的相对不确定度：68% 区间的半宽 / 中值（越小越确定） */
export function uncertainty(sum) {
  if (!sum || !Number.isFinite(sum.median) || sum.median <= 0) return Infinity;
  return (sum.hi68 - sum.lo68) / 2 / sum.median;
}
