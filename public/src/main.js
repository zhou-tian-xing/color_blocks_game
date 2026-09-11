/**
 * 色觉鉴别能力测试 —— 主流程
 *
 * 每一轮：在 N×N 阵列里点出颜色不同的那一块，限时 30 秒。
 * N 从 2 逐步加码到 9；每答一轮就用贝叶斯后验更新对"最小可鉴别 ΔE00"的估计，
 * 于是后验分布一轮比一轮窄 —— 这就是"不确定度在减小"的可视化。
 * 全部结束后给出中值 ΔE00 与 68% / 90% 可信区间（误差范围）。
 */

import { makeStimulus, rgbCss } from './color.js';
import {
  createPosterior,
  updatePosterior,
  selectDeltaE,
  summarize,
  marginalTheta,
  buildSchedule,
  DE_MIN,
  DE_MAX,
} from './psycho.js';
import * as store from './store.js';
import { drawPosterior, drawTrials, drawSparkline } from './charts.js';
import { fmtDE, fmtPct, fmtSecs, introModal, noticeModal, resultsModal } from './views.js';

/* ─────────────────────────────── 配置 ─────────────────────────────── */

const TRIAL_MS = 30_000; // 每轮限时 30 秒

const DEFAULT_ROUNDS = 21;
const QUICK_ROUNDS = 8;

/** 允许用 ?rounds=N 直接指定轮数（4~60），方便快速复测 */
const roundsFromUrl = (() => {
  const v = Number.parseInt(new URLSearchParams(location.search).get('rounds') ?? '', 10);
  return Number.isFinite(v) ? Math.max(4, Math.min(60, v)) : null;
})();

const defaultRounds = roundsFromUrl ?? DEFAULT_ROUNDS;
let schedule = buildSchedule(defaultRounds);

/** 至少完成这么多轮才计入纪录（否则后验还基本是先验，没有意义） */
const MIN_TRIALS_TO_RECORD = 6;

/* ─────────────────────────────── DOM ─────────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  grid: $('grid'),
  gridIdle: $('gridIdle'),
  sizePill: $('sizePill'),
  trialPill: $('trialPill'),
  timer: $('timer'),
  timerFill: $('timerFill'),
  timerText: $('timerText'),
  feedback: $('feedback'),
  feedbackText: $('feedbackText'),
  feedbackDe: $('feedbackDe'),
  posteriorChart: $('posteriorChart'),
  trialChart: $('trialChart'),
  sMedian: $('sMedian'),
  sRange: $('sRange'),
  sAcc: $('sAcc'),
  sRt: $('sRt'),
  startBtn: $('startBtn'),
  abortBtn: $('abortBtn'),
  soundBtn: $('soundBtn'),
  soundIcon: $('soundIcon'),
  recordChip: $('recordChip'),
  recordValue: $('recordValue'),
  overlay: $('overlay'),
  modal: $('modal'),
};

/* ─────────────────────────────── 状态 ─────────────────────────────── */

const app = {
  phase: 'idle', // idle | running | feedback | done
  rounds: defaultRounds, // 本次会话的轮数（可用「快速测试」或 ?rounds=N 改变）
  session: 0, // 会话令牌，用于作废挂起的定时器
  trialIndex: 0,
  post: createPosterior(),
  sum: null,
  trials: [],
  current: null, // { n, stim, targetDE, oddIndex, startAt, answered }
  rafId: 0,
  hardTimeout: 0,
  store: null,
  lastResult: null,
};

app.sum = summarize(app.post);

/* ─────────────────────────────── 音效 ─────────────────────────────── */

let audioCtx = null;

