/**
 * 冒烟测试：不需要浏览器，直接验证纯计算模块。
 *   npm test
 *
 * 覆盖：
 *   1. sRGB ↔ Lab 往返一致性
 *   2. CIEDE2000 与 Sharma et al. (2005) 公开参考数据逐条比对
 *   3. 刺激色生成：色域合法性、量化后 ΔE 与目标值的偏差
 *   4. 贝叶斯估计器：用已知阈值的虚拟被试跑完整流程，检验收敛与区间覆盖
 */

import {
  rgbToLab,
  labToRgb,
  deltaE2000,
  inGamut,
  makeStimulus,
} from '../public/src/color.js';
import {
  createPosterior,
  updatePosterior,
  selectDeltaE,
  summarize,
  marginalTheta,
  pCorrect,
  probit,
  buildSchedule,
  DE_MIN,
  DE_MAX,
} from '../public/src/psycho.js';
import {
  fmtDE,
  fmtPct,
  gradeOf,
  introModal,
  noticeModal,
  resultsModal,
  breakdownBySize,
} from '../public/src/views.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a, b, tol, label) {
  ok(Math.abs(a - b) <= tol, label, `期望 ${b} ± ${tol}，实得 ${a.toFixed(6)}`);
}

function section(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

/* ═══════════════ 1. 色彩空间往返 ═══════════════ */

section('sRGB ↔ Lab 往返一致性');

{
  let worst = 0;
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        const back = labToRgb(rgbToLab([r, g, b]));
        worst = Math.max(worst, Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b));
      }
    }
  }
  ok(worst <= 1, '往返误差 ≤ 1/255', `实测最大偏差 ${worst}`);
  console.log(`  最大往返偏差：${worst} / 255`);
}

/* ═══════════════ 2. CIEDE2000 参考数据 ═══════════════ */

section('CIEDE2000 vs Sharma et al. (2005) 参考数据');

// 摘自 Sharma, Wu & Dalal (2005) 的 CIEDE2000 测试数据集
const REFERENCE = [
  [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
  [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
  [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
  [[50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, -0.9009, -85.5211], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
  [[50.0, -1.0, 2.0], [50.0, 0.0, 0.0], 2.3669],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0009], 7.1792],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.001], 7.1792],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0012], 7.2195],
  [[50.0, -0.001, 2.49], [50.0, 0.0009, -2.49], 4.8045],
  [[50.0, -0.001, 2.49], [50.0, 0.0011, -2.49], 4.7461],
  [[50.0, 2.5, 0.0], [50.0, 0.0, -2.5], 4.3065],
  [[50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492],
  [[50.0, 2.5, 0.0], [61.0, -5.0, 29.0], 22.8977],
  [[50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
  [[50.0, 2.5, 0.0], [58.0, 24.0, 15.0], 19.4535],
  [[50.0, 2.5, 0.0], [50.0, 3.1736, 0.5854], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 3.2972, 0.0], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 1.8634, 0.5757], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 3.2592, 0.335], 1.0],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

{
  let worst = 0;
  let worstCase = '';
  for (const [l1, l2, expected] of REFERENCE) {
    const got = deltaE2000(l1, l2);
    const err = Math.abs(got - expected);
    if (err > worst) {
      worst = err;
      worstCase = `${JSON.stringify(l1)} vs ${JSON.stringify(l2)}`;
    }
    ok(err <= 1e-4, `ΔE00 ${expected}`, `实得 ${got.toFixed(4)}（${worstCase}）`);
  }
  console.log(`  比对 ${REFERENCE.length} 组，最大误差 ${worst.toExponential(2)}`);
}

/* ═══════════════ 3. 刺激色生成 ═══════════════ */

section('刺激色生成（色域 / 量化 / 目标色差）');

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

