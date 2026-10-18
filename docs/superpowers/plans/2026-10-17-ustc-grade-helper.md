# USTC评教助手 Implementation Plan

> 历史文档：浏览器扩展方案已停止维护和发布，当前实现与构建方式以仓库 README 和用户脚本源码为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按设计文档从零实现 MV3 扩展"USTC评教助手"（规则引擎 + dry-run 预览 + 安全提交），做到打包就绪，商店上传前停止。

**Architecture:** 纯 JS 原生 MV3，无构建。engine.js 为纯函数模块（Node 可单测），content.js 负责 DOM 交互，popup 为主控面板，options 页编辑规则，规则存 chrome.storage.sync。选择器集中于 selectors.js，兼容现行 `index__x--hash` 与旧版 `index_x-` 两种 CSS 模块命名。

**Tech Stack:** Manifest V3、原生 JS、Node 内置 test runner（node --test）、Node zlib（图标 PNG 生成）。

**Spec:** docs/superpowers/specs/2026-10-17-auto-grade-helper-design.md

## Global Constraints

- 扩展名称：USTC评教助手；manifest description ≤ 132 字符
- 仅匹配 `https://tqm.ustc.edu.cn/index.html*`；权限只要 `storage`
- 不使用任何框架、构建工具、远程代码
- 提交按钮默认不自动点击；自动提交须 popup 中显式开启
- 所有 DOM 查询空值保护；选择器只出现在 selectors.js
- 输入框（INPUT/TEXTAREA）聚焦时快捷键不触发
- 项目根目录 = 工作区根目录（manifest.json 在根，zip 打包时排除 docs/ test/）
- 测试夹具：test/fixtures/questionnaire-completed.html（已存在）
- **停止线：完成 zip 打包与商店文案草稿后停止，不执行任何实际上传/发布**

## 接口契约（跨任务引用以此为准）

```text
Engine.cleanTitle(raw: string): string
Engine.resolveAnswers(questions: Question[], ruleset: Ruleset): Resolution[]
Engine.bestOptionIndex(options: string[]): number
Engine.DEFAULT_RULESET: Ruleset

Question   = { id: string, title: string, required: boolean, type: 'single'|'multi'|'text', options: string[] }
Rule       = { id: string, enabled: boolean, match: { titleIncludes: string[] }, action: { strategy: 'best'|'contains'|'skip'|'fillText', keyword?: string, text?: string } }
Ruleset    = { rules: Rule[], unmatchedStrategy: 'highlight'|'best' }
Resolution = { questionId: string, matchedRuleId: string|null, optionIndexes: number[], textValue: string|null }

content.js 暴露（调试用）：window.__ugh = { extractQuestions, preview, apply, clearMarks, isReadonly, getStatus }
extractQuestions(): 填充内部 current[] = [{ question: Question, blockEl, optionEls: Element[], inputEl: Element|null }]，返回 current
getStatus(): Promise<{ok, readonly, total, required, matched, unmatchedTitles: string[]}>
preview():  {ok, marked}
apply():    Promise<{ok, filled, submitted}>  （autoSubmit 由 popup 设置，经 SET_AUTOSUBMIT 消息传入）
clearMarks(): {ok}

popup ↔ content 消息：
  {type:'GET_STATUS'} / {type:'PREVIEW'} / {type:'APPLY'} / {type:'CLEAR'} / {type:'SET_AUTOSUBMIT', value: boolean}
storage 键：chrome.storage.sync['ruleset'] = Ruleset（缺省时用 Engine.DEFAULT_RULESET）
```

---

### Task 1: 项目脚手架（git、manifest、selectors、图标）