function tone(freq, startOffset, dur, type = 'sine', peak = 0.05) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + startOffset;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function sfx(name) {
  if (!app.store?.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    return;
  }
  switch (name) {
    case 'ok':
      tone(880, 0, 0.1, 'sine', 0.045);
      tone(1318, 0.07, 0.14, 'sine', 0.04);
      break;
    case 'bad':
      tone(200, 0, 0.16, 'triangle', 0.05);
      tone(150, 0.08, 0.2, 'triangle', 0.045);
      break;
    case 'timeout':
      tone(320, 0, 0.14, 'square', 0.03);
      tone(220, 0.12, 0.24, 'square', 0.03);
      break;
    case 'start':
      [523, 659, 784].forEach((f, i) => tone(f, i * 0.07, 0.16, 'sine', 0.04));
      break;
    case 'finish':
      [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, 0.42, 'sine', 0.045));
      break;
    case 'record':
      [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.09, 0.5, 'triangle', 0.045));
      break;
  }
}

/* ─────────────────────────────── 渲染 ─────────────────────────────── */

function setFeedback(text, tone = 'idle', de = '') {
  el.feedbackText.textContent = text;
  el.feedback.dataset.tone = tone;
  el.feedbackDe.textContent = de;
}

function renderRecordChip() {
  const best = app.store.best;
  el.recordValue.textContent = best ? `${fmtDE(best.median)} ΔE` : '暂无';
  el.recordChip.title = best
    ? `本机最佳：中值 ΔE00 = ${fmtDE(best.median)}（${new Date(best.date).toLocaleString('zh-CN')}）`
    : '本机还没有纪录，完成一次测试即可留下';
}

function renderStageMeta() {
  const n = schedule[Math.min(app.trialIndex, schedule.length - 1)];
  el.sizePill.textContent = `${n} × ${n}`;
  el.trialPill.textContent = `第 ${Math.min(app.trialIndex + 1, schedule.length)} / ${schedule.length} 轮`;
}

function renderCharts() {
  drawPosterior(el.posteriorChart, marginalTheta(app.post), app.sum);
  drawTrials(el.trialChart, app.trials, app.sum);
}

function renderStats() {
  if (!app.trials.length) {
    el.sMedian.textContent = '—';
    el.sRange.textContent = '—';
    el.sAcc.textContent = '—';
    el.sRt.textContent = '—';
    return;
  }
  const s = app.sum;
  el.sMedian.textContent = fmtDE(s.median);
  el.sRange.textContent = `${fmtDE(s.lo68)} – ${fmtDE(s.hi68)}`;
  const acc = app.trials.filter((t) => t.correct).length / app.trials.length;
  el.sAcc.textContent = fmtPct(acc);
  el.sRt.textContent = fmtSecs(app.trials.reduce((a, t) => a + t.rt, 0) / app.trials.length);
}

/* ─────────────────────────────── 阵列绘制 ─────────────────────────────── */

function paintGrid(n, stim, oddIndex) {
  el.grid.style.setProperty('--n', n);
  el.grid.style.setProperty('--gap', `${Math.max(2, Math.round(11 - n * 0.95))}px`);

  const baseCss = rgbCss(stim.baseRgb);
  const oddCss = rgbCss(stim.oddRgb);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < n * n; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.dataset.index = String(i);
    b.style.setProperty('--i', i);
    b.style.backgroundColor = i === oddIndex ? oddCss : baseCss;
    b.setAttribute('aria-label', `色块 ${i + 1}`);
    frag.appendChild(b);
  }
  el.grid.replaceChildren(frag);
  el.grid.classList.remove('locked');
}

function paintResult(picked, oddIndex, correct, timedOut) {
  const tiles = el.grid.children;
  el.grid.classList.add('locked');

  if (correct) {
    tiles[picked]?.classList.add('picked-ok');
    return;
  }
  if (!timedOut && picked >= 0) tiles[picked]?.classList.add('picked-bad');
  tiles[oddIndex]?.classList.add('reveal');
}

/* ─────────────────────────────── 计时 ─────────────────────────────── */