{
  const targets = [0.45, 0.7, 1, 1.5, 2, 3, 5, 8, 12, 20, 35];
  const stats = [];

  for (const target of targets) {
    const rng = mulberry32(1234 + Math.round(target * 100));
    let worstRel = 0;
    let made = 0;

    for (let i = 0; i < 60; i++) {
      const stim = makeStimulus(target, rng);
      ok(!!stim, `ΔE=${target} 能生成刺激`);
      if (!stim) continue;
      made++;

      const { baseRgb, oddRgb } = stim;
      const ints = [...baseRgb, ...oddRgb].every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
      ok(ints, `ΔE=${target} 颜色为合法 8bit 整数`, JSON.stringify([baseRgb, oddRgb]));
      ok(
        baseRgb.join() !== oddRgb.join(),
        `ΔE=${target} 异色块与底色不同`,
        JSON.stringify([baseRgb, oddRgb]),
      );

      // 记录下来的 ΔE 必须等于"真正渲染出来的那两个颜色"之间的 ΔE
      const rendered = deltaE2000(rgbToLab(baseRgb), rgbToLab(oddRgb));
      near(stim.deltaE, rendered, 1e-9, `ΔE=${target} 记录的色差与渲染一致`);

      const rel = Math.abs(rendered - target) / target;
      worstRel = Math.max(worstRel, rel);
    }

    stats.push({ target, worstRel, made });
    ok(worstRel < 0.3, `ΔE=${target} 的生成误差 < 30%`, `最差 ${(worstRel * 100).toFixed(1)}%`);
  }

  console.log('  目标 ΔE → 实际达成的最差相对误差：');
  for (const s of stats) {
    console.log(`    ${String(s.target).padStart(5)} → ${(s.worstRel * 100).toFixed(2).padStart(6)}%  (n=${s.made})`);
  }
}

{
  // 底色必须自己也在色域内，否则屏幕上根本显示不出来
  const rng = mulberry32(99);
  let allIn = true;
  for (let i = 0; i < 200; i++) {
    const stim = makeStimulus(3, rng);
    if (!stim) continue;
    if (!inGamut(stim.baseLab, 0.01) || !inGamut(stim.oddLab, 0.01)) allIn = false;
  }
  ok(allIn, '底色与异色都在 sRGB 色域内');
}

/* ═══════════════ 4. 贝叶斯估计器收敛性 ═══════════════ */

section('贝叶斯估计器：虚拟被试收敛测试');

const SCHEDULE = buildSchedule(21);

{
  // 日程本身的基本性质：2×2 起步、9×9 收尾、覆盖全部尺寸
  ok(SCHEDULE.length === 21, '21 轮日程长度为 21', `实得 ${SCHEDULE.length}`);
  ok(SCHEDULE[0] === 2, '日程从 2×2 开始', `实得 ${SCHEDULE[0]}`);
  ok(SCHEDULE[20] === 9, '日程以 9×9 结束', `实得 ${SCHEDULE[20]}`);
  const sizes = new Set(SCHEDULE);
  ok(
    [2, 3, 4, 5, 6, 7, 8, 9].every((s) => sizes.has(s)),
    '日程覆盖 2~9 的全部阵列规模',
    `实得 ${[...sizes].sort((a, b) => a - b).join(',')}`,
  );
  ok(
    SCHEDULE.every((s, i) => i === 0 || s >= SCHEDULE[i - 1]),
    '日程单调不减（难度只升不降）',
  );
  ok(buildSchedule(8).join() === '2,3,4,5,6,7,8,9', '8 轮快速模式覆盖 2~9 各一次', buildSchedule(8).join());
  console.log(`  21 轮日程：${SCHEDULE.join(',')}`);
}

function runVirtualObserver(trueTheta, trueSigma, seed) {
  const rng = mulberry32(seed);
  const post = createPosterior();
  const history = [];

  for (let i = 0; i < SCHEDULE.length; i++) {
    const cells = SCHEDULE[i] ** 2;
    const warmup = i === 0 ? 2.0 : i === 1 ? 1.4 : 1;
    const de = selectDeltaE(post, cells, warmup);
    const p = pCorrect(de, cells, Math.log(trueTheta), trueSigma);
    const correct = rng() < p;
    updatePosterior(post, de, cells, correct);
    history.push({ de, correct, width: summarize(post).hi68 - summarize(post).lo68 });
  }

  return { post, sum: summarize(post), history };
}