**Files:**
- Create: `manifest.json`
- Create: `content/selectors.js`
- Create: `tools/gen-icons.js`
- Create: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`（由脚本生成）

**Interfaces:**
- Produces: `window.SELECTORS`（content.js 消费）；manifest 声明 content scripts 顺序 `content/engine.js → content/selectors.js → content/content.js` + `content/content.css`

- [ ] **Step 1: git init 并写 .gitignore**

```bash
cd C:/Users/12968/Documents/Qoder/2026-10-17/cd8edfbf
git init
printf 'dist/\nnode_modules/\n' > .gitignore
git add -A && git commit -m "chore: init project with spec and fixtures"
```

- [ ] **Step 2: 写 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "USTC评教助手",
  "version": "1.0.0",
  "description": "中科大教学质量管理平台评教辅助：规则化自动填选、预览确认、手动提交。",
  "permissions": ["storage"],
  "host_permissions": ["https://tqm.ustc.edu.cn/*"],
  "content_scripts": [
    {
      "matches": ["https://tqm.ustc.edu.cn/index.html*"],
      "js": ["content/engine.js", "content/selectors.js", "content/content.js"],
      "css": ["content/content.css"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_popup": "popup/popup.html", "default_title": "USTC评教助手" },
  "options_page": "options/options.html",
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

- [ ] **Step 3: 写 content/selectors.js**

```js
// 所有页面选择器集中于此。平台改版时只改这个文件。
// 现行命名 index__x--hash（2026-10 实测），兼容旧版 index_x-。
window.SELECTORS = {
  questionBlock: "[class^='index__subject--'], [class^='index_subject-']",
  requiredMark: "[class^='index__necessary--'], [class^='index_necessary']",
  title: "[class^='index__title--'], [class^='index_title']",
  optionRow: "div[style='width: 100%;']",
  radioLabel: "label.ant-radio-wrapper",
  checkboxLabel: "label.ant-checkbox-wrapper",
  disabledClass: "ant-radio-wrapper-disabled",
  submitButton: "button[class*='index__submit'], button[class*='index_submit']",
  textarea: "textarea",
  ignoreButtonText: "忽略",
  confirmButton: "button.ant-btn-primary"
};
```

- [ ] **Step 4: 写 tools/gen-icons.js 并生成图标**

```js
// 用法: node tools/gen-icons.js  → 生成 icons/icon16|48|128.png（antd 蓝底白对勾）
const fs = require('fs');
const zlib = require('zlib');
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function genPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const [x1, y1, x2, y2, x3, y3] = [0.24 * size, 0.55 * size, 0.44 * size, 0.74 * size, 0.78 * size, 0.28 * size];
  const th = size * 0.09;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      const onCheck = distToSeg(x, y, x1, y1, x2, y2) < th / 2 || distToSeg(x, y, x2, y2, x3, y3) < th / 2;
      raw[o] = onCheck ? 255 : 22; raw[o + 1] = onCheck ? 255 : 119; raw[o + 2] = onCheck ? 255 : 255; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
