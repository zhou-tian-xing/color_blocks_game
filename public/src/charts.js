/**
 * 轻量 Canvas 图表：
 *   · drawPosterior —— θ 的后验密度曲线（随作答不断收窄）
 *   · drawTrials    —— 逐轮阶梯散点（绿=答对，红=答错）
 *   · drawSparkline —— 历史纪录走势
 * 全部 DPR 自适应。
 */

import { DE_MIN, DE_MAX, THETA } from './psycho.js';

const FONT = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const LN_MIN = Math.log(DE_MIN);
const LN_MAX = Math.log(DE_MAX);

const CSS = () =>
  getComputedStyle(document.documentElement);

function palette() {
  const cs = CSS();
  return {
    text: cs.getPropertyValue('--chart-text').trim() || '#8b95ad',
    grid: cs.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,.08)',
    accent: cs.getPropertyValue('--accent').trim() || '#6ee7ff',
    accent2: cs.getPropertyValue('--accent2').trim() || '#a78bfa',
    good: cs.getPropertyValue('--good').trim() || '#34d399',
    bad: cs.getPropertyValue('--bad').trim() || '#fb7185',
  };
}

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const fmt = (v) => (v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));

/** 在 [lo, hi] 里挑几个好看的刻度值 */
const NICE = [0.5, 0.6, 0.8, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 40, 50];
function niceTicks(lo, hi) {
  return NICE.filter((v) => v >= lo * 0.999 && v <= hi * 1.001);
}

/* ────────────────────────── 后验密度曲线 ────────────────────────── */

/**
 * @param {Float64Array} marginal 与 THETA 等长的边缘密度
 * @param {object|null} sum        summarize() 的结果，用于画中值与 68% 区间
 */
