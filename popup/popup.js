const $ = (id) => document.getElementById(id);
let busy = false;
let status = null;
let startingBatch = false;
let stoppingBatch = false;
let startCancelled = false;
let refreshGeneration = 0;
let pendingRefreshes = 0;

const REASONS = {
  readonly: '问卷为只读状态，无法填选',
  'no-questionnaire': '未检测到评教问卷页面',
  'page-changed': '问卷页面已变化，请重新预览后再应用',
  busy: '正在处理，请稍候',
  unanswered: '仍有必答题未填写，请检查后手动提交',
  'submit-timeout': '等待提交按钮超时，请检查后手动提交',
  'submit-unavailable': '未找到可用的提交按钮，请检查页面',
  'submission-unconfirmed': '平台未确认提交，已停止，请检查问卷状态',
  'submission-failed': '平台提示提交失败，已停止，请检查问卷',
  'navigation-timeout': '等待下一份问卷超时，已停止',
  'navigation-loop': '检测到重复问卷，已停止',
  'left-task': '已离开当前任务，批量处理结束',
  'navigation-unavailable': '未找到当前任务的课程列表入口，已停止',
  'pending-questionnaires': '任务列表仍有未完成问卷，已停止，请检查平台状态',
  stopped: '已停止后续操作，已发出的提交以平台结果为准',
  'storage-error': '读取规则失败，请检查脚本管理器设置',
  error: '操作失败，请重试并检查页面',
  unavailable: '无法连接问卷页面，请刷新页面后重试'
};

const BATCH_PHASES = {
  filling: '正在填选',
  submitting: '正在提交',
  confirming: '正在等待平台确认提交',
  'next-teacher': '正在切换下一位教师',
  'next-course': '正在切换下一门课程',
  'checking-task': '正在检查当前任务是否还有未完成问卷',
  completed: '当前任务已处理完成',
  stopped: '已停止',
  error: '处理失败，已停止'
};

function batchRunning() {
  return startingBatch || !!status?.batch?.running;
}

function renderBatch() {
  const batch = status?.batch;
  const idle = !batch || (!batch.running && (!batch.phase || batch.phase === 'idle') && !batch.completed && !batch.skipped && !batch.reason);
  if (idle && !startingBatch && !stoppingBatch) {
    $('batch-state').textContent = '';
    $('batch-state').className = '';
    return;
  }
  $('batch-state').className = startingBatch || stoppingBatch || batch?.running ? 'running' : batch?.phase || '';
  const phase = stoppingBatch ? '正在停止' : startingBatch ? '正在启动' : (BATCH_PHASES[batch.phase] || (batch.running ? '正在处理' : '尚未开始'));
  const reason = batch?.reason ? REASONS[batch.reason] || '处理已停止，请检查当前页面' : '';
  $('batch-state').textContent = `${phase} · 已完成 ${batch?.completed || 0} 份 · 已跳过 ${batch?.skipped || 0} 份${reason ? '；' + reason : ''}`;
}

async function send(type, extra) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { ok: false, reason: 'unavailable' };
    return await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, extra)) || { ok: false, reason: 'unavailable' };
  } catch (e) {
    return { ok: false, reason: 'unavailable' };
  }
}

function updateControls() {
  const available = status && status.ok && status.total > 0;
  const running = batchRunning();
  $('preview').disabled = busy || running || !available;
  $('clear').disabled = busy || running || !available;
  $('apply').disabled = busy || running || !available || status.readonly;
  $('refill').disabled = busy || running || !available || status.readonly;
  $('autosubmit').disabled = busy || running || !available || status.readonly;
  $('settings').disabled = busy || running;
  $('batch').disabled = busy || running || !available || !status.batch;
  $('stop-batch').hidden = !running && !stoppingBatch;
  $('stop-batch').disabled = stoppingBatch || (!running && !stoppingBatch);
}