fs.mkdirSync('icons', { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(`icons/icon${s}.png`, genPng(s));
console.log('icons generated');
```

运行验证：
```bash
node tools/gen-icons.js && ls -la icons/
```
Expected: 三个 PNG 文件生成。

- [ ] **Step 5: Commit**

```bash
git add manifest.json content/selectors.js tools/gen-icons.js icons/ .gitignore
git commit -m "feat: scaffold MV3 manifest, selectors, icons"
```

---

### Task 2: engine.js — cleanTitle + DEFAULT_RULESET

**Files:**
- Create: `content/engine.js`
- Test: `test/engine.test.js`

**Interfaces:**
- Produces: `Engine.cleanTitle`, `Engine.DEFAULT_RULESET`（Task 4、6、7 消费）

- [ ] **Step 1: 写失败测试 test/engine.test.js（第一部分）**

```js
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../content/engine.js');

test('cleanTitle 去除星号/题号/题型后缀/空白/nbsp', () => {
  assert.strictEqual(Engine.cleanTitle('* 1.您对本课程的总体评价 (单选题)'), '您对本课程的总体评价');
  assert.strictEqual(Engine.cleanTitle('9.您对助教的工作总体评价 （没有助教的课程此题无需作答） (单选题)'),
    '您对助教的工作总体评价（没有助教的课程此题无需作答）');
  assert.strictEqual(Engine.cleanTitle('* 12、多选示例 (多选题)'), '多选示例');
  assert.strictEqual(Engine.cleanTitle('  '), '');
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node --test test/engine.test.js
```
Expected: FAIL（Cannot find module '../content/engine.js'）

- [ ] **Step 3: 实现 content/engine.js（第一部分）**

```js
// 纯逻辑模块：不访问 DOM，可被 content script 与 Node 测试共用。
(function (global) {
  'use strict';

  const BEST_WORDS = [
    '非常满意', '非常好', '很满意', '很好', '优秀',
    '满意', '好', '比较满意', '较满意', '良好', '同意',
    '一般', '中等', '合格',
    '不太满意', '不满意', '较差', '差',
    '非常不满意', '非常差', '很差'
  ];

  function cleanTitle(raw) {
    let s = String(raw || '').replace(/ /g, ' ');
    s = s.replace(/\s+/g, '');
    if (s[0] === '*') s = s.slice(1);
    s = s.replace(/^\d+[.、．]/, '');
    s = s.replace(/[(（](单选题|多选题|主观题|问答题|简答题|填空题)[)）]\s*$/, '');
    return s;
  }

  const DEFAULT_RULESET = {
    rules: [
      { id: 'default-overall', enabled: true, match: { titleIncludes: ['总体评价', '总体满意', '满意度'] }, action: { strategy: 'best' } }
    ],
    unmatchedStrategy: 'highlight'
  };

  const Engine = { cleanTitle, DEFAULT_RULESET, BEST_WORDS };
  global.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
```

注意：实现时统一用 `\u00a0` 转义写法，避免源文件里混入不可见字符。

- [ ] **Step 4: 运行确认通过**

```bash
node --test test/engine.test.js
```
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add content/engine.js test/engine.test.js
git commit -m "feat(engine): cleanTitle and default ruleset"
```

---

### Task 3: engine.js — resolveAnswers 规则引擎

**Files:**
- Modify: `content/engine.js`
- Test: `test/engine.test.js`

**Interfaces:**
- Consumes: Task 2 的 `cleanTitle`、`DEFAULT_RULESET`
- Produces: `Engine.resolveAnswers(questions, ruleset)`、`Engine.bestOptionIndex(options)`（content.js 的 preview/apply/getStatus 消费）

- [ ] **Step 1: 追加失败测试**

```js
const Q = (over) => Object.assign({ id: 'q0', title: '', required: true, type: 'single', options: ['非常好', '好', '一般', '差'] }, over);
const RS = (over) => Object.assign({ rules: [], unmatchedStrategy: 'highlight' }, over);

test('best 策略选最高档选项', () => {
  const [r] = Engine.resolveAnswers([Q({})], RS({ unmatchedStrategy: 'best' }));
  assert.deepStrictEqual(r.optionIndexes, [0]);
});

test('best 词表按档位排序而非选项顺序', () => {
  const [r] = Engine.resolveAnswers([Q({ options: ['差', '一般', '非常满意', '好'] })], RS({ unmatchedStrategy: 'best' }));
  assert.deepStrictEqual(r.optionIndexes, [2]);
});

test('best 词表无命中时回退第一个选项', () => {
  const [r] = Engine.resolveAnswers([Q({ options: ['5分', '3分', '1分'] })], RS({ unmatchedStrategy: 'best' }));
  assert.deepStrictEqual(r.optionIndexes, [0]);
});

test('规则 titleIncludes 命中优先于未匹配策略', () => {
  const rs = RS({ rules: [{ id: 'r1', enabled: true, match: { titleIncludes: ['难度'] }, action: { strategy: 'contains', keyword: '适中' } }] });
  const [r] = Engine.resolveAnswers([Q({ title: '您认为本课程的难度', options: ['偏难', '适中', '偏易'] })], rs);
  assert.strictEqual(r.matchedRuleId, 'r1');
  assert.deepStrictEqual(r.optionIndexes, [1]);
});

test('未匹配且 unmatchedStrategy=highlight 时不选', () => {
  const [r] = Engine.resolveAnswers([Q({})], RS());
  assert.deepStrictEqual(r.optionIndexes, []);
  assert.strictEqual(r.matchedRuleId, null);
});

test('多选题 contains 可选多个，单选题 contains 只取首个', () => {
  const rule = { id: 'r2', enabled: true, match: { titleIncludes: ['方面'] }, action: { strategy: 'contains', keyword: '好' } };
  const rs = RS({ rules: [rule] });
  const [multi] = Engine.resolveAnswers([Q({ type: 'multi', title: '哪些方面好', options: ['好', '很好', '差'] })], rs);
  assert.deepStrictEqual(multi.optionIndexes, [0, 1]);
  const [single] = Engine.resolveAnswers([Q({ type: 'single', title: '哪些方面好', options: ['好', '很好', '差'] })], rs);
  assert.deepStrictEqual(single.optionIndexes, [0]);
});

test('disabled 规则不生效；skip 策略不选', () => {
  const rs = RS({ rules: [
    { id: 'off', enabled: false, match: { titleIncludes: ['总体'] }, action: { strategy: 'best' } },
    { id: 'skip', enabled: true, match: { titleIncludes: ['总体'] }, action: { strategy: 'skip' } }
  ]});
  const [r] = Engine.resolveAnswers([Q({ title: '总体评价' })], rs);
  assert.strictEqual(r.matchedRuleId, 'skip');
  assert.deepStrictEqual(r.optionIndexes, []);
});

test('text 题 fillText 产生 textValue，否则为空', () => {
  const rs = RS({ rules: [{ id: 't1', enabled: true, match: { titleIncludes: ['意见'] }, action: { strategy: 'fillText', text: '无' } }] });
  const [r] = Engine.resolveAnswers([Q({ type: 'text', title: '您的具体意见或建议', options: [] })], rs);
  assert.strictEqual(r.textValue, '无');
  const [r2] = Engine.resolveAnswers([Q({ id: 'q1', type: 'text', title: '其他', options: [] })], RS());
  assert.strictEqual(r2.textValue, null);
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node --test test/engine.test.js
```
Expected: FAIL（resolveAnswers is not a function）

- [ ] **Step 3: 在 engine.js 的 `const Engine = {...}` 之前追加实现**

```js
  function matchRule(question, rules) {
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      const kws = (rule.match && rule.match.titleIncludes) || [];
      if (kws.length > 0 && kws.some(k => question.title.includes(k))) return rule;
    }
    return null;
  }

  function bestOptionIndex(options) {
    for (const word of BEST_WORDS) {
      const i = options.findIndex(t => t.includes(word));
      if (i >= 0) return i;
    }
    return options.length > 0 ? 0 : -1;
  }

  function resolveOne(question, rule, unmatchedStrategy) {
    const res = { questionId: question.id, matchedRuleId: rule ? rule.id : null, optionIndexes: [], textValue: null };
    if (question.type === 'text') {
      if (rule && rule.action.strategy === 'fillText' && rule.action.text) res.textValue = rule.action.text;
      return res;
    }
    let strategy = rule ? rule.action.strategy : (unmatchedStrategy === 'best' ? 'best' : 'skip');
    if (strategy === 'best') {
      const i = bestOptionIndex(question.options);
      if (i >= 0) res.optionIndexes.push(i);
    } else if (strategy === 'contains') {
      const kw = (rule && rule.action.keyword) || '';
      question.options.forEach((t, i) => { if (kw && t.includes(kw)) res.optionIndexes.push(i); });
      if (question.type === 'single' && res.optionIndexes.length > 1) res.optionIndexes = [res.optionIndexes[0]];
    }
    return res;
  }

  function resolveAnswers(questions, ruleset) {
    const rules = (ruleset && ruleset.rules) || [];
    const unmatched = (ruleset && ruleset.unmatchedStrategy) || 'highlight';
    return (questions || []).map(q => resolveOne(q, matchRule(q, rules), unmatched));
  }
```

并把 `const Engine = { cleanTitle, DEFAULT_RULESET, BEST_WORDS };` 改为：
`const Engine = { cleanTitle, DEFAULT_RULESET, BEST_WORDS, matchRule, bestOptionIndex, resolveAnswers };`

- [ ] **Step 4: 运行确认全部通过**

```bash
node --test test/engine.test.js
```
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add content/engine.js test/engine.test.js
git commit -m "feat(engine): rule-based answer resolution"
```

---

### Task 4: content.js — 题目提取与只读检测

**Files:**
- Create: `content/content.js`
- Create: `content/content.css`

**Interfaces:**
- Consumes: `window.SELECTORS`（Task 1）、`Engine.cleanTitle`（Task 2）
- Produces: `window.__ugh.extractQuestions()`、`window.__ugh.isReadonly()`、内部 `current[]`（Task 5、6 消费）

- [ ] **Step 1: 写 content/content.css**

```css
.ugh-mark { outline: 3px solid #faad14 !important; outline-offset: 2px; border-radius: 4px; }
.ugh-mark-text { outline: 3px dashed #faad14 !important; outline-offset: 2px; }
```

- [ ] **Step 2: 写 content/content.js 第一段（提取 + 状态）**

```js
(function () {
  'use strict';
  const Engine = window.Engine;
  const S = window.SELECTORS;
  let current = [];   // [{question, blockEl, optionEls, inputEl}]
  let autoSubmit = false;

  function isReadonly() {
    const first = document.querySelector(S.questionBlock);
    return !!(first && first.querySelector('.' + S.disabledClass));
  }

  function detectType(block) {
    if (block.querySelector(S.textarea)) return 'text';
    if (block.querySelector(S.checkboxLabel)) return 'multi';
    return 'single';
  }

  function extractQuestions() {
    const blocks = [...document.querySelectorAll(S.questionBlock)]
      .filter(b => b.querySelector(S.title));
    current = blocks.map((block, idx) => {
      const titleEl = block.querySelector(S.title);
      const optionEls = [...block.querySelectorAll(S.optionRow)];
      return {
        question: {
          id: 'q' + idx,
          title: Engine.cleanTitle(titleEl ? titleEl.textContent : ''),
          required: !!block.querySelector(S.requiredMark),
          type: detectType(block),
          options: optionEls.map(el => el.textContent.replace(/\s+/g, ''))
        },
        blockEl: block,
        optionEls: optionEls,
        inputEl: block.querySelector(S.textarea)
      };
    });
    return current;
  }

  async function getRuleset() {
    const data = await chrome.storage.sync.get('ruleset');
    return data.ruleset || Engine.DEFAULT_RULESET;
  }

  async function getStatus() {
    if (current.length === 0) extractQuestions();
    const ruleset = await getRuleset();
    const resolutions = Engine.resolveAnswers(current.map(c => c.question), ruleset);
    const required = current.filter(c => c.question.required);
    const matched = resolutions.filter((r, i) => current[i].question.required && (r.optionIndexes.length > 0 || r.textValue !== null)).length;
    const unmatchedTitles = resolutions
      .filter((r, i) => current[i].question.required && r.optionIndexes.length === 0 && r.textValue === null)
      .map((r, i) => current.find(c => c.question.id === r.questionId).question.title);
    return { ok: true, readonly: isReadonly(), total: current.length, required: required.length, matched, unmatchedTitles };
  }

  window.__ugh = { extractQuestions, isReadonly, getStatus };
})();
```

- [ ] **Step 3: 夹具冒烟验证（浏览器手动/脚本）**

用 chrome-devtools MCP 打开 `file:///C:/Users/12968/Documents/Qoder/2026-10-17/cd8edfbf/test/fixtures/questionnaire-completed.html`，evaluate_script 依次注入 engine.js、selectors.js、content.js 的源码，然后执行：

```js
const r = window.__ugh.extractQuestions();
({ count: r.length, readonly: window.__ugh.isReadonly(), titles: r.map(c => c.question.title), types: r.map(c => c.question.type) });
```
Expected: count = 12，readonly = true，types 含 'single'/'multi'/'text'，标题已清洗干净。

- [ ] **Step 4: Commit**

```bash
git add content/content.js content/content.css
git commit -m "feat(content): question extraction and readonly detection"
```

---

### Task 5: content.js — preview / apply / clearMarks + 消息监听 + 快捷键

**Files:**
- Modify: `content/content.js`

**Interfaces:**
- Consumes: Task 4 的 `current[]`、`getRuleset`；Engine.resolveAnswers
- Produces: 完整 `window.__ugh`（含 preview/apply/clearMarks）与 chrome.runtime.onMessage 处理器（popup 消费）；`SET_AUTOSUBMIT` 消息

- [ ] **Step 1: 在 IIFE 内、`window.__ugh` 赋值前追加**

```js
  function clearMarks() {
    document.querySelectorAll('.ugh-mark, .ugh-mark-text').forEach(el => el.classList.remove('ugh-mark', 'ugh-mark-text'));
    return { ok: true };
  }

  async function resolveCurrent() {
    if (current.length === 0) extractQuestions();
    const ruleset = await getRuleset();
    return Engine.resolveAnswers(current.map(c => c.question), ruleset);
  }

  async function preview() {
    clearMarks();
    const resolutions = await resolveCurrent();
    let marked = 0;
    resolutions.forEach((r, i) => {
      const c = current[i];
      r.optionIndexes.forEach(oi => { if (c.optionEls[oi]) { c.optionEls[oi].classList.add('ugh-mark'); marked++; } });
      if (r.textValue !== null && c.inputEl) { c.inputEl.classList.add('ugh-mark-text'); marked++; }
    });
    return { ok: true, marked };
  }

  function setTextareaValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isVisible(el) {
    for (let n = el; n; n = n.parentElement) if (n.style && n.style.display === 'none') return false;
    return true;
  }

  async function waitEnabled(btn, timeoutMs) {
    const start = Date.now();
    while (btn.hasAttribute('disabled') || btn.disabled) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise(r => setTimeout(r, 300));
    }
    return true;
  }

  async function apply() {
    if (isReadonly()) return { ok: false, filled: 0, submitted: false, reason: 'readonly' };
    const resolutions = await resolveCurrent();
    let filled = 0;
    resolutions.forEach((r, i) => {
      const c = current[i];
      r.optionIndexes.forEach(oi => {
        const row = c.optionEls[oi];
        const label = row && (row.querySelector('label') || row.firstChild);
        if (label) { label.click(); filled++; }
      });
      if (r.textValue !== null && c.inputEl) { setTextareaValue(c.inputEl, r.textValue); filled++; }
    });
    let submitted = false;
    if (autoSubmit) {
      const btn = [...document.querySelectorAll(S.submitButton)].find(isVisible);
      if (btn && await waitEnabled(btn, 15000)) { btn.click(); submitted = true; }
    }
    return { ok: true, filled, submitted };
  }

  function ignoreCurrent() {
    const btn = [...document.querySelectorAll('button')].find(b => isVisible(b) && b.textContent.includes(S.ignoreButtonText));
    if (btn) btn.click();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'GET_STATUS': return sendResponse(await getStatus());
        case 'PREVIEW': return sendResponse(await preview());
        case 'APPLY': return sendResponse(await apply());
        case 'CLEAR': return sendResponse(clearMarks());
        case 'SET_AUTOSUBMIT': autoSubmit = !!msg.value; return sendResponse({ ok: true });
        default: return sendResponse({ ok: false });
      }
    })();
    return true;
  });

  document.addEventListener('keyup', (e) => {
    const tag = document.activeElement && document.activeElement.nodeName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Enter' && !e.shiftKey) apply();
    else if (e.key === 'Backspace') ignoreCurrent();
  });
```

并把 `window.__ugh = {...}` 改为：
`window.__ugh = { extractQuestions, isReadonly, getStatus, preview, apply, clearMarks };`

- [ ] **Step 2: 夹具冒烟验证**

同 Task 4 方式注入后执行：

```js
(async () => {
  const st = await window.__ugh.getStatus();
  const ap = await window.__ugh.apply();
  const pv = await window.__ugh.preview();
  return { st, ap, pv, markedEls: document.querySelectorAll('.ugh-mark').length };
})()
```
Expected: `st.readonly === true`；`ap.ok === false && ap.reason === 'readonly'`（只读保护生效）；`pv.marked > 0` 且 `markedEls > 0`（预览在只读页也只标记不点击）。

- [ ] **Step 3: Commit**

```bash
git add content/content.js
git commit -m "feat(content): preview/apply/clear, messaging, shortcuts"
```

---

### Task 6: popup 主面板

**Files:**
- Create: `popup/popup.html`
- Create: `popup/popup.js`

**Interfaces:**
- Consumes: Task 5 的消息协议（GET_STATUS / PREVIEW / APPLY / CLEAR / SET_AUTOSUBMIT）

- [ ] **Step 1: 写 popup/popup.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { width: 300px; font: 14px/1.6 -apple-system, "Microsoft YaHei", sans-serif; margin: 0; padding: 12px; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  .stat { color: #555; margin: 4px 0; }
  .warn { color: #d4380d; }
  button { display: block; width: 100%; margin: 6px 0; padding: 8px; border: 1px solid #1677ff; background: #1677ff; color: #fff; border-radius: 6px; cursor: pointer; }
  button.ghost { background: #fff; color: #1677ff; }
  label.auto { display: flex; gap: 6px; align-items: center; margin: 8px 0; color: #555; }
  #unmatched { font-size: 12px; color: #999; max-height: 90px; overflow: auto; }
  #msg { font-size: 12px; color: #1677ff; min-height: 18px; }
</style>
</head>
<body>
  <h1>USTC评教助手</h1>
  <div class="stat" id="status">正在读取页面状态…</div>
  <div id="unmatched"></div>
  <button id="preview" class="ghost">预览（高亮将选答案）</button>
  <button id="apply">应用填选</button>
  <button id="clear" class="ghost">清除高亮</button>
  <label class="auto"><input type="checkbox" id="autosubmit"> 应用后自动提交（谨慎开启）</label>
  <div id="msg"></div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 popup/popup.js**

```js
const $ = (id) => document.getElementById(id);

async function send(type, extra) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { ok: false };
  try {
    return await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, extra));
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function refresh() {
  const st = await send('GET_STATUS');
  if (!st.ok) { $('status').textContent = '未检测到评教问卷页面'; $('status').className = 'stat warn'; return; }
  if (st.readonly) { $('status').textContent = '当前问卷已提交（只读），仅可预览'; $('status').className = 'stat warn'; }
  else $('status').textContent = `共 ${st.total} 题，必答 ${st.required} 题，规则可覆盖 ${st.matched} 题`;
  $('unmatched').textContent = st.unmatchedTitles.length ? '未匹配：' + st.unmatchedTitles.join('；') : '';
}

$('preview').onclick = async () => { const r = await send('PREVIEW'); $('msg').textContent = r.ok ? `已高亮 ${r.marked} 处` : '预览失败'; };
$('apply').onclick = async () => {
  const r = await send('APPLY');
  $('msg').textContent = r.ok ? `已填选 ${r.filled} 处${r.submitted ? '，已提交' : '，请自行检查后提交'}` : (r.reason === 'readonly' ? '问卷已提交，无需填选' : '填选失败');
  refresh();
};
$('clear').onclick = async () => { await send('CLEAR'); $('msg').textContent = '已清除高亮'; };
$('autosubmit').onchange = (e) => send('SET_AUTOSUBMIT', { value: e.target.checked });

refresh();
```

- [ ] **Step 3: 验证（开发者模式加载扩展）**

chrome://extensions → 开发者模式 → 加载已解压扩展（项目根目录）→ 打开任意页面点击工具栏图标，popup 显示"未检测到评教问卷页面"（非目标站行为正确）。

- [ ] **Step 4: Commit**

```bash
git add popup/
git commit -m "feat(popup): status panel with preview/apply/clear"
```

---

### Task 7: options 规则编辑器

**Files:**
- Create: `options/options.html`
- Create: `options/options.js`

**Interfaces:**
- Consumes: storage 键 `ruleset`（Ruleset，Task 3 契约）、Engine.DEFAULT_RULESET（inline 复制一份默认值，options 页不加载 engine.js 以免依赖 window——直接把 DEFAULT_RULESET 常量复制进 options.js）

- [ ] **Step 1: 写 options/options.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>USTC评教助手 - 规则设置</title>
<style>
  body { font: 14px/1.6 -apple-system, "Microsoft YaHei", sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border-bottom: 1px solid #eee; padding: 6px; text-align: left; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 4px; }
  button { padding: 6px 14px; border: 1px solid #1677ff; background: #1677ff; color: #fff; border-radius: 6px; cursor: pointer; }
  button.ghost { background: #fff; color: #1677ff; }
  .row { margin: 12px 0; }
</style>
</head>
<body>
  <h1>规则设置</h1>
  <p>规则按顺序匹配，命中即停。「题目包含」为关键词，多个关键词用英文逗号分隔（任一命中即可）。</p>
  <table>
    <thead><tr><th>启用</th><th>题目包含</th><th>策略</th><th>策略参数</th><th></th></tr></thead>
    <tbody id="rules"></tbody>
  </table>
  <div class="row"><button id="add" class="ghost">+ 添加规则</button></div>
  <div class="row">
    未匹配必答题的处理：
    <select id="unmatched">
      <option value="highlight">仅高亮提醒（默认，需手动填）</option>
      <option value="best">自动选最高档选项</option>
    </select>
  </div>
  <div class="row">
    <button id="save">保存</button>
    <button id="reset" class="ghost">恢复默认</button>
    <span id="msg"></span>
  </div>
  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 options/options.js**

```js
const DEFAULT_RULESET = {
  rules: [
    { id: 'default-overall', enabled: true, match: { titleIncludes: ['总体评价', '总体满意', '满意度'] }, action: { strategy: 'best' } }
  ],
  unmatchedStrategy: 'highlight'
};
const STRATEGIES = [['best', '选最高档'], ['contains', '包含关键词'], ['skip', '跳过不填'], ['fillText', '填充文本（主观题）']];
let ruleset;

function row(rule) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="checkbox" class="en" ${rule.enabled ? 'checked' : ''}></td>
    <td><input type="text" class="kw" value="${rule.match.titleIncludes.join(',')}"></td>
    <td><select class="st">${STRATEGIES.map(([v, t]) => `<option value="${v}" ${rule.action.strategy === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
    <td><input type="text" class="arg" placeholder="关键词或填充文本" value="${rule.action.keyword || rule.action.text || ''}"></td>
    <td><button class="ghost del">删除</button></td>`;
  tr.querySelector('.del').onclick = () => tr.remove();
  return tr;
}

async function load() {
  const data = await chrome.storage.sync.get('ruleset');
  ruleset = data.ruleset || DEFAULT_RULESET;
  const tbody = document.getElementById('rules');
  tbody.innerHTML = '';
  ruleset.rules.forEach(r => tbody.appendChild(row(r)));
  document.getElementById('unmatched').value = ruleset.unmatchedStrategy;
}

document.getElementById('add').onclick = () => {
  document.getElementById('rules').appendChild(row({ id: 'r' + Date.now(), enabled: true, match: { titleIncludes: [] }, action: { strategy: 'best' } }));
};

document.getElementById('save').onclick = async () => {
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
  await chrome.storage.sync.set({ ruleset: { rules, unmatchedStrategy: document.getElementById('unmatched').value } });
  document.getElementById('msg').textContent = '已保存';
};

document.getElementById('reset').onclick = async () => {
  await chrome.storage.sync.set({ ruleset: DEFAULT_RULESET });
  load();
};

load();
```

- [ ] **Step 3: 验证**

扩展详情页 → 扩展程序选项 → 添加/删除/保存规则 → 重新打开确认持久化（chrome.storage.sync）。

- [ ] **Step 4: Commit**

```bash
git add options/
git commit -m "feat(options): rule editor with sync storage"
```

---

### Task 8: 集成验证（夹具 + 真机只读验证清单）

**Files:**
- Modify: 无新代码；产出验证记录

- [ ] **Step 1: 夹具全链路冒烟**

用 chrome-devtools MCP 打开夹具页，注入 engine/selectors/content/content.css，执行：

```js
(async () => {
  const st = await window.__ugh.getStatus();
  const pv = await window.__ugh.preview();
  return { st, pv };
})()
```
Expected: `st.total = 12`、`st.required = 9`、`st.readonly = true`、默认规则下 `st.matched ≥ 2`（两道"总体评价"题命中 default-overall）；`pv.marked ≥ 2`。

- [ ] **Step 2: 单测全量回归**

```bash
node --test test/engine.test.js
```
Expected: 全部 PASS。

- [ ] **Step 3: 真机只读验证清单（交付给用户执行，不阻塞开发收尾）**

- 开发者模式加载扩展 → 登录 tqm.ustc.edu.cn 打开已评问卷 → popup 应显示"已提交（只读）"
- 点击"预览"应对规则命中的题目选项出现橙色高亮
- 快捷键在输入框聚焦时不触发

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: fixture smoke verification"
```

---

### Task 9: 商店打包与文案（停止线）

**Files:**
- Create: `docs/store-listing.md`
- Create: `docs/privacy-policy.md`
- Create: `dist/ustc-grade-helper.zip`（产物，不入库）

- [ ] **Step 1: 写 docs/store-listing.md（双商店复用），内容如下**

```markdown
# 商店上架文案

## 名称
USTC评教助手

## 简短描述（同 manifest，≤132 字符）
中科大教学质量管理平台评教辅助：规则化自动填选、预览确认、手动提交。

## 详细描述
还在为每学期末逐门课、逐位老师重复点选评教问卷而烦恼？USTC评教助手帮你把机械性的勾选交给规则，把最终决定权留给你。

核心功能：
• 规则化填选：内置"总体评价选最高档"等常用规则，可在设置页按题目关键词自由增删改，支持"选最高档 / 包含关键词 / 跳过 / 主观题填充文本"四种策略
• 预览确认：填选前一键高亮所有将被选中的选项，效果一目了然
• 安全默认：插件只做填选，提交按钮始终由你亲自点击（自动提交需手动显式开启）
• 未匹配提醒：规则覆盖不到的必答题会单独列出，绝不漏答

适用网站：中国科学技术大学教学质量管理平台（tqm.ustc.edu.cn）。仅在问卷页面运行，不影响平台其他功能。

隐私承诺：本扩展不收集、不上传任何数据。你的自定义规则仅保存在浏览器自带的同步存储中，扩展不进行任何网络请求。

## 权限用途说明
- storage：保存你在设置页自定义的填选规则
- 主机权限（仅 tqm.ustc.edu.cn）：读取问卷页面结构，以便按你的规则执行填选与高亮

## 分类
效率（Productivity）

## 截图清单（1280×800）
1. popup 主面板显示问卷统计
2. 预览模式下选项橙色高亮效果
3. options 规则编辑页
```

- [ ] **Step 2: 写 docs/privacy-policy.md，内容如下**

```markdown
# USTC评教助手 隐私政策

更新日期：2026-10-17

## 数据收集
本扩展不收集、存储（远程）、传输或分享任何个人数据。

## 本地存储
你在扩展设置页中配置的填选规则，仅保存于浏览器提供的 chrome.storage 同步存储中，由你的浏览器账号体系管理，扩展开发者无法访问。

## 网络行为
本扩展不发起任何网络请求，不加载任何远程代码或资源。

## 权限使用
- storage：仅用于保存上述规则
- tqm.ustc.edu.cn 主机权限：仅用于读取问卷页面结构并执行填选辅助

## 联系
如有隐私相关疑问，请通过扩展商店页面的开发者联系方式反馈。
```

- [ ] **Step 3: 打包 zip（manifest.json 必须在 zip 根目录）**

```bash
mkdir -p dist
powershell -Command "Compress-Archive -Path manifest.json,content,popup,options,icons -DestinationPath dist/ustc-grade-helper.zip -Force"
powershell -Command "(Get-Content dist/ustc-grade-helper.zip -TotalCount 0) ; Expand-Archive -Path dist/ustc-grade-helper.zip -DestinationPath dist/verify -Force; ls dist/verify"
```
Expected: `dist/verify/manifest.json` 存在于根层级。

- [ ] **Step 4: 输出交付清单并停止**

向用户汇报：zip 路径、商店文案位置、剩余人工步骤（Chrome $5 开发者注册、Edge Partner Center 注册、图标/截图确认、上传提交）。**不执行上传。**

- [ ] **Step 5: Commit**

```bash
git add docs/store-listing.md docs/privacy-policy.md
git commit -m "docs: store listing and privacy policy drafts"
```