{
  const cases = [
    { theta: 1.2, sigma: 0.15 },
    { theta: 2.0, sigma: 0.25 },
    { theta: 3.5, sigma: 0.22 },
    { theta: 6.0, sigma: 0.3 },
    { theta: 0.8, sigma: 0.18 },
  ];

  const priorWidth = (() => {
    const s = summarize(createPosterior());
    return s.hi68 - s.lo68;
  })();
  console.log(`  先验 68% 区间宽度：${priorWidth.toFixed(2)} ΔE`);

  // 单个随机种子可能撞上罕见样本（比如在难度下限附近连蒙对几次），
  // 所以每个阈值跑多个种子，断言放在"多种子的平均"上 —— 既稳健也更有统计意义。
  const SEEDS = 3;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  let cover68 = 0;
  let cover90 = 0;
  let total = 0;
  let worstRelErr = 0;

  for (const c of cases) {
    const sums = [];
    const heads = [];
    const tails = [];

    for (let s = 0; s < SEEDS; s++) {
      const { sum, history } = runVirtualObserver(c.theta, c.sigma, 1013 + s * 7919 + Math.round(c.theta * 1000));
      sums.push(sum);
      heads.push(mean(history.slice(0, 7).map((h) => h.width)));
      tails.push(mean(history.slice(-7).map((h) => h.width)));
      total++;
      if (c.theta >= sum.lo68 && c.theta <= sum.hi68) cover68++;
      if (c.theta >= sum.lo90 && c.theta <= sum.hi90) cover90++;
      worstRelErr = Math.max(worstRelErr, Math.abs(sum.median - c.theta) / c.theta);

      // 分位数必须单调有序，且 90% 区间包含 68% 区间
      ok(sum.lo68 <= sum.median && sum.median <= sum.hi68, `θ*=${c.theta} 分位数单调有序`);
      ok(sum.lo90 <= sum.lo68 && sum.hi68 <= sum.hi90, `θ*=${c.theta} 90% 区间包含 68% 区间`);
      ok(sum.lo90 >= DE_MIN * 0.999 && sum.hi90 <= DE_MAX * 1.001, `θ*=${c.theta} 区间不超出量程`);
    }

    const medians = sums.map((s) => s.median);
    const widths = sums.map((s) => s.hi68 - s.lo68);
    const relBias = Math.abs(mean(medians) - c.theta) / c.theta;

    console.log(
      `  θ*=${c.theta.toFixed(2)} σ*=${c.sigma}  →  ${SEEDS} 个种子的中值 ` +
        `${medians.map((m) => m.toFixed(3)).join(' / ')}  平均相对偏差 ${(relBias * 100).toFixed(1)}%  ` +
        `平均区间宽 ${mean(widths).toFixed(3)}`,
    );

    ok(relBias < 0.25, `θ*=${c.theta} 多种子平均相对偏差 < 25%`, `实得 ${(relBias * 100).toFixed(1)}%`);
    ok(mean(widths) < priorWidth / 8, `θ*=${c.theta} 不确定度显著收窄`, `${mean(widths).toFixed(3)} vs 先验 ${priorWidth.toFixed(2)}`);
    ok(mean(tails) < mean(heads), `θ*=${c.theta} 后段不确定度低于前段`, `${mean(heads).toFixed(3)} → ${mean(tails).toFixed(3)}`);
    ok(mean(tails) < priorWidth / 4, `θ*=${c.theta} 后段不确定度远低于先验`, `${mean(tails).toFixed(3)} vs 先验 ${priorWidth.toFixed(2)}`);
  }

  console.log(`  区间覆盖率（共 ${total} 次）：68% → ${cover68}/${total}，90% → ${cover90}/${total}`);
  ok(cover90 >= total * 0.75, `90% 区间覆盖率 ≥ 75%`, `实得 ${cover90}/${total}`);
  ok(cover68 >= total * 0.55, `68% 区间覆盖率 ≥ 55%`, `实得 ${cover68}/${total}`);
  ok(worstRelErr < 0.45, '所有种子的中值相对误差 < 45%', `最差 ${(worstRelErr * 100).toFixed(1)}%`);
}

