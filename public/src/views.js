/**
 * 视图层：把状态渲染成 HTML 字符串的纯函数。
 *
 * 这里刻意不碰 DOM —— 只接收数据、返回字符串，
 * 因此可以在 Node 里直接测试（见 tools/smoke-test.mjs），
 * 不必为了验证"结果页显示对了没有"而真的把游戏打完。
 */

/* ─────────────────────────────── 格式化 ─────────────────────────────── */

export const fmtDE = (v) =>
  !Number.isFinite(v) ? '—' : v >= 1 ? v.toFixed(2) : v.toFixed(3);

export const fmtPct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

export const fmtSecs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '—');

export const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 评级：按 50% 检测阈的中值 ΔE00 分档 */
export function gradeOf(median) {
  if (median <= 1.0) return { grade: 'S', label: '极佳', note: '色差辨别力处于极高水平' };
  if (median <= 2.0) return { grade: 'A', label: '优秀', note: '优于大多数普通显示器使用者' };
  if (median <= 4.0) return { grade: 'B', label: '良好', note: '日常使用与一般设计工作完全够用' };
  if (median <= 8.0) return { grade: 'C', label: '中等', note: '精细调色场景可能会感到吃力' };
  if (median <= 15) return { grade: 'D', label: '偏低', note: '建议在更好光照与显示器下复测' };
  return { grade: 'E', label: '需留意', note: '若多次复测均如此，建议做专业色觉检查' };
}

/* ─────────────────────────────── 开场 ─────────────────────────────── */

export function introModal({ best, rounds, quickRounds }) {
  const minutes = Math.max(1, Math.round((rounds * 9) / 60));
  const showQuick = rounds !== quickRounds;

  return `
    <h2>色觉鉴别能力测试</h2>
    <p class="lede">
      在一堆同色色块里找出唯一不同的那一个。阵列从 <b>2 × 2</b> 逐步加码到 <b>9 × 9</b>，
      每答一轮，程序都会用贝叶斯方法收窄对「你最小能分辨多小的色差（ΔE<sub>00</sub>）」的估计。
    </p>
    <ol class="rules">
      <li><span class="n">1</span><span>每轮限时 <b>30 秒</b>。超时按答错处理，难度会往回退一格。</span></li>
      <li><span class="n">2</span><span>答错不要紧 —— 阈值测试本来就要在"猜不准"的边界上反复试探，才能把误差范围压小。</span></li>
      <li><span class="n">3</span><span>共 ${rounds} 轮，约 ${minutes} 分钟。全部完成后给出<b>中值 ΔE<sub>00</sub></b> 与 <b>68% / 90% 可信区间</b>。</span></li>
      <li><span class="n">4</span><span>成绩保存在本机浏览器里，<b>刷新或关机都不会丢</b>，只与你自己比较。</span></li>
    </ol>
    ${
      best
        ? `<div class="chart-box">
             <h3>本机纪录：中值 ΔE<sub>00</sub> = ${fmtDE(best.median)}（越低越好）</h3>
             <canvas id="introSpark"></canvas>
           </div>`
        : ''
    }
    <div class="actions">
      <button class="btn primary" data-act="start">开始测试（${rounds} 轮）</button>
      ${showQuick ? `<button class="btn" data-act="quick">快速测试（${quickRounds} 轮）</button>` : ''}
      <button class="btn ghost" data-act="close">先看看</button>
    </div>
    <p class="disclaimer">
      提示：请在光线柔和的室内、把屏幕亮度调到舒适的水平，并尽量关掉夜间模式 / 护眼模式
      （它们会改变实际呈现的颜色）。测试结果反映的是<b>你这块屏幕 + 这双眼睛</b>的综合表现，
      不能作为医学诊断依据。轮数越少，可信区间越宽；想挑战更精确的估计就用完整轮数。
    </p>
  `;
}

/* ─────────────────────────────── 提示 ─────────────────────────────── */

export function noticeModal({ title, body }) {
  return `
    <h2>${title}</h2>
    <p class="lede">${body}</p>
    <div class="actions">
      <button class="btn primary" data-act="start">重新开始</button>
      <button class="btn" data-act="close">关闭</button>
    </div>
  `;
}

