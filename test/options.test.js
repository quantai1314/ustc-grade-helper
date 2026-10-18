const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Engine = require('../content/engine.js');
const source = fs.readFileSync(path.join(__dirname, '../options/options.js'), 'utf8');
const settle = () => new Promise(setImmediate);

function makeElement() {
  return { value: '', checked: false, disabled: false, textContent: '' };
}

async function makeOptions({ ruleset, readError, write } = {}) {
  const elements = Object.fromEntries(['rules', 'unmatched', 'add', 'save', 'reset', 'msg'].map(id => [id, makeElement()]));
  const rows = [];
  const writes = [];
  const defaults = structuredClone(Engine.DEFAULT_RULESET);
  elements.rules.replaceChildren = (...next) => rows.splice(0, rows.length, ...next);
  elements.rules.appendChild = row => rows.push(row);
  const document = {
    getElementById: id => elements[id],
    querySelectorAll: selector => selector === '#rules tr' ? rows : [...Object.values(elements), ...rows.flatMap(r => Object.values(r.fields))],
    createElement: () => {
      const fields = Object.fromEntries(['en', 'kw', 'st', 'arg', 'del'].map(id => [id, makeElement()]));
      return {
        fields,
        innerHTML: '',
        querySelector: selector => fields[selector.slice(1)],
        remove() { rows.splice(rows.indexOf(this), 1); }
      };
    }
  };
  const chrome = { storage: { sync: {
    get: async () => {
      if (readError) throw readError;
      return ruleset ? { ruleset } : {};
    },
    set: async data => {
      writes.push(structuredClone(data));
      if (write) await write(data);
    }
  } } };
  vm.runInNewContext(source, { document, chrome, window: { Engine: {
    DEFAULT_RULESET: defaults,
    getRuleset(stored) { const current = Engine.getRuleset(stored); return current === Engine.DEFAULT_RULESET ? defaults : current; }
  } } });
  await settle();
  return { elements, rows, writes, defaults };
}

test('规则中的引号和 HTML 文本加载、保存保持原文，用户文本不进入 HTML', async () => {
  const keyword = '请评价"课堂" <img src=x>';
  const text = '建议增加"例题" & <script>test</script>';
  const options = await makeOptions({ ruleset: { rules: [{ id: 'quote', enabled: true, match: { titleIncludes: [keyword] }, action: { strategy: 'fillText', text } }], unmatchedStrategy: 'highlight' } });
  assert.equal(options.rows[0].fields.kw.value, keyword);
  assert.equal(options.rows[0].fields.arg.value, text);
  assert.equal(options.rows[0].innerHTML.includes(keyword), false);
  assert.equal(options.rows[0].innerHTML.includes(text), false);
  await options.elements.save.onclick();
  assert.equal(options.writes[0].ruleset.rules[0].match.titleIncludes[0], keyword);
  assert.equal(options.writes[0].ruleset.rules[0].action.text, text);
  assert.equal(options.elements.msg.textContent, '已保存');
});

test('容量错误显示失败并保留当前编辑，恢复按钮可继续使用', async () => {
  const options = await makeOptions({ write: async () => { throw new Error('QUOTA_BYTES_PER_ITEM exceeded'); } });
  options.rows[0].fields.kw.value = '当前编辑';
  await options.elements.save.onclick();
  assert.match(options.elements.msg.textContent, /保存失败/);
  assert.match(options.elements.msg.textContent, /QUOTA_BYTES_PER_ITEM/);
  assert.equal(options.rows[0].fields.kw.value, '当前编辑');
  assert.equal(options.elements.save.disabled, false);
  assert.equal(options.elements.reset.disabled, false);
  await options.elements.reset.onclick();
  assert.equal(options.rows[0].fields.kw.value, '当前编辑');
});

test('读取失败不允许将空表单覆盖设置，但允许显式恢复默认', async () => {
  const options = await makeOptions({ readError: new Error('storage unavailable') });
  assert.match(options.elements.msg.textContent, /读取规则失败/);
  assert.equal(options.elements.save.disabled, true);
  await options.elements.save.onclick();
  assert.equal(options.writes.length, 0);
  await options.elements.reset.onclick();
  assert.equal(options.writes.length, 1);
  assert.equal(options.elements.save.disabled, false);
  assert.equal(options.rows[0].fields.kw.value, Engine.DEFAULT_RULESET.rules[0].match.titleIncludes.join(','));
});

test('编辑不修改共享默认规则，恢复默认准确替换当前表单', async () => {
  const options = await makeOptions();
  options.rows[0].fields.kw.value = '用户修改';
  options.rows[0].fields.arg.value = '修改内容';
  await options.elements.save.onclick();
  assert.deepEqual(options.defaults, Engine.DEFAULT_RULESET);
  await options.elements.reset.onclick();
  assert.deepEqual(options.writes.at(-1).ruleset, Engine.DEFAULT_RULESET);
  assert.equal(options.rows[0].fields.kw.value, Engine.DEFAULT_RULESET.rules[0].match.titleIncludes.join(','));
  assert.equal(options.rows[0].fields.arg.value, '');
});

test('保存未完成时阻止并发保存和恢复，完成后恢复控件', async () => {
  let finish;
  const options = await makeOptions({ write: () => new Promise(resolve => { finish = resolve; }) });
  const pending = options.elements.save.onclick();
  assert.equal(options.elements.reset.disabled, true);
  await options.elements.save.onclick();
  await options.elements.reset.onclick();
  assert.equal(options.writes.length, 1);
  finish();
  await pending;
  assert.equal(options.elements.save.disabled, false);
});
