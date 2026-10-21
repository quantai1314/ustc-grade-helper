const DEFAULT_RULESET = window.Engine.DEFAULT_RULESET;
const STRATEGIES = [['best', '选最高档'], ['contains', '包含关键词'], ['skip', '跳过不填'], ['fillText', '填充文本（主观题）']];
let busy = false;
let loaded = false;

function row(rule) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="rule-enabled"><span class="rule-order" aria-hidden="true"></span><label class="rule-toggle"><input type="checkbox" class="en" aria-label="启用这条规则"><span>启用规则</span></label></td>
    <td class="rule-match"><label class="rule-field"><span class="field-label">题目包含</span><input type="text" class="kw" placeholder="多个关键词用英文逗号分隔"></label></td>
    <td class="rule-strategy"><label class="rule-field"><span class="field-label">填写策略</span><select class="st">${STRATEGIES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label></td>
    <td class="rule-argument"><label class="rule-field"><span class="field-label">策略参数</span><input type="text" class="arg" placeholder="关键词或填充文本"></label></td>
    <td class="rule-actions"><button class="ghost del" type="button" aria-label="删除这条规则">删除</button></td>`;
  tr.querySelector('.en').checked = rule.enabled !== false;
  tr.querySelector('.kw').value = rule.match.titleIncludes.join(',');
  tr.querySelector('.st').value = rule.action.strategy;
  tr.querySelector('.arg').value = rule.action.keyword || rule.action.text || '';
  tr.querySelector('.del').onclick = () => tr.remove();
  return tr;
}

function render(ruleset) {
  const tbody = document.getElementById('rules');
  tbody.replaceChildren(...ruleset.rules.map(row));
  document.getElementById('unmatched').value = ruleset.unmatchedStrategy;
}

function updateControls() {
  document.querySelectorAll('button, input, select').forEach(el => { el.disabled = busy || !loaded; });
  document.getElementById('reset').disabled = busy;
}

async function writeRules(ruleset, reset) {
  if (busy) return;
  busy = true;
  updateControls();
  document.getElementById('msg').textContent = '';
  try {
    await chrome.storage.sync.set({ ruleset });
    if (reset) render(DEFAULT_RULESET);
    loaded = true;
    document.getElementById('msg').textContent = reset ? '已恢复默认' : '已保存';
  } catch (e) {
    document.getElementById('msg').textContent = '保存失败，当前编辑内容已保留。请减少规则或文本长度后重试：' + (e.message || String(e));
  } finally {
    busy = false;
    updateControls();
  }
}

document.getElementById('add').onclick = () => {
  if (busy || !loaded) return;
  document.getElementById('rules').appendChild(row({ id: 'r' + Date.now(), enabled: true, match: { titleIncludes: [] }, action: { strategy: 'best' } }));
};

document.getElementById('save').onclick = async () => {
  if (busy || !loaded) return;
  const rules = [...document.querySelectorAll('#rules tr')].map(tr => {
    const strategy = tr.querySelector('.st').value;
    const arg = tr.querySelector('.arg').value.trim();
    const action = { strategy };
    if (strategy === 'contains') action.keyword = arg;
    if (strategy === 'fillText') action.text = arg;
    return {
      id: 'r' + Math.random().toString(36).slice(2, 8),
      enabled: tr.querySelector('.en').checked,
      match: { titleIncludes: tr.querySelector('.kw').value.split(',').map(s => s.trim()).filter(Boolean) },
      action
    };
  }).filter(r => r.match.titleIncludes.length > 0);
  await writeRules({ rules, unmatchedStrategy: document.getElementById('unmatched').value }, false);
};

document.getElementById('reset').onclick = () => writeRules(DEFAULT_RULESET, true);

async function load() {
  busy = true;
  updateControls();
  try {
    const data = await chrome.storage.sync.get('ruleset');
    render(window.Engine.getRuleset(data.ruleset));
    loaded = true;
  } catch (e) {
    document.getElementById('msg').textContent = '读取规则失败，未覆盖已有设置。请重新打开设置页或恢复默认：' + (e.message || String(e));
  } finally {
    busy = false;
    updateControls();
  }
}

load();
