const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
const settle = () => new Promise(setImmediate);
const idleBatch = { running: false, phase: null, completed: 0, skipped: 0, reason: null };
const validStatus = { ok: true, total: 2, required: 2, answered: 0, answeredTotal: 0, matched: 1, matchedTotal: 1, unmatchedTitles: ['其他'], readonly: false, batch: idleBatch };

async function makePopup({ status = validStatus, action = async () => ({ ok: true, filled: 1, submitted: false }), query } = {}) {
  const elements = Object.fromEntries(['status', 'unmatched', 'preview', 'apply', 'refill', 'clear', 'autosubmit', 'msg', 'settings', 'counter', 'progress', 'coverage', 'preset-name', 'preset-values', 'preset-caption', 'batch', 'stop-batch', 'batch-state']
    .map(id => [id, { checked: false, disabled: false, textContent: '', className: '' }]));
  const messages = [];
  const intervals = [];
  let currentStatus = status;
  let settingsOpened = 0;
  const chrome = {
    tabs: {
      query: query || (async () => [{ id: 1 }]),
      sendMessage: async (tabId, msg) => {
        messages.push(msg);
        return msg.type === 'GET_STATUS' ? (typeof currentStatus === 'function' ? currentStatus() : currentStatus) : action(msg, next => { currentStatus = next; });
      }
    },
    runtime: { openOptionsPage: async () => { settingsOpened++; } }
  };
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] },
    chrome,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return 1; }
  });
  await settle();
  return { elements, messages, intervals, settingsOpened: () => settingsOpened, setStatus: next => { currentStatus = next; } };
}

test('每次应用显式传递自动提交选择，重开 popup 后恢复默认不提交', async () => {
  const first = await makePopup();
  first.elements.autosubmit.checked = true;
  await first.elements.apply.onclick();
  assert.equal(first.messages.find(m => m.type === 'APPLY').autoSubmit, true);
  assert.equal(first.messages.find(m => m.type === 'APPLY').overwrite, false);
  assert.equal(first.elements.autosubmit.checked, false);
  assert.equal(first.messages.some(m => m.type === 'SET_AUTOSUBMIT'), false);
  const reopened = await makePopup();
  await reopened.elements.apply.onclick();
  assert.equal(reopened.messages.find(m => m.type === 'APPLY').autoSubmit, false);
});

test('重填为明确覆盖操作，完成进度显示实际已答数', async () => {
  const popup = await makePopup({ status: { ...validStatus, answered: 2, answeredTotal: 2 }, action: async () => ({ ok: true, required: 2, answered: 2, filled: 2 }) });
  await popup.elements.refill.onclick();
  assert.equal(popup.messages.find(m => m.type === 'APPLY').overwrite, true);
  assert.equal(popup.elements.counter.textContent, '2/2');
  assert.equal(popup.elements.progress.value, 2);
  assert.match(popup.elements.msg.textContent, /已填满 2\/2/);
});

test('用户自定义规则时不再显示固定默认答案摘要', async () => {
  const popup = await makePopup({ status: { ...validStatus, templateIsDefault: false } });
  assert.equal(popup.elements['preset-name'].textContent, '自定义模板');
  assert.equal(popup.elements['preset-values'].hidden, true);
});

test('待处理动作阻止第二次应用，完成后恢复按钮', async () => {
  let finish;
  const popup = await makePopup({ action: () => new Promise(resolve => { finish = resolve; }) });
  const first = popup.elements.apply.onclick();
  await settle();
  assert.equal(popup.elements.apply.disabled, true);
  assert.equal(popup.elements.preview.disabled, true);
  await popup.elements.apply.onclick();
  assert.equal(popup.messages.filter(m => m.type === 'APPLY').length, 1);
  finish({ ok: true, filled: 1, submitted: false });
  await first;
  assert.equal(popup.elements.apply.disabled, false);
});