async function refresh() {
  const generation = ++refreshGeneration;
  pendingRefreshes++;
  let next;
  try { next = await send('GET_STATUS'); }
  finally { pendingRefreshes--; }
  if (generation !== refreshGeneration) return;
  // 连接暂时失败时仍保留停止入口，便于用户再次发出停止请求。
  if (!next.batch && status?.batch?.running) next.batch = status.batch;
  status = next;
  const available = status.ok && status.total > 0;
  $('status').className = available && !status.readonly ? 'stat' : 'stat warn';
  if (!available) $('status').textContent = REASONS[status.reason] || '未检测到评教问卷页面';
  else $('status').textContent = `已填写 ${status.answeredTotal ?? status.answered ?? 0} 题，其中必答 ${status.answered || 0}/${status.required}${status.readonly ? '（只读）' : ''}`;
  $('counter').textContent = available ? `${status.answeredTotal ?? status.answered ?? 0}/${status.total}` : '—/—';
  $('progress').max = available ? Math.max(1, status.total) : 1;
  $('progress').value = available ? status.answeredTotal ?? status.answered ?? 0 : 0;
  const matchedTotal = status.matchedTotal ?? status.matched ?? 0;
  $('coverage').textContent = available ? `模板可填 ${matchedTotal} 题（含 ${status.matched} 道必答），其余 ${Math.max(0, status.total - matchedTotal)} 题留空` : '';
  const defaultTemplate = status.templateIsDefault !== false;
  $('preset-name').textContent = defaultTemplate ? '默认模板' : '自定义模板';
  $('preset-values').hidden = !defaultTemplate;
  $('preset-caption').textContent = defaultTemplate ? 'PPT为主、板书为辅 · 课外1–2小时 · 教师改进：师生交流' : '正在使用你的规则，点击“自定义规则”查看或调整';
  const unmatched = available && Array.isArray(status.unmatchedTitles) ? status.unmatchedTitles : [];
  $('unmatched').textContent = unmatched.length ? '未匹配：' + unmatched.join('；') : '';
  renderBatch();
  updateControls();
}

async function runAction(action) {
  if (busy || batchRunning()) return;
  busy = true;
  updateControls();
  try {
    await action();
  } catch (e) {
    $('msg').textContent = REASONS.error;
  } finally {
    busy = false;
    updateControls();
  }
}

$('preview').onclick = () => runAction(async () => {
  const r = await send('PREVIEW');
  $('msg').textContent = r.ok ? `已高亮 ${r.marked} 处` : (REASONS[r.reason] || '预览失败');
});
function fill(overwrite) { return runAction(async () => {
  const autoSubmit = $('autosubmit').checked;
  $('autosubmit').checked = false;
  const r = await send('APPLY', { autoSubmit, overwrite });
  if (!r.ok) $('msg').textContent = REASONS[r.reason] || '填选失败';
  else if (r.submitted) $('msg').textContent = `已填选 ${r.filled} 处，已触发提交，请以平台显示为准`;
  else if (r.reason) $('msg').textContent = `已填选 ${r.filled} 处，${REASONS[r.reason] || '请自行检查后提交'}`;
  else if (r.required > 0 && r.answered === r.required) $('msg').textContent = `必答题已填满 ${r.answered}/${r.required}，请检查例外后提交`;
  else $('msg').textContent = `已填选 ${r.filled} 处，请自行检查后提交`;
  await refresh();
}); }
$('apply').onclick = () => fill(false);
$('refill').onclick = () => fill(true);
$('clear').onclick = () => runAction(async () => {
  const r = await send('CLEAR');
  $('msg').textContent = r.ok ? '已清除高亮' : (REASONS[r.reason] || '清除高亮失败');
});
$('batch').onclick = () => runAction(async () => {
  if (!status?.ok || !status.total || !status.batch) return;
  startingBatch = true;
  startCancelled = false;
  $('autosubmit').checked = false;
  refreshGeneration++;
  renderBatch();
  updateControls();
  try {
    const r = await send('START_BATCH');
    if (r.batch) status = { ...status, batch: r.batch };
    if (startCancelled && r.ok) {
      const stopped = await send('STOP_BATCH');
      if (stopped.batch) status = { ...status, batch: stopped.batch };
    }
    $('msg').textContent = r.ok ? (startCancelled ? '已请求停止批量处理' : '已开始处理当前任务，可随时点击“停止”') : (REASONS[r.reason] || '无法开始批量处理');
  } finally {
    startingBatch = false;
    renderBatch();
    await refresh();
  }
});
$('stop-batch').onclick = async () => {
  if (stoppingBatch || !batchRunning()) return;
  startCancelled = true;
  stoppingBatch = true;
  $('autosubmit').checked = false;
  refreshGeneration++;
  renderBatch();
  updateControls();
  try {
    const r = await send('STOP_BATCH');
    if (r.batch) status = { ...status, batch: r.batch };
    $('msg').textContent = r.ok ? REASONS.stopped : (REASONS[r.reason] || '停止请求失败，请重试');
    await refresh();
  } finally {
    stoppingBatch = false;
    renderBatch();
    updateControls();
  }
};
$('settings').onclick = async () => {
  if (busy || batchRunning()) return;
  try {
    await chrome.runtime.openOptionsPage();
  } catch (e) {
    $('msg').textContent = '无法打开规则设置，请从脚本管理器菜单打开';
  }
};

updateControls();
refresh();
const polling = globalThis.setInterval?.(() => {
  if (!pendingRefreshes) refresh();
}, 1000);
polling?.unref?.();