export function drawPosterior(canvas, marginal, sum) {
  const { ctx, w, h } = fit(canvas);
  const pal = palette();
  const padL = 12;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // 自适应窗口：围绕中值放大，让"收窄"这件事在视觉上真的能看出来
  let lo = DE_MIN;
  let hi = DE_MAX;
  if (sum && Number.isFinite(sum.median) && sum.median > 0) {
    const span = Math.max((sum.hi90 - sum.lo90) * 2.2, sum.median * 0.9, DE_MIN * 2);
    lo = Math.max(DE_MIN, sum.median - span);
    hi = Math.min(DE_MAX, sum.median + span);
    if (hi - lo < DE_MIN) {
      lo = Math.max(DE_MIN, lo - DE_MIN);
      hi = Math.min(DE_MAX, hi + DE_MIN);
    }
  }

  const lnLo = Math.log(lo);
  const lnHi = Math.log(hi);
  const xOf = (de) => padL + ((Math.log(de) - lnLo) / (lnHi - lnLo)) * plotW;

  // 只在窗口内累加，保证曲线顶部贴合画布
  let maxD = 0;
  let sumD = 0;
  for (let i = 0; i < THETA.length; i++) {
    if (THETA[i] < lo || THETA[i] > hi) continue;
    maxD = Math.max(maxD, marginal[i]);
    sumD += marginal[i];
  }
  if (!(maxD > 0)) {
    ctx.font = FONT;
    ctx.fillStyle = pal.text;
    ctx.textAlign = 'center';
    ctx.fillText('等待测试数据…', w / 2, h / 2);
    return;
  }

  // 网格
  ctx.font = FONT;
  ctx.textBaseline = 'top';
  ctx.strokeStyle = pal.grid;
  ctx.fillStyle = pal.text;
  ctx.lineWidth = 1;
  const ticks = niceTicks(lo, hi);
  ctx.textAlign = 'center';
  for (const t of ticks) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(String(t), x, padT + plotH + 5);
  }

  const yOf = (d) => padT + plotH - (d / maxD) * (plotH * 0.94);

  // 68% 可信区间色带
  if (sum && Number.isFinite(sum.lo68)) {
    const x0 = xOf(Math.max(lo, sum.lo68));
    const x1 = xOf(Math.min(hi, sum.hi68));
    if (x1 > x0) {
      const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      g.addColorStop(0, 'rgba(110,231,255,.22)');
      g.addColorStop(1, 'rgba(110,231,255,.02)');
      ctx.fillStyle = g;
      ctx.fillRect(x0, padT, x1 - x0, plotH);
    }
  }

  // 密度曲线
  const pts = [];
  for (let i = 0; i < THETA.length; i++) {
    if (THETA[i] < lo || THETA[i] > hi) continue;
    pts.push([xOf(THETA[i]), yOf(marginal[i])]);
  }
  if (pts.length < 2) return;

  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(167,139,250,.55)');
  grad.addColorStop(0.6, 'rgba(110,231,255,.18)');
  grad.addColorStop(1, 'rgba(110,231,255,0)');

  ctx.beginPath();
  ctx.moveTo(pts[0][0], padT + plotH);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(110,231,255,.55)';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 中值竖线
  if (sum && Number.isFinite(sum.median) && sum.median >= lo && sum.median <= hi) {
    const x = Math.round(xOf(sum.median)) + 0.5;
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.strokeStyle = pal.accent2;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ────────────────────────── 逐轮阶梯散点 ────────────────────────── */

export function drawTrials(canvas, trials, sum) {
  const { ctx, w, h } = fit(canvas);
  const pal = palette();
  const padL = 30;
  const padR = 12;
  const padT = 12;
  const padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xOf = (i) => padL + (trials.length <= 1 ? plotW / 2 : (i / (trials.length - 1)) * plotW);
  const yOf = (de) => padT + plotH - ((Math.log(de) - LN_MIN) / (LN_MAX - LN_MIN)) * plotH;

  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  for (const t of [1, 3, 10, 30]) {
    const y = Math.round(yOf(t)) + 0.5;
    if (y < padT - 2 || y > padT + plotH + 2) continue;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = pal.text;
    ctx.fillText(String(t), padL - 6, y);
  }

  if (!trials.length) {
    ctx.textAlign = 'center';
    ctx.fillStyle = pal.text;
    ctx.fillText('尚无作答', padL + plotW / 2, padT + plotH / 2);
    return;
  }

  // 68% 区间横向色带：随着测试推进它越来越窄
  if (sum && Number.isFinite(sum.lo68)) {
    const y0 = yOf(Math.min(DE_MAX, Math.max(DE_MIN, sum.hi68)));
    const y1 = yOf(Math.min(DE_MAX, Math.max(DE_MIN, sum.lo68)));
    ctx.fillStyle = 'rgba(110,231,255,.13)';
    ctx.fillRect(padL, y0, plotW, Math.max(2, y1 - y0));
  }

  // 连线
  ctx.beginPath();
  trials.forEach((t, i) => (i ? ctx.lineTo(xOf(i), yOf(t.de)) : ctx.moveTo(xOf(i), yOf(t.de))));
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 散点
  trials.forEach((t, i) => {
    const x = xOf(i);
    const y = yOf(t.de);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = t.correct ? pal.good : pal.bad;
    ctx.fill();
    if (!t.correct) {
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });
}

/* ────────────────────────── 历史走势 ────────────────────────── */

export function drawSparkline(canvas, values) {
  const { ctx, w, h } = fit(canvas);
  const pal = palette();
  if (values.length < 2) {
    ctx.font = FONT;
    ctx.fillStyle = pal.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('再测一次即可看到走势', w / 2, h / 2);
    return;
  }

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pad = 8;
  const xOf = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const yOf = (v) => h - pad - ((v - lo) / span) * (h - pad * 2);

  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v))));
  ctx.strokeStyle = pal.accent2;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  values.forEach((v, i) => {
    ctx.beginPath();
    ctx.arc(xOf(i), yOf(v), i === values.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = i === values.length - 1 ? pal.accent : 'rgba(167,139,250,.5)';
    ctx.fill();
  });
}

export { fmt };