test('只读问卷可预览，不能应用；无问卷禁用所有问卷操作', async () => {
  const readonly = await makePopup({ status: { ...validStatus, readonly: true } });
  assert.equal(readonly.elements.preview.disabled, false);
  assert.equal(readonly.elements.apply.disabled, true);
  assert.equal(readonly.elements.autosubmit.disabled, true);
  assert.equal(readonly.elements.batch.disabled, false);
  const absent = await makePopup({ status: { ok: false, reason: 'no-questionnaire', total: 0 } });
  for (const id of ['preview', 'clear', 'apply', 'autosubmit']) assert.equal(absent.elements[id].disabled, true);
  assert.equal(absent.elements.batch.disabled, true);
  assert.match(absent.elements.status.textContent, /未检测到/);
});

test('状态请求失败可见，规则设置入口仍可用', async () => {
  const popup = await makePopup({ query: async () => { throw new Error('no tab'); } });
  assert.match(popup.elements.status.textContent, /无法连接/);
  assert.equal(popup.elements.apply.disabled, true);
  await popup.elements.settings.onclick();
  assert.equal(popup.settingsOpened(), 1);
});

test('提交仅声明已触发，未答题与失败结果向用户可见', async () => {
  const submitted = await makePopup({ action: async () => ({ ok: true, filled: 2, submitted: true }) });
  await submitted.elements.apply.onclick();
  assert.match(submitted.elements.msg.textContent, /已触发提交，请以平台显示为准/);
  assert.doesNotMatch(submitted.elements.msg.textContent, /已提交/);
  const unanswered = await makePopup({ action: async () => ({ ok: true, filled: 1, submitted: false, reason: 'unanswered' }) });
  await unanswered.elements.apply.onclick();
  assert.match(unanswered.elements.msg.textContent, /仍有必答题未填写/);
  const failed = await makePopup({ action: async () => ({ ok: false, reason: 'storage-error' }) });
  await failed.elements.apply.onclick();
  assert.match(failed.elements.msg.textContent, /读取规则失败/);
  await failed.elements.clear.onclick();
  assert.match(failed.elements.msg.textContent, /读取规则失败/);
});

test('总填写11题与必答9题分别展示，模板覆盖按全部题目统计', async () => {
  const popup = await makePopup({ status: {
    ...validStatus, total: 12, required: 9, answered: 9, answeredTotal: 11, matched: 9, matchedTotal: 11, unmatchedTitles: []
  } });
  assert.equal(popup.elements.counter.textContent, '11/12');
  assert.equal(popup.elements.progress.value, 11);
  assert.equal(popup.elements.progress.max, 12);
  assert.equal(popup.elements.status.textContent, '已填写 11 题，其中必答 9/9');
  assert.equal(popup.elements.coverage.textContent, '模板可填 11 题（含 9 道必答），其余 1 题留空');
});

test('明确点击启动当前任务批量提交，运行中禁用普通操作但允许停止', async () => {
  const batch = { running: true, phase: 'filling', completed: 2, skipped: 1, reason: null };
  const popup = await makePopup({ action: async (msg, setStatus) => {
    assert.equal(msg.type, 'START_BATCH');
    setStatus({ ...validStatus, batch });
    return { ok: true, batch };
  } });
  popup.elements.autosubmit.checked = true;
  await popup.elements.batch.onclick();
  assert.equal(popup.messages.filter(msg => msg.type === 'START_BATCH').length, 1);
  assert.equal(popup.messages.some(msg => msg.type === 'APPLY'), false);
  assert.equal(popup.elements.autosubmit.checked, false);
  for (const id of ['apply', 'refill', 'preview', 'clear', 'settings', 'autosubmit', 'batch']) assert.equal(popup.elements[id].disabled, true);
  assert.equal(popup.elements['stop-batch'].hidden, false);
  assert.equal(popup.elements['stop-batch'].disabled, false);
  assert.match(popup.elements['batch-state'].textContent, /正在填选.*已完成 2 份.*已跳过 1 份/);
  await popup.elements.apply.onclick();
  await popup.elements.settings.onclick();
  assert.equal(popup.messages.some(msg => msg.type === 'APPLY'), false);
  assert.equal(popup.settingsOpened(), 0);
});