function tick() {
  const cur = app.current;
  if (!cur || app.phase !== 'running') return;

  const remain = Math.max(0, TRIAL_MS - (performance.now() - cur.startAt));
  const frac = remain / TRIAL_MS;

  el.timerFill.style.transform = `scaleX(${frac})`;
  el.timerText.textContent = `${(remain / 1000).toFixed(1)}s`;
  el.timer.classList.toggle('warn', frac <= 0.4 && frac > 0.2);
  el.timer.classList.toggle('danger', frac <= 0.2);

  if (remain <= 0) {
    handleAnswer(-1, true);
    return;
  }
  app.rafId = requestAnimationFrame(tick);
}

function stopTimer() {
  cancelAnimationFrame(app.rafId);
  clearTimeout(app.hardTimeout);
  el.timer.classList.remove('warn', 'danger');
}

/* ─────────────────────────────── 单轮流程 ─────────────────────────────── */

function startSession(rounds) {
  app.rounds = rounds ?? app.rounds;
  schedule = buildSchedule(app.rounds);
  app.session++;
  app.phase = 'idle';
  app.trialIndex = 0;
  app.trials = [];
  app.post = createPosterior();
  app.sum = summarize(app.post);
  app.current = null;
  app.lastResult = null;

  el.grid.replaceChildren();
  el.gridIdle.hidden = true;
  el.startBtn.disabled = true;
  el.startBtn.textContent = '测试进行中…';
  el.abortBtn.hidden = false;
  el.overlay.hidden = true;

  renderCharts();
  renderStats();
  sfx('start');
  startTrial();
}

function startTrial() {
  if (app.trialIndex >= schedule.length) {
    finish();
    return;
  }

  const n = schedule[app.trialIndex];
  const cells = n * n;

  // 开局两轮故意放宽一点，避免一上来就劝退；之后完全交给信息量最大化
  const warmup = app.trialIndex === 0 ? 2.0 : app.trialIndex === 1 ? 1.4 : 1;
  const targetDE = selectDeltaE(app.post, cells, warmup);

  let stim = null;
  for (let attempt = 0; attempt < 4 && !stim; attempt++) {
    stim = makeStimulus(targetDE * (1 + attempt * 0.35), Math.random);
  }
  if (!stim) {
    // 极罕见：该强度在当前色域不可实现，跳过这一轮
    app.trialIndex++;
    startTrial();
    return;
  }

  const oddIndex = Math.floor(Math.random() * cells);
  app.current = { n, stim, targetDE, oddIndex, startAt: 0, answered: false };

  paintGrid(n, stim, oddIndex);
  renderStageMeta();
  setFeedback(`点出颜色不同的那 1 块 · 共 ${cells} 块`, 'info');

  app.phase = 'running';
  app.current.startAt = performance.now();
  el.timerFill.style.transform = 'scaleX(1)';
  el.timerText.textContent = `${(TRIAL_MS / 1000).toFixed(1)}s`;

  app.rafId = requestAnimationFrame(tick);
  // 后台标签页里 rAF 会暂停，这里补一个硬超时兜底
  app.hardTimeout = setTimeout(() => handleAnswer(-1, true), TRIAL_MS + 80);
}

function handleAnswer(picked, timedOut = false) {
  const cur = app.current;
  if (!cur || cur.answered || app.phase !== 'running') return;

  cur.answered = true;
  stopTimer();

  const rt = performance.now() - cur.startAt;
  const cells = cur.n * cur.n;
  const correct = !timedOut && picked === cur.oddIndex;

  updatePosterior(app.post, cur.stim.deltaE, cells, correct);
  app.sum = summarize(app.post);
  app.trials.push({ n: cur.n, de: cur.stim.deltaE, target: cur.targetDE, correct, rt, cells });

  paintResult(picked, cur.oddIndex, correct, timedOut);
  renderCharts();
  renderStats();

  const deText = `ΔE00 = ${fmtDE(cur.stim.deltaE)}`;
  if (timedOut) {
    setFeedback('超时了 —— 本轮记为未通过，难度回退', 'timeout', deText);
    sfx('timeout');
  } else if (correct) {
    setFeedback('正确', 'ok', deText);
    sfx('ok');
  } else {
    setFeedback('不是这一块 —— 白色描边的才是', 'bad', deText);
    sfx('bad');
  }

  app.phase = 'feedback';
  app.trialIndex++;

  const token = app.session;
  const delay = timedOut ? 1250 : correct ? 620 : 1180;
  setTimeout(() => {
    if (app.session !== token) return;
    app.phase = 'running';
    startTrial();
  }, delay);
}

