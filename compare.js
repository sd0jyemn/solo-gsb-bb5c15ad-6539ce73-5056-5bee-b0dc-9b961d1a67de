'use strict';

// ---------------------------------------------------------------------------
// 场次对比（只读）模块
//
// 基于 replay.js 的只读解析结果，对两个已结束场次生成逐口令对照表：
//   1) 匹配键：规范化口令文本（去首尾空白、连续空白折叠为单个空格）
//      + 排序去重后的目标岗位，二者共同唯一标识一条口令；
//   2) 序列对齐：动态规划（LCS 变体），保持原顺序，先最大化匹配对数；
//      重复键出现多种最优解时，依次按「总序号偏移最小」「左场序号优先」裁决，
//      三项评判仍完全并列时按固定分支优先级（匹配 > 跳过右场 > 跳过左场）
//      保证结果唯一确定；
//   3) 逐项统计：从口令开始（首次 cue-started）到完成（cue-completed）的耗时，
//      以及超时 / 迟到确认 / 修订 / 暂停次数，并给出两场差值（右场 − 左场）。
//
// 只读保证：仅通过 replay.getSession 读取历史日志解析结果，绝不打开写流、
// 绝不追加/修改事件日志，也绝不引用 server.js 中当前演出的内存状态。
// ---------------------------------------------------------------------------

const replay = require('./replay');

// 规范化口令文本：去首尾空白，连续空白折叠为单个空格
function normalizeText(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
}

// 规范化目标岗位：去空白、去重、按码元排序（与编排顺序无关，同一组岗位必得同一结果）
function normalizeTargets(targets) {
  const list = Array.isArray(targets) ? targets : [];
  return [...new Set(list.map((t) => String(t == null ? '' : t).trim()).filter(Boolean))].sort();
}

// 匹配键：规范化口令文本 + 排序后的目标岗位
function cueKey(cue) {
  return JSON.stringify([normalizeText(cue && cue.text), normalizeTargets(cue && cue.targets)]);
}

// 从单场事件流统计每个口令（按 seq）的复盘指标。
// 耗时起点为首次 cue-started（修订重发不重置起点），终点为 cue-completed。
function cueStats(events) {
  const stats = new Map(); // seq -> { seq, startedT, completedT, durationMs, timeouts, lateConfirms, revisions, pauses }
  const ensure = (seq) => {
    if (!stats.has(seq)) {
      stats.set(seq, {
        seq,
        startedT: null,
        completedT: null,
        durationMs: null,
        timeouts: 0,
        lateConfirms: 0,
        revisions: 0,
        pauses: 0,
      });
    }
    return stats.get(seq);
  };
  for (const ev of events || []) {
    const d = ev.detail || {};
    const seq = Number(d.seq);
    if (!Number.isInteger(seq) || seq <= 0) continue;
    const st = ensure(seq);
    switch (ev.event) {
      case 'cue-started':
        if (st.startedT === null) st.startedT = ev.t;
        break;
      case 'cue-completed':
        if (st.completedT === null) st.completedT = ev.t;
        break;
      case 'cue-timeout':
        st.timeouts += 1;
        break;
      case 'confirm-late':
        st.lateConfirms += 1;
        break;
      case 'cue-recalled':
        st.revisions += 1;
        break;
      case 'cue-paused':
        st.pauses += 1;
        break;
      default:
        break;
    }
  }
  for (const st of stats.values()) {
    if (st.startedT !== null && st.completedT !== null) {
      st.durationMs = st.completedT - st.startedT;
    }
  }
  return stats;
}