test('批量跨页无当前问卷时仍可停止，停止原因和计数可见', async () => {
  const running = { running: true, phase: 'next-course', completed: 3, skipped: 2, reason: null };
  const stopped = { ...running, running: false, phase: 'stopped', reason: 'stopped' };
  const popup = await makePopup({ status: { ok: false, reason: 'no-questionnaire', batch: running }, action: async (msg, setStatus) => {
    assert.equal(msg.type, 'STOP_BATCH');
    setStatus({ ok: false, reason: 'no-questionnaire', batch: stopped });
    return { ok: true, batch: stopped };
  } });
  assert.equal(popup.elements.batch.disabled, true);
  assert.equal(popup.elements['stop-batch'].disabled, false);
  await popup.elements['stop-batch'].onclick();
  assert.equal(popup.messages.filter(msg => msg.type === 'STOP_BATCH').length, 1);
  assert.match(popup.elements['batch-state'].textContent, /已停止.*已完成 3 份.*已跳过 2 份.*已停止后续操作，已发出的提交以平台结果为准/);
  assert.equal(popup.elements.msg.textContent, '已停止后续操作，已发出的提交以平台结果为准');
  assert.equal(popup.elements['stop-batch'].hidden, true);
});

test('启动请求尚未返回也可停止，迟到的启动响应不会让任务继续', async () => {
  let finishStart;
  const stopped = { ...idleBatch, phase: 'stopped', reason: 'stopped' };
  const popup = await makePopup({ action: async (msg, setStatus) => {
    if (msg.type === 'START_BATCH') return new Promise(resolve => { finishStart = resolve; });
    assert.equal(msg.type, 'STOP_BATCH');
    setStatus({ ...validStatus, batch: stopped });
    return { ok: true, batch: stopped };
  } });
  const starting = popup.elements.batch.onclick();
  await settle();
  assert.equal(popup.elements['stop-batch'].disabled, false);
  await popup.elements['stop-batch'].onclick();
  finishStart({ ok: true, batch: { ...idleBatch, running: true, phase: 'filling' } });
  await starting;
  assert.equal(popup.messages.filter(msg => msg.type === 'STOP_BATCH').length, 2);
  assert.equal(popup.elements['stop-batch'].hidden, true);
  assert.match(popup.elements['batch-state'].textContent, /已停止/);
});

test('一秒状态轮询刷新批量阶段和终止原因，不创建真实Node计时器', async () => {
  const popup = await makePopup();
  assert.equal(popup.intervals.length, 1);
  assert.equal(popup.intervals[0].ms, 1000);
  popup.setStatus({ ...validStatus, batch: { running: false, phase: 'error', completed: 4, skipped: 1, reason: 'submission-unconfirmed' } });
  popup.intervals[0].callback();
  await settle();
  assert.match(popup.elements['batch-state'].textContent, /处理失败.*已完成 4 份.*已跳过 1 份.*平台未确认提交/);
  assert.equal(popup.elements.apply.disabled, false);
  assert.equal(popup.elements['stop-batch'].hidden, true);
});

test('旧的状态响应不能覆盖新启动的批量运行状态', async () => {
  let finishOldStatus;
  const batch = { ...idleBatch, running: true, phase: 'submitting' };
  const popup = await makePopup({ action: async (msg, setStatus) => {
    setStatus({ ...validStatus, batch });
    return { ok: true, batch };
  } });
  popup.setStatus(() => new Promise(resolve => { finishOldStatus = resolve; }));
  popup.intervals[0].callback();
  await settle();
  await popup.elements.batch.onclick();
  finishOldStatus(validStatus);
  await settle();
  assert.equal(popup.elements.apply.disabled, true);
  assert.equal(popup.elements['stop-batch'].disabled, false);
  assert.match(popup.elements['batch-state'].textContent, /正在提交/);
});

test('平台提交错误提示显示失败原因并恢复普通操作', async () => {
  const popup = await makePopup({ status: {
    ...validStatus, batch: { running: false, phase: 'error', completed: 1, skipped: 0, reason: 'submission-failed' }
  } });
  assert.match(popup.elements['batch-state'].textContent, /平台提示提交失败，已停止，请检查问卷/);
  assert.equal(popup.elements.apply.disabled, false);
});