/* ─────────────────────────────── 结算 ─────────────────────────────── */

function finish() {
  app.phase = 'done';
  app.session++;
  stopTimer();
  el.abortBtn.hidden = true;
  el.startBtn.disabled = false;
  el.startBtn.textContent = '再测一次';

  const trials = app.trials;
  const enough = trials.length >= MIN_TRIALS_TO_RECORD;

  if (!enough) {
    showNotice(
      trials.length === 0 ? '还没开始就结束了' : '数据太少，本次不计入纪录',
      trials.length === 0
        ? '你还没有完成任何一轮。'
        : `只完成了 ${trials.length} 轮，后验分布还基本停留在先验状态，给出的数字没有参考意义。至少要完成 ${MIN_TRIALS_TO_RECORD} 轮才会记录成绩。`,
    );
    sfx('bad');
    return;
  }

  const s = app.sum;
  const correctCount = trials.filter((t) => t.correct).length;
  const result = {
    id: String(Date.now()),
    date: new Date().toISOString(),
    median: s.median,
    lo68: s.lo68,
    hi68: s.hi68,
    lo90: s.lo90,
    hi90: s.hi90,
    t75: s.t75,
    t75Lo: s.t75Lo,
    t75Hi: s.t75Hi,
    sigma: s.sigma,
    accuracy: correctCount / trials.length,
    avgRt: trials.reduce((a, t) => a + t.rt, 0) / trials.length,
    totalMs: trials.reduce((a, t) => a + t.rt, 0),
    trials: trials.map((t) => ({ n: t.n, de: t.de, correct: t.correct, rt: Math.round(t.rt) })),
  };

  const { isRecord, prevBest } = store.submitResult(app.store, result);
  app.lastResult = result;
  renderRecordChip();
  showResults(result, isRecord, prevBest);
  sfx(isRecord ? 'record' : 'finish');
}

/* ─────────────────────────────── 弹层 ─────────────────────────────── */

function openModal(html) {
  el.modal.innerHTML = html;
  el.overlay.hidden = false;
  el.overlay.scrollTop = 0;
  el.modal.scrollTop = 0;
}

function closeModal() {
  el.overlay.hidden = true;
  el.modal.innerHTML = '';
}

function showNotice(title, body) {
  openModal(noticeModal({ title, body }));
  el.modal.querySelector('[data-act="start"]').onclick = () => {
    closeModal();
    startSession(app.rounds);
  };
  el.modal.querySelector('[data-act="close"]').onclick = closeModal;
}

function showIntro() {
  const best = app.store.best;
  const hist = app.store.history.slice(0, 12).map((h) => h.median).reverse();

  openModal(introModal({ best, rounds: app.rounds, quickRounds: QUICK_ROUNDS }));

  el.modal.querySelector('[data-act="start"]').onclick = () => {
    closeModal();
    startSession(app.rounds);
  };
  const quickBtn = el.modal.querySelector('[data-act="quick"]');
  if (quickBtn) {
    quickBtn.onclick = () => {
      closeModal();
      startSession(QUICK_ROUNDS);
    };
  }
  el.modal.querySelector('[data-act="close"]').onclick = () => {
    closeModal();
    setFeedback('准备就绪 · 点「开始测试」', 'idle');
  };

  if (best) drawSparkline($('introSpark'), hist);
}