{
  // 猜对概率必须随阵列变大而下降，且被正确建模
  const p2 = pCorrect(1, 4, Math.log(3), 0.25);
  const p9 = pCorrect(1, 81, Math.log(3), 0.25);
  ok(p2 > p9, '同一 ΔE 下 2×2 比 9×9 更容易答对', `${p2.toFixed(3)} vs ${p9.toFixed(3)}`);
  ok(Math.abs(pCorrect(1e-6, 4, Math.log(3), 0.25) - 0.25) < 1e-3, 'ΔE→0 时正确率收敛到猜测概率 1/4');
  ok(pCorrect(1e6, 81, Math.log(3), 0.25) > 0.97, 'ΔE→∞ 时正确率收敛到 1−失误率');
  // normCdf 是近似式（误差 ~1e-7），这里只要求 1e-6 精度
  near(pCorrect(3, 4, Math.log(3), 0.25), 0.25 + (1 - 0.25 - 0.02) * 0.5, 1e-6, 'θ 处恰为 50% 检测水平');
}

{
  // 先验与区间的基本性质。
  // 先验在 log 轴上均匀，所以各分位点有解析解：q_p = DE_MIN · (DE_MAX/DE_MIN)^p。
  // 用它来独立校验分位数计算（θ 网格是离散的，容许一个格距 ≈2% 的误差）。
  const q = (p) => DE_MIN * Math.pow(DE_MAX / DE_MIN, p);
  const prior = summarize(createPosterior());

  for (const [name, got, p] of [
    ['lo90', prior.lo90, 0.05],
    ['lo68', prior.lo68, 0.16],
    ['median', prior.median, 0.5],
    ['hi68', prior.hi68, 0.84],
    ['hi90', prior.hi90, 0.95],
  ]) {
    const want = q(p);
    const relErr = Math.abs(got - want) / want;
    ok(relErr < 0.03, `先验 ${name} 与解析解一致`, `实得 ${got.toFixed(4)}，解析解 ${want.toFixed(4)}（偏差 ${(relErr * 100).toFixed(2)}%）`);
  }

  ok(prior.median > DE_MIN && prior.median < DE_MAX, '先验中值落在量程内');
  ok(prior.lo90 >= DE_MIN * 0.999 && prior.hi90 <= DE_MAX * 1.001, '先验区间不超出量程');
  ok(
    prior.lo90 <= prior.lo68 && prior.lo68 <= prior.median && prior.median <= prior.hi68 && prior.hi68 <= prior.hi90,
    '先验分位数单调有序',
    JSON.stringify([prior.lo90, prior.lo68, prior.median, prior.hi68, prior.hi90].map((v) => +v.toFixed(3))),
  );

  const m = marginalTheta(createPosterior());
  let total = 0;
  for (const v of m) total += v;
  near(total, 1, 1e-9, '边缘后验归一化');
}

{
  // selectDeltaE 必须始终落在量程内
  const post = createPosterior();
  let inRange = true;
  for (let i = 0; i < 40; i++) {
    const de = selectDeltaE(post, 4 + (i % 5) ** 2, i === 0 ? 2.0 : 1);
    if (!(de >= DE_MIN && de <= DE_MAX)) inRange = false;
    updatePosterior(post, de, 4, i % 3 === 0);
  }
  ok(inRange, 'selectDeltaE 的取值始终在 [DE_MIN, DE_MAX] 内');
  near(probit(0.75), 0.6744897501960817, 1e-6, 'probit(0.75) 正确');
  near(probit(0.5), 0, 1e-6, 'probit(0.5) 正确');
}

/* ═══════════════ 5. 视图渲染 ═══════════════ */

section('结果页 / 开场页渲染（views.js）');