// 动态规划序列对齐（保持原顺序）。
// leftCues / rightCues：带 seq 与 key 的口令数组（按各自场次序号升序）。
// 返回行序列：[{ type: 'match' | 'added' | 'removed', left, right }]，
// left / right 为各自数组下标（无则 null）；added = 仅右场有，removed = 仅左场有。
function alignCues(leftCues, rightCues) {
  const n = leftCues.length;
  const m = rightCues.length;
  // dp[i][j]：对齐 left[i..] 与 right[j..] 的最优值 { matches, offset, leftSum, via }
  //   matches —— 匹配对数（越多越好）
  //   offset  —— 匹配对的总序号偏移 Σ|seqL − seqR|（越少越好）
  //   leftSum —— 匹配对的左场序号和（越少越好，即左场序号优先）
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][m] = { matches: 0, offset: 0, leftSum: 0, via: null };
  for (let j = 0; j <= m; j++) dp[n][j] = { matches: 0, offset: 0, leftSum: 0, via: null };

  // a 优于 b 返回正数，并列返回 0：匹配对数 → 总序号偏移 → 左场序号和
  const cmp = (a, b) => {
    if (a.matches !== b.matches) return a.matches - b.matches;
    if (a.offset !== b.offset) return b.offset - a.offset;
    return b.leftSum - a.leftSum;
  };

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      // 分支优先级（仅在三项评判完全并列时生效）：匹配 > 跳过右场 > 跳过左场，
      // 按逆序评估、并列即替换，保证任何输入都有唯一确定的对齐结果
      let best = { ...dp[i + 1][j], via: 'skipL' };
      const skipR = { ...dp[i][j + 1], via: 'skipR' };
      if (cmp(skipR, best) >= 0) best = skipR;
      if (leftCues[i].key === rightCues[j].key) {
        const sub = dp[i + 1][j + 1];
        const match = {
          matches: sub.matches + 1,
          offset: sub.offset + Math.abs(leftCues[i].seq - rightCues[j].seq),
          leftSum: sub.leftSum + leftCues[i].seq,
          via: 'match',
        };
        if (cmp(match, best) >= 0) best = match;
      }
      dp[i][j] = best;
    }
  }

  // 回溯最优路径，按路径顺序产出对照行（跳过左场 = 删除，跳过右场 = 新增）
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const via = dp[i][j].via;
    if (via === 'match') {
      rows.push({ type: 'match', left: i, right: j });
      i++;
      j++;
    } else if (via === 'skipR') {
      rows.push({ type: 'added', left: null, right: j });
      j++;
    } else {
      rows.push({ type: 'removed', left: i, right: null });
      i++;
    }
  }
  while (i < n) rows.push({ type: 'removed', left: i++, right: null });
  while (j < m) rows.push({ type: 'added', left: null, right: j++ });
  return rows;
}

// 单条口令的对照视图（附复盘指标）
function cueView(cue, stats) {
  const st = stats.get(cue.seq) || {};
  return {
    seq: cue.seq,
    text: cue.text,
    targets: cue.targets,
    startedT: st.startedT != null ? st.startedT : null, // 相对本场起点的毫秒偏移（复盘跳转用）
    completedT: st.completedT != null ? st.completedT : null,
    durationMs: st.durationMs != null ? st.durationMs : null,
    timeouts: st.timeouts || 0,
    lateConfirms: st.lateConfirms || 0,
    revisions: st.revisions || 0,
    pauses: st.pauses || 0,
  };
}

// 两场差值（右场 − 左场）；任一侧缺数据时为 null
function metricDelta(l, r) {
  const diff = (a, b) => (a == null || b == null ? null : b - a);
  return {
    durationMs: diff(l.durationMs, r.durationMs),
    timeouts: r.timeouts - l.timeouts,
    lateConfirms: r.lateConfirms - l.lateConfirms,
    revisions: r.revisions - l.revisions,
    pauses: r.pauses - l.pauses,
  };
}

// 对比两个已结束场次：fileId / runId 校验与日志读取全部复用 replay 模块（只读）
function compareSessions(dataDir, leftFileId, leftRunId, rightFileId, rightRunId) {
  const left = replay.getSession(dataDir, leftFileId, leftRunId);
  if (left.error) return { error: left.error, side: 'left', message: left.message };
  const right = replay.getSession(dataDir, rightFileId, rightRunId);
  if (right.error) return { error: right.error, side: 'right', message: right.message };

  const leftStats = cueStats(left.events);
  const rightStats = cueStats(right.events);

  // 匹配键取自各场冻结序列（首次 cue-started 的口令文本与目标岗位）
  const leftKeyed = left.sequence.map((c) => ({ seq: c.seq, key: cueKey(c) }));
  const rightKeyed = right.sequence.map((c) => ({ seq: c.seq, key: cueKey(c) }));
  const aligned = alignCues(leftKeyed, rightKeyed);

  const rows = aligned.map((row) => {
    const l = row.left == null ? null : cueView(left.sequence[row.left], leftStats);
    const r = row.right == null ? null : cueView(right.sequence[row.right], rightStats);
    return { type: row.type, left: l, right: r, delta: l && r ? metricDelta(l, r) : null };
  });

  const summary = { matched: 0, added: 0, removed: 0 };
  rows.forEach((row) => {
    if (row.type === 'match') summary.matched += 1;
    else if (row.type === 'added') summary.added += 1;
    else summary.removed += 1;
  });

  const sideOf = (s) => ({
    fileId: s.session.fileId,
    runId: s.session.runId,
    startedAt: s.session.startedAt,
    finishedAt: s.session.finishedAt,
    durationMs: s.session.durationMs,
    cueCount: s.session.cueCount,
    timeoutSec: s.timeoutSec,
  });

  return { left: sideOf(left), right: sideOf(right), rows, summary };
}

module.exports = {
  normalizeText,
  normalizeTargets,
  cueKey,
  cueStats,
  alignCues,
  compareSessions,
};