function showResults(result, isRecord, prevBest) {
  const hist = app.store.history.slice(0, 12).map((h) => h.median).reverse();

  openModal(
    resultsModal({
      result,
      isRecord,
      prevBest,
      history: app.store.history,
      rounds: schedule.length,
    }),
  );

  drawPosterior($('resPosterior'), marginalTheta(app.post), app.sum);
  drawTrials($('resTrials'), app.trials, app.sum);
  drawSparkline($('resSpark'), hist);

  el.modal.querySelector('[data-act="again"]').onclick = () => {
    closeModal();
    startSession(app.rounds);
  };
  el.modal.querySelector('[data-act="close"]').onclick = () => {
    closeModal();
    setFeedback('准备就绪 · 点「再测一次」继续', 'idle');
  };
  el.modal.querySelector('[data-act="clear"]').onclick = () => {
    app.store = store.clearAll();
    renderRecordChip();
    el.modal.querySelector('[data-act="clear"]').textContent = '已清除';
    el.modal.querySelector('[data-act="clear"]').disabled = true;
  };
}

/* ─────────────────────────────── 事件绑定 ─────────────────────────────── */

el.grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || app.phase !== 'running') return;
  handleAnswer(Number(tile.dataset.index));
});

el.grid.addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || app.phase !== 'running') return;
  const n = app.current?.n ?? 0;
  if (!n) return;

  const i = Number(tile.dataset.index);
  const row = Math.floor(i / n);
  const col = i % n;
  let next = -1;

  switch (e.key) {
    case 'ArrowUp': next = row > 0 ? i - n : i; break;
    case 'ArrowDown': next = row < n - 1 ? i + n : i; break;
    case 'ArrowLeft': next = col > 0 ? i - 1 : i; break;
    case 'ArrowRight': next = col < n - 1 ? i + 1 : i; break;
    default: return;
  }
  e.preventDefault();
  el.grid.children[next]?.focus();
});

el.startBtn.addEventListener('click', () => {
  if (app.phase === 'idle' || app.phase === 'done') startSession();
});

el.abortBtn.addEventListener('click', () => {
  if (app.phase === 'running' || app.phase === 'feedback') finish();
});

el.soundBtn.addEventListener('click', () => {
  const on = !app.store.settings.sound;
  store.saveSettings(app.store, { sound: on });
  el.soundBtn.setAttribute('aria-pressed', String(on));
  el.soundIcon.textContent = on ? '🔊' : '🔇';
  if (on) sfx('ok');
});

window.addEventListener('resize', () => {
  renderCharts();
  if (!el.overlay.hidden) {
    const rp = $('resPosterior');
    const rt = $('resTrials');
    const rs = $('resSpark');
    if (rp) drawPosterior(rp, marginalTheta(app.post), app.sum);
    if (rt) drawTrials(rt, app.trials, app.sum);
    if (rs) drawSparkline(rs, app.store.history.slice(0, 12).map((h) => h.median).reverse());
  }
});

// 空格/回车在弹层里触发主按钮
window.addEventListener('keydown', (e) => {
  if (el.overlay.hidden) return;
  if (e.key === 'Escape') {
    const closeBtn = el.modal.querySelector('[data-act="close"]');
    if (closeBtn) closeBtn.click();
    return;
  }
  if (e.key !== 'Enter') return;
  const target = el.modal.querySelector('[data-act="start"], [data-act="again"]');
  if (target) {
    e.preventDefault();
    target.click();
  }
});

/* ─────────────────────────────── 启动 ─────────────────────────────── */

function boot() {
  app.store = store.load();
  el.soundBtn.setAttribute('aria-pressed', String(app.store.settings.sound));
  el.soundIcon.textContent = app.store.settings.sound ? '🔊' : '🔇';

  renderRecordChip();
  renderStageMeta();
  renderStats();
  renderCharts();
  showIntro();
}

boot();