{
  // 用虚拟被试真的跑完一整轮测试，按 finish() 的结构组装 result，再渲染结果页 ——
  // 这样"结果页显示对不对"就不需要靠人肉把游戏打完才能验证。
  const { sum, history } = runVirtualObserver(2.5, 0.2, 4242);
  const trials = history.map((h, i) => ({
    n: SCHEDULE[i],
    de: h.de,
    correct: h.correct,
    rt: 1500 + i * 37,
  }));
  const totalRt = trials.reduce((a, t) => a + t.rt, 0);
  const result = {
    id: '1',
    date: new Date('2026-09-10T12:00:00Z').toISOString(),
    median: sum.median,
    lo68: sum.lo68,
    hi68: sum.hi68,
    lo90: sum.lo90,
    hi90: sum.hi90,
    t75: sum.t75,
    t75Lo: sum.t75Lo,
    t75Hi: sum.t75Hi,
    sigma: sum.sigma,
    accuracy: trials.filter((t) => t.correct).length / trials.length,
    avgRt: totalRt / trials.length,
    totalMs: totalRt,
    trials,
  };

  const html = resultsModal({
    result,
    isRecord: true,
    prevBest: { median: 9.9 },
    history: [result],
    rounds: SCHEDULE.length,
  });

  ok(!/undefined|NaN|\[object /.test(html), '结果页不含 undefined / NaN / [object Object]');
  ok(html.includes(`<div class="big-de">${fmtDE(result.median)}`), '结果页主数字等于后验中值');
  ok(
    html.includes(`${fmtDE(result.lo68)} – ${fmtDE(result.hi68)}`),
    '结果页显示 68% 误差范围',
    `${fmtDE(result.lo68)} – ${fmtDE(result.hi68)}`,
  );
  ok(html.includes(`${fmtDE(result.lo90)} – ${fmtDE(result.hi90)}`), '结果页显示 90% 可信区间');
  ok(html.includes('刷新本机纪录'), '破纪录时显示纪录徽章');
  ok(html.includes(`>${trials.length} / ${SCHEDULE.length}<`), '完成轮数正确');
  ok(html.includes('<canvas id="resPosterior">'), '包含最终后验分布画布');
  ok(html.includes('<canvas id="resTrials">'), '包含逐轮阶梯画布');
  ok(html.includes('<canvas id="resSpark">'), '包含历史走势画布');

  const divOpen = (html.match(/<div/g) || []).length;
  const divClose = (html.match(/<\/div>/g) || []).length;
  ok(divOpen === divClose, 'div 标签成对', `<div> × ${divOpen} vs </div> × ${divClose}`);

  const bodyRows = (html.match(/<tr><td>/g) || []).length;
  ok(bodyRows === new Set(SCHEDULE).size, '按阵列规模分组的行数正确', `实得 ${bodyRows}`);

  const noRecord = resultsModal({
    result,
    isRecord: false,
    prevBest: { median: 1 },
    history: [result],
    rounds: SCHEDULE.length,
  });
  ok(!noRecord.includes('刷新本机纪录'), '未破纪录时不显示纪录徽章');
  ok(!noRecord.includes('上一次纪录'), '未破纪录时不显示上次纪录');

  // 分组统计：每个尺寸的答对数不得超过该尺寸的轮数
  const rows = breakdownBySize(trials);
  ok(rows.length === new Set(SCHEDULE).size, '分组数等于不同阵列规模数');
  ok(rows.every((r) => r.ok <= r.total && r.total > 0), '每组的答对数不超过总轮数');
  ok(rows.every((r, i) => i === 0 || r.n > rows[i - 1].n), '分组按阵列规模升序');
  ok(
    rows.reduce((a, r) => a + r.total, 0) === trials.length,
    '各组轮数之和等于总轮数',
  );
}

{
  // 评级分档的边界
  const bands = [
    [0.5, 'S'], [1.0, 'S'], [1.01, 'A'], [2.0, 'A'], [2.01, 'B'],
    [4.0, 'B'], [4.01, 'C'], [8.0, 'C'], [8.01, 'D'], [15, 'D'], [15.01, 'E'], [40, 'E'],
  ];
  for (const [median, want] of bands) {
    ok(gradeOf(median).grade === want, `评级分档 ΔE=${median} → ${want}`, `实得 ${gradeOf(median).grade}`);
  }
  ok(gradeOf(Infinity).grade === 'E', '极端值也能给出评级');
}

{
  // 开场页：轮数文案与按钮
  const intro21 = introModal({ best: null, rounds: 21, quickRounds: 8 });
  ok(intro21.includes('共 21 轮'), '开场页显示 21 轮');
  ok(intro21.includes('开始测试（21 轮）'), '主按钮显示 21 轮');
  ok(intro21.includes('快速测试（8 轮）'), '提供快速测试入口');
  ok(!intro21.includes('undefined'), '无纪录时开场页也正常');

  const introQuick = introModal({ best: { median: 2.5 }, rounds: 8, quickRounds: 8 });
  ok(introQuick.includes('本机纪录：中值 ΔE<sub>00</sub> = 2.50'), '有纪录时显示纪录');
  ok(!introQuick.includes('data-act="quick"'), '默认轮数已等于快速轮数时不重复显示快速入口');
  ok(introQuick.includes('<canvas id="introSpark">'), '有纪录时显示走势画布');

  ok(noticeModal({ title: 'T', body: 'B' }).includes('data-act="start"'), '提示弹层带重新开始按钮');
  ok(fmtPct(0.8) === '80%' && fmtDE(2) === '2.00' && fmtDE(NaN) === '—', '格式化函数正确');
}

/* ═══════════════ 6. 本机纪录持久化 ═══════════════ */

section('本机纪录持久化（store.js）');

{
  // localStorage 在 Node 里不存在，用一个内存实现替代后再动态 import
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };

  const store = await import('../public/src/store.js');
  const mk = (median, date) => ({
    id: String(median),
    date,
    median,
    lo68: median * 0.8,
    hi68: median * 1.2,
    accuracy: 0.7,
    avgRt: 1500,
    trials: Array.from({ length: 21 }, (_, i) => ({ n: 2 + (i % 8), de: median, correct: true, rt: 1200 })),
  });

  let s = store.load();
  ok(s.best === null && s.history.length === 0, '首次访问时没有纪录');
  ok(s.settings.sound === true, '默认开启音效');

  const r1 = store.submitResult(s, mk(3.0, '2026-09-01T10:00:00Z'));
  ok(r1.isRecord === true, '第一次成绩即为纪录');
  ok(s.best.median === 3.0, '纪录写入 best');

  // 更差的成绩不刷新纪录
  const r2 = store.submitResult(s, mk(5.0, '2026-09-02T10:00:00Z'));
  ok(r2.isRecord === false, '更差的中值不算破纪录');
  ok(s.best.median === 3.0, '纪录保持不变');
  ok(s.history.length === 2 && s.history[0].median === 5.0, '历史按时间倒序累积');

  // 更好的成绩刷新纪录（ΔE 越低越好）
  const r3 = store.submitResult(s, mk(1.2, '2026-09-03T10:00:00Z'));
  ok(r3.isRecord === true, '更低的中值算破纪录');
  ok(s.best.median === 1.2, '纪录被更新');
  ok(r3.prevBest.median === 3.0, '返回上一次纪录用于对比');

  // 重新读取：模拟关掉页面再打开
  const reloaded = store.load();
  ok(reloaded.best.median === 1.2, '重新打开后纪录仍在（同机保留）');
  ok(reloaded.history.length === 3, '历史一并保留');

  // 音效设置
  store.saveSettings(reloaded, { sound: false });
  ok(store.load().settings.sound === false, '音效设置持久化');

  // 历史长度上限
  for (let i = 0; i < 60; i++) store.submitResult(s, mk(2 + i, `2026-09-04T10:00:${String(i).padStart(2, '0')}Z`));
  ok(s.history.length === 40, '历史最多保留 40 条', `实得 ${s.history.length}`);

  // 数据损坏时不应崩溃
  backing.set('chromatic-acuity.v1', '{ this is not json');
  const recovered = store.load();
  ok(recovered.best === null && recovered.history.length === 0, '数据损坏时回退到空状态');

  backing.set('chromatic-acuity.v1', '"a string"');
  ok(store.load().history.length === 0, '类型异常时也回退到空状态');

  // 清除
  s = store.submitResult(store.load(), mk(2.0, '2026-09-05T10:00:00Z'));
  ok(s.best !== null, '清除前有纪录');
  const cleared = store.clearAll();
  ok(cleared.best === null && cleared.history.length === 0, 'clearAll 返回空状态');
  ok(store.load().best === null, 'clearAll 之后读不到纪录');

  delete globalThis.localStorage;
}

/* ═══════════════ 汇总 ═══════════════ */

console.log(`\n${'─'.repeat(56)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ 全部通过 —— ${passed} 项断言\x1b[0m\n`);
} else {
  console.log(`\x1b[31m✗ ${failed} 项失败 / 共 ${passed + failed} 项\x1b[0m`);
  for (const f of failures.slice(0, 25)) console.log(`   · ${f}`);
  if (failures.length > 25) console.log(`   … 另有 ${failures.length - 25} 项`);
  console.log('');
  process.exitCode = 1;
}
