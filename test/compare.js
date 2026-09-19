/* 场次对比模块测试：匹配键构造、动态规划对齐（含重复键平局裁决）、
 * 逐项统计、端到端对比与只读 HTTP 接口。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 解析/对齐/统计部分直接调用 compare.js；HTTP 接口部分对真实 data 目录断言，
 * 并校验对比前后 data 目录文件清单不变（只读，不落盘、不写日志）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const compare = require('../compare');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 构造带匹配键的口令序列：[[文本, [目标...]], ...] → [{ seq, key }]
function keyed(list) {
  return list.map(([text, targets], i) => ({
    seq: i + 1,
    key: compare.cueKey({ text, targets }),
  }));
}

const LEFT_ID = '11111111-1111-1111-1111-111111111111';
const RIGHT_ID = '22222222-2222-2222-2222-222222222222';
const T0 = Date.parse('2026-09-19T12:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const ev = (offsetMs, event, detail) => JSON.stringify({ ts: iso(offsetMs), event, detail });

// 左场（基准）：4 条口令，含暂停、超时 + 迟到确认、一次修订
function writeLeftLog(dir) {
  const lines = [
    ev(-1000, 'sequence-set', { version: 1, count: 4, timeoutSec: 5, cues: [
      { seq: 1, text: '灯光渐暗', targets: ['灯光'] },
      { seq: 2, text: '音乐起', targets: ['音响', '道具'] },
      { seq: 3, text: '全场亮灯', targets: ['灯光', '音响'] },
      { seq: 4, text: '备用口令', targets: ['灯光'] },
    ] }),
    ev(0, 'session-start', {}),
    ev(100, 'cue-started', { seq: 1, text: '灯光渐暗', targets: ['灯光'], revision: 1, attemptId: 'l1' }),
    ev(200, 'cue-paused', { seq: 1, reason: '设备调试' }),
    ev(300, 'cue-resumed', { seq: 1 }),
    ev(400, 'confirm', { seq: 1, position: '灯光' }),
    ev(1100, 'cue-completed', { seq: 1 }),
    ev(1100, 'cue-started', { seq: 2, text: '音乐起', targets: ['音响', '道具'], revision: 1, attemptId: 'l2' }),
    ev(6100, 'cue-timeout', { seq: 2, missing: ['道具'] }),
    ev(6200, 'confirm-late', { seq: 2, position: '道具' }),
    ev(6300, 'confirm', { seq: 2, position: '音响' }),
    ev(6300, 'cue-completed', { seq: 2 }),
    ev(6300, 'cue-started', { seq: 3, text: '全场亮灯', targets: ['灯光', '音响'], revision: 1, attemptId: 'l3' }),
    ev(6400, 'cue-recalled', { seq: 3, oldRevision: 1, newRevision: 2, reason: '措辞修正', newText: '全场亮灯' }),
    ev(6400, 'cue-resent', { seq: 3, text: '全场亮灯', revision: 2, attemptId: 'l3b' }),
    ev(6500, 'confirm', { seq: 3, position: '灯光' }),
    ev(6600, 'confirm', { seq: 3, position: '音响' }),
    ev(6600, 'cue-completed', { seq: 3 }),
    ev(6600, 'cue-started', { seq: 4, text: '备用口令', targets: ['灯光'], revision: 1, attemptId: 'l4' }),
    ev(6700, 'confirm', { seq: 4, position: '灯光' }),
    ev(6700, 'cue-completed', { seq: 4 }),
    ev(6700, 'sequence-finished', {}),
  ];
  fs.writeFileSync(path.join(dir, `events-${LEFT_ID}.jsonl`), lines.join('\n') + '\n');
}

// 右场（对照）：目标岗位顺序不同、口令文本含多余空白（规范化后应匹配），
// 新增「谢幕」，没有「备用口令」，第 4 条两次修订
function writeRightLog(dir) {
  const lines = [
    ev(-1000, 'sequence-set', { version: 1, count: 4, timeoutSec: 10, cues: [
      { seq: 1, text: '灯光渐暗', targets: ['灯光'] },
      { seq: 2, text: '音乐起', targets: ['道具', '音响'] },
      { seq: 3, text: '谢幕', targets: ['全体'] },
      { seq: 4, text: ' 全场亮灯 ', targets: ['音响', '灯光'] },
    ] }),
    ev(0, 'session-start', {}),
    ev(100, 'cue-started', { seq: 1, text: '灯光渐暗', targets: ['灯光'], revision: 1, attemptId: 'r1' }),
    ev(500, 'confirm', { seq: 1, position: '灯光' }),
    ev(600, 'cue-completed', { seq: 1 }),
    ev(600, 'cue-started', { seq: 2, text: '音乐起', targets: ['道具', '音响'], revision: 1, attemptId: 'r2' }),
    ev(700, 'confirm', { seq: 2, position: '道具' }),
    ev(800, 'confirm', { seq: 2, position: '音响' }),
    ev(800, 'cue-completed', { seq: 2 }),
    ev(800, 'cue-started', { seq: 3, text: '谢幕', targets: ['全体'], revision: 1, attemptId: 'r3' }),
    ev(900, 'confirm', { seq: 3, position: '全体' }),
    ev(900, 'cue-completed', { seq: 3 }),
    ev(900, 'cue-started', { seq: 4, text: ' 全场亮灯 ', targets: ['音响', '灯光'], revision: 1, attemptId: 'r4' }),
    ev(1000, 'cue-recalled', { seq: 4, oldRevision: 1, newRevision: 2, reason: '修正', newText: ' 全场亮灯 ' }),
    ev(1000, 'cue-resent', { seq: 4, text: ' 全场亮灯 ', revision: 2, attemptId: 'r4b' }),
    ev(1100, 'cue-recalled', { seq: 4, oldRevision: 2, newRevision: 3, reason: '再修正', newText: ' 全场亮灯 ' }),
    ev(1100, 'cue-resent', { seq: 4, text: ' 全场亮灯 ', revision: 3, attemptId: 'r4c' }),
    ev(1200, 'confirm', { seq: 4, position: '音响' }),
    ev(1300, 'confirm', { seq: 4, position: '灯光' }),
    ev(1300, 'cue-completed', { seq: 4 }),
    ev(1300, 'sequence-finished', {}),
  ];
  fs.writeFileSync(path.join(dir, `events-${RIGHT_ID}.jsonl`), lines.join('\n') + '\n');
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('一、匹配键：规范化口令文本 + 排序后的目标岗位');
  check('规范化文本：去首尾空白并折叠连续空白',
    compare.normalizeText('  灯光  渐暗\t') === '灯光 渐暗');
  check('目标岗位顺序不影响匹配键',
    compare.cueKey({ text: 'a', targets: ['灯光', '音响'] }) ===
    compare.cueKey({ text: 'a', targets: ['音响', '灯光'] }));
  check('口令文本不同则键不同',
    compare.cueKey({ text: 'a', targets: ['灯光'] }) !==
    compare.cueKey({ text: 'b', targets: ['灯光'] }));
  check('目标岗位不同则键不同',
    compare.cueKey({ text: 'a', targets: ['灯光'] }) !==
    compare.cueKey({ text: 'a', targets: ['音响'] }));
  check('空白与重复目标规范化后键相同',
    compare.cueKey({ text: ' 全场  亮灯 ', targets: ['音响', '灯光', '音响'] }) ===
    compare.cueKey({ text: '全场 亮灯', targets: ['灯光', '音响'] }));

  console.log('二、动态规划对齐：保持原顺序，重复键按规则裁决');
  const rowsOf = (l, r) => compare.alignCues(keyed(l), keyed(r));
  const A = ['口令A', ['甲']], B = ['口令B', ['乙']], C = ['口令C', ['丙']];

  const same = rowsOf([A, B], [A, B]);
  check('完全相同：全部匹配且按序号一一对应',
    same.length === 2 && same.every((r, i) => r.type === 'match' && r.left === i && r.right === i));

  const added = rowsOf([A, B], [A, C, B]);
  check('新增：仅右场有的口令标为 added 且保持原顺序',
    added.length === 3 && added[0].type === 'match' &&
    added[1].type === 'added' && added[1].right === 1 &&
    added[2].type === 'match' && added[2].left === 1 && added[2].right === 2);

  const removed = rowsOf([A, C, B], [A, B]);
  check('删除：仅左场有的口令标为 removed 且保持原顺序',
    removed.length === 3 && removed[0].type === 'match' &&
    removed[1].type === 'removed' && removed[1].left === 1 &&
    removed[2].type === 'match' && removed[2].left === 2 && removed[2].right === 1);

  // L=[A,B,C] R=[B,A,C]：{A,C} 与 {B,C} 匹配对数与总偏移都相同，左场序号优先 → 选 {A,C}
  const swapped = rowsOf([A, B, C], [B, A, C]);
  check('平局时左场序号优先（匹配 A、C 而非 B、C），顺序不交叉',
    swapped.length === 4 &&
    swapped[0].type === 'added' && swapped[0].right === 0 &&
    swapped[1].type === 'match' && swapped[1].left === 0 && swapped[1].right === 1 &&
    swapped[2].type === 'removed' && swapped[2].left === 1 &&
    swapped[3].type === 'match' && swapped[3].left === 2 && swapped[3].right === 2);

  // L=[K,K](序号1,2) R=[X,X,X,X,K](K 在序号5)：偏移最小（|2−5|=3 < |1−5|=4）优先于左场序号
  const K = ['相同口令', ['甲']];
  const X = (i) => [`其他${i}`, ['乙']];
  const offsetFirst = rowsOf([K, K], [X(1), X(2), X(3), X(4), K]);
  const offsetMatch = offsetFirst.find((r) => r.type === 'match');
  check('总序号偏移最小优先：重复键匹配左场序号 2（偏移 3 而非 4）',
    offsetFirst.length === 6 && offsetMatch && offsetMatch.left === 1 && offsetMatch.right === 4);

  // L=[K,Y,K](K 在序号1,3) R=[Z,K](K 在序号2)：两侧偏移都是 1，左场序号优先 → 匹配左场序号 1
  const leftFirst = rowsOf([K, ['夹缝', ['丙']], K], [['垫场', ['丁']], K]);
  const leftFirstMatch = leftFirst.find((r) => r.type === 'match');
  check('偏移相同时左场序号优先：匹配左场序号 1 而非 3',
    leftFirstMatch && leftFirstMatch.left === 0 && leftFirstMatch.right === 1 &&
    leftFirst.filter((r) => r.type === 'removed').length === 2);

  const dup = rowsOf([K, K], [K, K]);
  check('重复键完全一致时按序号顺序配对',
    dup.length === 2 && dup.every((r, i) => r.type === 'match' && r.left === i && r.right === i));

  console.log('三、逐项统计：耗时 / 超时 / 迟到确认 / 修订 / 暂停');
  const stats = compare.cueStats([
    { event: 'session-start', detail: {}, t: 0 },
    { event: 'cue-started', detail: { seq: 1 }, t: 100 },
    { event: 'cue-paused', detail: { seq: 1 }, t: 200 },
    { event: 'cue-resumed', detail: { seq: 1 }, t: 300 },
    { event: 'cue-recalled', detail: { seq: 1 }, t: 400 },
    { event: 'cue-resent', detail: { seq: 1 }, t: 400 },
    { event: 'cue-timeout', detail: { seq: 1 }, t: 500 },
    { event: 'confirm-late', detail: { seq: 1 }, t: 600 },
    { event: 'cue-completed', detail: { seq: 1 }, t: 1100 },
    { event: 'cue-started', detail: { seq: 2 }, t: 1100 },
    { event: 'cue-completed', detail: { seq: 2 }, t: 2100 },
    { event: 'sequence-finished', detail: {}, t: 2100 },
  ]);
  const s1 = stats.get(1);
  check('口令 1：耗时 1000ms（首次发出→完成），超时/迟到/修订/暂停各 1 次',
    s1 && s1.durationMs === 1000 && s1.timeouts === 1 && s1.lateConfirms === 1 &&
    s1.revisions === 1 && s1.pauses === 1 && s1.startedT === 100 && s1.completedT === 1100);
  const s2 = stats.get(2);
  check('口令 2：耗时 1000ms，各项计数为 0',
    s2 && s2.durationMs === 1000 && s2.timeouts === 0 && s2.lateConfirms === 0 &&
    s2.revisions === 0 && s2.pauses === 0);

  console.log('四、端到端对比：两个已结束场次生成逐口令对照表');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-compare-'));
  writeLeftLog(dir);
  writeRightLog(dir);
  const cmp = compare.compareSessions(dir, LEFT_ID, '0', RIGHT_ID, '0');
  check('行序列：匹配、匹配、新增、匹配、删除（保持原顺序）',
    cmp.rows.length === 5 &&
    cmp.rows.map((r) => r.type).join(',') === 'match,match,added,match,removed');
  check('汇总：匹配 3 · 新增 1 · 删除 1',
    cmp.summary.matched === 3 && cmp.summary.added === 1 && cmp.summary.removed === 1);
  const m1 = cmp.rows[0];
  check('匹配 1（灯光渐暗）：耗时 1000→500（差 -500），暂停 1→0（差 -1）',
    m1.left.durationMs === 1000 && m1.right.durationMs === 500 && m1.delta.durationMs === -500 &&
    m1.left.pauses === 1 && m1.right.pauses === 0 && m1.delta.pauses === -1);
  const m2 = cmp.rows[1];
  check('匹配 2（音乐起，目标顺序不同仍匹配）：超时/迟到 1→0（差 -1），耗时 5200→200（差 -5000）',
    m2.left.seq === 2 && m2.right.seq === 2 &&
    m2.delta.timeouts === -1 && m2.delta.lateConfirms === -1 && m2.delta.durationMs === -5000);
  const addRow = cmp.rows[2];
  check('新增行：仅右场有的「谢幕」（左场为空、无差值）',
    addRow.left === null && addRow.right.seq === 3 && addRow.right.text === '谢幕' && addRow.delta === null);
  const m3 = cmp.rows[3];
  check('匹配 3（全场亮灯，多余空白规范化后匹配）：修订 1→2（差 +1），耗时 300→400（差 +100）',
    m3.left.seq === 3 && m3.right.seq === 4 &&
    m3.delta.revisions === 1 && m3.delta.durationMs === 100);
  const delRow = cmp.rows[4];
  check('删除行：仅左场有的「备用口令」（右场为空）',
    delRow.right === null && delRow.left.seq === 4 && delRow.left.text === '备用口令');
  check('两侧场次摘要随结果返回（开始时间 / 口令数 / 确认时限）',
    cmp.left.cueCount === 4 && cmp.right.cueCount === 4 &&
    cmp.left.timeoutSec === 5 && cmp.right.timeoutSec === 10);
  check('非法 fileId 被拒（badId）',
    compare.compareSessions(dir, '../etc', '0', RIGHT_ID, '0').error === 'badId');
  check('不存在的场次返回 notFound',
    compare.compareSessions(dir, LEFT_ID, '9', RIGHT_ID, '0').error === 'notFound');

  console.log('五、HTTP 接口（只读）');
  const dataFilesBefore = fs.readdirSync(path.join(__dirname, '..', 'data')).sort();
  const apiList = await httpGet('/api/replay/sessions');
  check('GET /api/replay/sessions 200（对比页复用同一场次列表）',
    apiList.status === 200 && Array.isArray(apiList.json.sessions));
  if (apiList.json.sessions.length) {
    const s0 = apiList.json.sessions[0];
    const self = await httpGet(`/api/compare/${s0.fileId}/${s0.runId}/${s0.fileId}/${s0.runId}`);
    check('同场自对比 200：全部匹配、无新增删除',
      self.status === 200 && self.json.summary.matched === s0.cueCount &&
      self.json.summary.added === 0 && self.json.summary.removed === 0);
    check('同场自对比：每行差值全为 0',
      self.json.rows.every((r) => r.type === 'match' && r.delta.durationMs === 0 &&
        r.delta.timeouts === 0 && r.delta.lateConfirms === 0 &&
        r.delta.revisions === 0 && r.delta.pauses === 0));
  }
  if (apiList.json.sessions.length >= 2) {
    const [s0, s1] = apiList.json.sessions;
    const two = await httpGet(`/api/compare/${s0.fileId}/${s0.runId}/${s1.fileId}/${s1.runId}`);
    check('两不同场次对比 200：行数 = 匹配 + 新增 + 删除，且行类型合法',
      two.status === 200 &&
      two.json.rows.length === two.json.summary.matched + two.json.summary.added + two.json.summary.removed &&
      two.json.rows.every((r) => ['match', 'added', 'removed'].includes(r.type)));
  }
  const bad = await httpGet('/api/compare/not-a-uuid/0/also-not-a-uuid/0');
  check('非法场次 ID 返回 400', bad.status === 400);
  const missing = await httpGet(
    '/api/compare/99999999-9999-9999-9999-999999999999/0/99999999-9999-9999-9999-999999999999/0');
  check('不存在场次返回 404', missing.status === 404);
  const dataFilesAfter = fs.readdirSync(path.join(__dirname, '..', 'data')).sort();
  check('对比接口只读：data 目录文件清单不变（不写日志、不落盘）',
    JSON.stringify(dataFilesBefore) === JSON.stringify(dataFilesAfter));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