/* ─────────────────────────────── 结果 ─────────────────────────────── */

/** 按阵列规模汇总正确率 */
export function breakdownBySize(trials) {
  const bySize = new Map();
  for (const t of trials) {
    const rec = bySize.get(t.n) || { n: t.n, total: 0, ok: 0 };
    rec.total++;
    if (t.correct) rec.ok++;
    bySize.set(t.n, rec);
  }
  return [...bySize.values()].sort((a, b) => a.n - b.n);
}

export function resultsModal({ result, isRecord, prevBest, history, rounds }) {
  const g = gradeOf(result.median);

  const rows = breakdownBySize(result.trials)
    .map(
      (r) =>
        `<tr><td>${r.n} × ${r.n}</td><td>${r.ok} / ${r.total}</td><td>${fmtPct(r.ok / r.total)}</td></tr>`,
    )
    .join('');

  const historyRows = history
    .slice(0, 8)
    .map(
      (h) => `<div class="history-row">
           <span class="when">${fmtDateTime(h.date)}</span>
           <span>${h.trials.length} 轮</span>
           <span class="val">${fmtDE(h.median)}</span>
         </div>`,
    )
    .join('');

  return `
    <div class="verdict">
      <div class="cap">你的最小可鉴别色差（后验中值）</div>
      <div class="big-de">${fmtDE(result.median)}<small> ΔE<sub>00</sub></small></div>
      <div class="range-line">误差范围（68% 可信区间） <em>${fmtDE(result.lo68)} – ${fmtDE(result.hi68)}</em></div>
      <div class="badge-row">
        ${isRecord ? '<span class="badge gold">🏆 刷新本机纪录</span>' : ''}
        <span class="badge grade">评级 ${g.grade} · ${g.label}</span>
        <span class="badge">${g.note}</span>
      </div>
    </div>

    <div class="result-grid">
      <div class="cell"><label>90% 可信区间</label><b>${fmtDE(result.lo90)} – ${fmtDE(result.hi90)}</b></div>
      <div class="cell"><label>75% 正确率对应</label><b>${fmtDE(result.t75)}</b></div>
      <div class="cell"><label>正确率</label><b>${fmtPct(result.accuracy)}</b></div>
      <div class="cell"><label>平均反应</label><b>${fmtSecs(result.avgRt)}</b></div>
      <div class="cell"><label>完成轮数</label><b>${result.trials.length} / ${rounds}</b></div>
      <div class="cell"><label>心理测量陡度 σ</label><b>${result.sigma.toFixed(2)}</b></div>
    </div>

    <div class="chart-box">
      <h3>最终后验分布</h3>
      <canvas id="resPosterior"></canvas>
    </div>

    <div class="chart-box">
      <h3>逐轮阶梯（绿=答对，红=答错）</h3>
      <canvas id="resTrials"></canvas>
    </div>

    <div class="chart-box">
      <h3>各阵列规模的表现</h3>
      <table class="breakdown">
        <thead><tr><th>阵列</th><th>答对</th><th>正确率</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="chart-box">
      <h3>本机历史成绩（中值 ΔE<sub>00</sub>，越低越好）</h3>
      ${prevBest && isRecord ? `<p class="hint" style="margin-bottom:8px">上一次纪录：${fmtDE(prevBest.median)}</p>` : ''}
      <canvas id="resSpark"></canvas>
      <div class="history-list">${historyRows}</div>
    </div>

    <div class="actions">
      <button class="btn primary" data-act="again">再测一次</button>
      <button class="btn" data-act="close">关闭</button>
      <button class="btn ghost" data-act="clear">清除本机纪录</button>
    </div>

    <p class="disclaimer">
      ΔE<sub>00</sub> 为 CIEDE2000 色差。这里报告的是"50% 检测正确率"对应的阈值，
      已按每种阵列规模的猜测概率（1/N²）做了校正。数值受显示器色彩空间、亮度、环境光与色觉适应影响，
      换台机器数字会变。本测试仅供自我参考，不能替代医学色觉检查。
    </p>
  `;
}
