// ==UserScript==
// @name         USTC评教助手
// @namespace    https://greasyfork.org/users/1573189
// @version      1.2.3
// @description  中科大评教问卷完整模板速填，保留手动答案，显示全部题目和必答进度，支持拖动入口及一键逐教师逐课程提交，可随时停止。
// @author       quantai1314
// @match        https://tqm.ustc.edu.cn/index.html*
// @run-at       document-idle
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// ==/UserScript==

// 完整源码内嵌，不使用远程答案库、外部脚本、广告或统计服务。
(function () {
  'use strict';
  if (document.getElementById('ugh-userscript-root')) return;
  // 私有适配对象不覆盖页面的 window.chrome、Engine 或其他全局变量。
  const window = { HTMLTextAreaElement: globalThis.HTMLTextAreaElement };
  let receiveMessage;
  let shell;
  const chrome = {
    storage: { sync: {
      async get() { return { ruleset: await GM.getValue('ruleset', null) }; },
      async set(data) {
        await GM.setValue('ruleset', data.ruleset);
        window.__ugh.clearMarks();
        if (shell) shell.scheduleRefresh();
      }
    } },
    runtime: {
      onMessage: { addListener(fn) { receiveMessage = fn; } },
      async openOptionsPage() { shell.show(true); }
    },
    tabs: {
      async query() { return [{ id: 0 }]; },
      async sendMessage(id, message) {
        return new Promise(resolve => receiveMessage(message, {}, resolve));
      }
    }
  };

// 来源：本项目 content/engine.js
// 纯逻辑模块：不访问 DOM，可被 content script 与 Node 测试共用。
(function (global) {
  'use strict';

  const BEST_WORDS = [
    '非常满意', '非常好', '很满意', '很好', '优秀', '非常同意',
    '满意', '好', '比较满意', '较满意', '比较好', '较好', '良好', '同意',
    '一般', '中等', '合格',
    '不太满意', '不满意', '不太好', '不好', '不同意', '较差', '差',
    '非常不满意', '非常不好', '非常不同意', '非常差', '很差'
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
      { id: 'default-overall', enabled: true, match: { titleIncludes: ['总体评价', '总体满意', '满意度'] }, action: { strategy: 'best' } },
      { id: 'default-materials', enabled: true, match: { titleIncludes: ['教材', '讲义'] }, action: { strategy: 'best' } },
      { id: 'default-balanced', enabled: true, match: { titleIncludes: ['课程的难度', '课程难度', '难易程度', '课程的内容', '课程内容多少', '内容多少', '课程的进度', '课程进度', '教学进度'] }, action: { strategy: 'contains', keyword: '适中' } },
      { id: 'default-class-format', enabled: true, match: { titleIncludes: ['上课形式', '授课形式'] }, action: { strategy: 'contains', keyword: 'PPT为主' } },
      { id: 'default-ta-improvement', enabled: true, match: { titleIncludes: ['助教的工作应该在哪些方面', '助教应该在哪些方面', '助教工作改进', '助教的改进', '助教改进'] }, action: { strategy: 'contains', keyword: '作业反馈' } },
      { id: 'default-teacher-improvement', enabled: true, match: { titleIncludes: ['教师应该在哪些方面', '教师的工作应该在哪些方面', '教师工作改进', '教师的改进', '教师改进'] }, action: { strategy: 'contains', keyword: '师生交流' } },
      { id: 'default-weekly-time', enabled: true, match: { titleIncludes: ['课外时间'] }, action: { strategy: 'contains', keyword: '1-2小时' } }
    ],
    unmatchedStrategy: 'highlight'
  };

  function getRuleset(stored) {
    if (stored === null || stored === undefined) return DEFAULT_RULESET;
    // 旧编辑器保存时会重建随机 id，只比较旧默认的实际匹配和动作。
    const rule = Array.isArray(stored.rules) && stored.rules.length === 1 ? stored.rules[0] : null;
    const keywords = rule && rule.match && rule.match.titleIncludes;
    const oldKeywords = ['总体评价', '总体满意', '满意度'];
    const originalDefault = stored.unmatchedStrategy === 'highlight' && rule &&
      (rule.enabled === true || rule.enabled === undefined) &&
      Object.keys(stored).every(key => ['rules', 'unmatchedStrategy'].includes(key)) &&
      Object.keys(rule).every(key => ['id', 'enabled', 'match', 'action'].includes(key)) &&
      Object.keys(rule.match || {}).every(key => key === 'titleIncludes') &&
      Array.isArray(keywords) && new Set(keywords).size === oldKeywords.length &&
      keywords.every(word => oldKeywords.includes(word)) &&
      rule.action && rule.action.strategy === 'best' &&
      Object.keys(rule.action).every(key => key === 'strategy');
    return originalDefault ? DEFAULT_RULESET : stored;
  }

  function matchRule(question, rules) {
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      const kws = (rule.match && rule.match.titleIncludes) || [];
      if (kws.length > 0 && kws.some(k => question.title.includes(k))) return rule;
    }
    return null;
  }

  function bestOptionIndex(options) {
    let best = -1;
    let bestRank = Infinity;
    options.forEach((text, index) => {
      // 先识别最长的完整评价词，避免“不满意”被其中的“满意”覆盖。
      const words = BEST_WORDS.filter(word => text.includes(word))
        .sort((a, b) => b.length - a.length);
      if (!words.length) return;
      const word = words[0];
      const prefix = text.slice(0, text.indexOf(word));
      if (/[不没无]/.test(prefix)) return;
      const rank = BEST_WORDS.indexOf(word);
      if (rank < bestRank) { best = index; bestRank = rank; }
    });
    return best;
  }

  function resolveOne(question, rule, unmatchedStrategy) {
    const res = { questionId: question.id, matchedRuleId: rule ? rule.id : null, optionIndexes: [], textValue: null };
    if (question.type === 'text') {
      if (rule && rule.action.strategy === 'fillText' && rule.action.text) res.textValue = rule.action.text;
      return res;
    }
    let strategy = rule ? rule.action.strategy : (question.required && unmatchedStrategy === 'best' ? 'best' : 'skip');
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

  const Engine = { cleanTitle, DEFAULT_RULESET, BEST_WORDS, getRuleset, matchRule, bestOptionIndex, resolveAnswers };
  global.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);


// 来源：本项目 content/selectors.js
// 所有页面选择器集中于此。平台改版时只改这个文件。
// 现行命名 index__x--hash（2026-10 实测），兼容旧版 index_x-。
window.SELECTORS = {
  questionBlock: "[class^='index__subject--'], [class^='index_subject-']",
  requiredMark: "[class^='index__necessary--'], [class^='index_necessary']",
  title: "[class^='index__title--'], [class^='index_title']",
  titleCounter: "[class^='index__numCount--'], [class^='index_numCount']",
  optionRow: 'label.ant-radio-wrapper, label.ant-checkbox-wrapper',
  radioLabel: "label.ant-radio-wrapper",
  checkboxLabel: "label.ant-checkbox-wrapper",
  disabledLabel: '.ant-radio-wrapper-disabled, .ant-checkbox-wrapper-disabled',
  activeTeacher: ".ant-tabs-tab-active, [role='tab'][aria-selected='true']",
  teacherTab: '[role="tab"]',
  nextCourseText: '下一课程',
  taskTable: '.ant-tabs-tabpane-active .ant-table',
  taskNextPage: '.ant-pagination-next',
  loading: '.ant-spin-spinning, [aria-busy="true"]',
  submitDialog: '.ant-modal, .ant-modal-confirm, [role="dialog"]',
  submitSuccess: '.ant-message-success, .ant-notification-notice-success, [role="status"][data-submit-success]',
  submitError: '.ant-message-error, .ant-notification-notice-error, .ant-form-explain, .ant-alert-error',
  submitButton: "button[class*='index__submit'], button[class*='index_submit']",
  textarea: "textarea",
  ignoreButtonText: "忽略",
  confirmButton: "button.ant-btn-primary"
};


// 来源：本项目 content/content.js
(function () {
  'use strict';
  const Engine = window.Engine;
  const S = window.SELECTORS;
  let applying = false;
  let batchRunId = 0;
  const batch = { running: false, phase: 'idle', completed: 0, skipped: 0, reason: null };

  function isVisible(el) {
    return !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  }

  function extractQuestions() {
    return [...document.querySelectorAll(S.questionBlock)]
      .filter(block => isVisible(block) && block.querySelector(S.title))
      .map((block, idx) => {
        const inputEl = block.querySelector(S.textarea);
        const optionEls = [...block.querySelectorAll(S.optionRow)];
        const title = block.querySelector(S.title).cloneNode(true);
        title.querySelectorAll(S.titleCounter).forEach(el => el.remove());
        return {
          question: {
            id: 'q' + idx,
            title: Engine.cleanTitle(title.textContent),
            required: !!block.querySelector(S.requiredMark),
            type: inputEl ? 'text' : (block.querySelector(S.checkboxLabel) ? 'multi' : 'single'),
            options: optionEls.map(el => el.textContent.replace(/\s+/g, ''))
          },
          blockEl: block,
          optionEls,
          inputEl
        };
      });
  }

  function submitButton() {
    return [...document.querySelectorAll(S.submitButton)].find(isVisible);
  }

  function isReadonly(entries = extractQuestions()) {
    const btn = submitButton();
    if (btn && /已提交|已完成/.test(btn.textContent)) return true;
    return entries.length > 0 && entries.every(c => c.inputEl
      ? c.inputEl.disabled || c.inputEl.readOnly
      : c.optionEls.length > 0 && c.optionEls.every(isDisabled));
  }

  function isDisabled(label) {
    const input = label.querySelector('input');
    return label.matches(S.disabledLabel) || !input || input.disabled;
  }

  function capture() {
    const entries = extractQuestions();
    const context = location.href + [...document.querySelectorAll(S.activeTeacher)]
      .map(el => el.textContent).join('|');
    const signature = JSON.stringify(entries.map(c => c.question));
    const button = submitButton();
    const values = JSON.stringify(entries.map(c => c.inputEl ? c.inputEl.value :
      c.optionEls.map(el => !!el.querySelector('input')?.checked)));
    return { entries, context, signature, button, buttonText: button?.textContent, values };
  }

  function sameForm(a, b, checkButtonText = true) {
    return a.signature === b.signature && a.button === b.button && (!checkButtonText || a.buttonText === b.buttonText) &&
      a.values === b.values && a.entries.length === b.entries.length &&
      a.entries.every((c, i) => c.blockEl === b.entries[i].blockEl && c.inputEl === b.entries[i].inputEl &&
        c.optionEls.every((el, j) => el === b.entries[i].optionEls[j]));
  }

  function isCurrent(snapshot) {
    const now = capture();
    return now.context === snapshot.context && now.signature === snapshot.signature &&
      now.entries.length === snapshot.entries.length && now.entries.every((c, i) => {
        const old = snapshot.entries[i];
        return c.blockEl === old.blockEl && c.inputEl === old.inputEl &&
          c.optionEls.every((el, j) => el === old.optionEls[j]);
      });
  }

  async function resolveCurrent() {
    const snapshot = capture();
    if (!snapshot.entries.length) return { ok: false, reason: 'no-questionnaire' };
    let data;
    try { data = await chrome.storage.sync.get('ruleset'); }
    catch { return { ok: false, reason: 'storage-error' }; }
    if (!isCurrent(snapshot)) return { ok: false, reason: 'page-changed' };
    const ruleset = Engine.getRuleset(data.ruleset);
    const answers = Engine.resolveAnswers(snapshot.entries.map(c => c.question), ruleset);
    return { ok: true, snapshot, answers, ruleset };
  }

  async function getStatus() {
    const result = await resolveCurrent();
    if (!result.ok) return { ...result, batch: { ...batch } };
    const { entries } = result.snapshot;
    const covered = r => r.optionIndexes.length > 0 || r.textValue !== null;
    const requiredAnswers = result.answers.filter((r, i) => entries[i].question.required);
    return {
      ok: true, readonly: isReadonly(entries), total: entries.length,
      ...answerProgress(entries),
      matched: requiredAnswers.filter(covered).length,
      matchedTotal: result.answers.filter(covered).length,
      batch: { ...batch },
      templateIsDefault: JSON.stringify(result.ruleset) === JSON.stringify(Engine.DEFAULT_RULESET),
      unmatchedTitles: result.answers.filter((r, i) => entries[i].question.required && !covered(r) && !isAnswered(entries[i]))
        .map(r => entries.find(c => c.question.id === r.questionId).question.title)
    };
  }

  function isAnswered(c) {
    return c.inputEl ? !!c.inputEl.value.trim()
      : c.optionEls.some(label => label.querySelector('input')?.checked);
  }

  function answerProgress(entries) {
    const required = entries.filter(c => c.question.required);
    const missing = required.filter(c => !isAnswered(c));
    return { required: required.length, answered: required.length - missing.length,
      answeredTotal: entries.filter(isAnswered).length,
      unansweredTitles: missing.map(c => c.question.title) };
  }

  function clearMarks() {
    document.querySelectorAll('.ugh-mark, .ugh-mark-text').forEach(el => el.classList.remove('ugh-mark', 'ugh-mark-text'));
    return { ok: true };
  }

  async function preview() {
    const result = await resolveCurrent();
    if (!result.ok) return result;
    clearMarks();
    let marked = 0;
    result.answers.forEach((r, i) => {
      const c = result.snapshot.entries[i];
      if (!isReadonly(result.snapshot.entries) && isAnswered(c)) return;
      r.optionIndexes.forEach(oi => {
        if (c.optionEls[oi]) { c.optionEls[oi].classList.add('ugh-mark'); marked++; }
      });
      if (r.textValue !== null && c.inputEl) { c.inputEl.classList.add('ugh-mark-text'); marked++; }
    });
    return { ok: true, marked };
  }

  function setTextareaValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function hasUnanswered(entries) {
    return entries.some(c => c.question.required && !isAnswered(c));
  }

  async function apply(autoSubmit = false, overwrite = false, runId = null) {
    if (applying || (batch.running && runId !== batchRunId)) return { ok: false, reason: 'busy' };
    const cancelled = () => runId !== null && (!batch.running || runId !== batchRunId);
    if (cancelled()) return { ok: false, reason: 'stopped' };
    applying = true;
    let filled = 0;
    try {
      const result = await resolveCurrent();
      if (!result.ok) return result;
      const { snapshot, answers } = result;
      if (cancelled()) return { ok: false, reason: 'stopped' };
      const { entries } = snapshot;
      if (isReadonly(entries)) return { ok: false, filled, submitted: false, reason: 'readonly' };
      for (let i = 0; i < entries.length; i++) {
        if (cancelled()) return { ok: false, filled, reason: 'stopped' };
        if (!isCurrent(snapshot)) return { ok: false, filled, submitted: false, reason: 'page-changed' };
        const c = entries[i];
        const r = answers[i];
        if (!overwrite && isAnswered(c)) continue;
        if (overwrite && c.question.type === 'multi' && r.optionIndexes.length) {
          const wanted = new Set(r.optionIndexes);
          c.optionEls.forEach((label, oi) => {
            if (!isDisabled(label) && label.querySelector('input').checked !== wanted.has(oi)) {
              label.click();
              filled++;
            }
          });
        }
        for (const oi of r.optionIndexes) {
          const label = c.optionEls[oi];
          if (label && !isDisabled(label) && !label.querySelector('input').checked) {
            label.click();
            filled++;
          }
        }
        if (r.textValue !== null && c.inputEl && !c.inputEl.disabled && !c.inputEl.readOnly &&
            c.inputEl.value !== r.textValue && (c.inputEl.maxLength < 0 || r.textValue.length <= c.inputEl.maxLength)) {
          setTextareaValue(c.inputEl, r.textValue);
          filled++;
        }
      }
      const done = reason => ({ ok: true, filled, submitted: false, ...answerProgress(entries), ...(reason ? { reason } : {}) });
      if (!autoSubmit) return done();
      if (hasUnanswered(entries)) return done('unanswered');
      const btn = submitButton();
      if (!btn) return done('submit-unavailable');
      const start = Date.now();
      while (true) {
        if (cancelled()) return done('stopped');
        if (!isCurrent(snapshot) || btn !== submitButton()) return done('page-changed');
        if (isReadonly(entries)) return done('readonly');
        if (hasUnanswered(entries)) return done('unanswered');
        if (!btn.disabled && !btn.hasAttribute('disabled')) break;
        if (Date.now() - start >= (runId === null ? 15000 : 120000)) return done('submit-timeout');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (runId !== null) batch.phase = 'submitting';
      btn.click();
      return { ok: true, filled, submitted: true, ...answerProgress(entries) };
    } finally { applying = false; }
  }

  const wait = () => new Promise(resolve => setTimeout(resolve, 150));
  const compact = text => String(text || '').replace(/\s+/g, '');
  const batchActive = id => batch.running && batchRunId === id;
  const fail = reason => { throw new Error(reason); };
  function teacherTabs() {
    const active = document.querySelector(S.activeTeacher);
    const container = active?.closest('.ant-tabs');
    return [...(container || document).querySelectorAll(S.teacherTab)]
      .filter(el => isVisible(el) && el.getAttribute('aria-disabled') !== 'true');
  }
  function questionnaireKey() {
    const tabs = teacherTabs();
    const active = tabs.find(el => el.matches(S.activeTeacher));
    return location.href + '|' + (active ? tabs.indexOf(active) + ':' + compact(active.textContent) : 'current');
  }
  function taskScope(hash = location.hash) {
    // The course segment may change; the evaluation task and semester must not.
    const match = hash.match(/^(#\/my-task\/answer\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+)\/[^/?]+\/([^/?]+)(\?[^#]*)?$/);
    return match ? match[1] + '/' + match[2] + (match[3] || '') : null;
  }
  function isTaskTransition(scope) {
    // The platform remounts the next course through /middle-page/<encoded route>.
    // Only tolerate a redirect back into the task that started this batch.
    const prefix = '#/middle-page/';
    if (!scope || !location.hash.startsWith(prefix)) return false;
    try {
      const target = decodeURIComponent(location.hash.slice(prefix.length));
      return taskScope('#' + target) === scope;
    } catch { return false; }
  }
  function loading() {
    return [...document.querySelectorAll(S.loading)].some(isVisible);
  }
  async function waitReady(id, scope, changed, detailsUrl = null) {
    const start = Date.now();
    let stable = null, since = 0;
    while (batchActive(id)) {
      if (detailsUrl && location.href === detailsUrl) return null;
      const transitioning = isTaskTransition(scope);
      if (!transitioning && taskScope() !== scope) fail('left-task');
      const now = capture();
      const ready = !transitioning && now.entries.length && submitButton() && !loading() && (!changed || changed(now));
      if (ready) {
        if (!stable || !isCurrent(stable) || !sameForm(now, stable)) { stable = now; since = Date.now(); }
        if (Date.now() - since >= 450) return now;
      } else stable = null;
      if (Date.now() - start > 20000) fail('navigation-timeout');
      await wait();
    }
    fail('stopped');
  }
  function notices(selector) {
    return [...document.querySelectorAll(selector)].filter(isVisible);
  }
  async function confirmSubmission(id, oldButton, oldNotices, scope, detailsUrl) {
    const start = Date.now();
    const clickedButtons = new Map();
    let received = false;
    const successText = text => /(?:提交|评价|评教)(?:已)?(?:成功|完成)|成功(?:提交|评价|评教)|感谢.*(?:评价|评教)/.test(compact(text));
    batch.phase = 'confirming';
    while (batchActive(id)) {
      if (isTaskTransition(scope)) {
        if (Date.now() - start > 20000) fail('submission-unconfirmed');
        await wait();
        continue;
      }
      if (location.href !== detailsUrl && taskScope() !== scope) fail('left-task');
      if (notices(S.submitError).some(el => compact(el.textContent) && oldNotices.get(el) !== el.textContent)) fail('submission-failed');
      const dialogs = notices(S.submitDialog).filter(el => oldNotices.get(el) !== el.textContent);
      const successDialogs = dialogs.filter(el => successText(el.textContent));
      received ||= /已提交|已完成/.test(oldButton.textContent) || successDialogs.length > 0 ||
        notices(S.submitSuccess).some(el => oldNotices.get(el) !== el.textContent && successText(el.textContent));
      // The platform can acknowledge success in a modal whose primary action advances
      // to the next teacher/course. Drain that modal before inspecting the old form.
      for (const dialog of successDialogs.length ? successDialogs : dialogs.filter(el => /提交/.test(el.textContent))) {
        const button = [...dialog.querySelectorAll('button')].find(el => isVisible(el) && !el.disabled &&
          /^(确定|确认|提交|确认提交|确定提交|下一位教师|下一课程)$/.test(compact(el.textContent)));
        if (!button || clickedButtons.get(button) === dialog.textContent) continue;
        const text = compact(button.textContent);
        if (!successDialogs.includes(dialog) && /^(下一位教师|下一课程)$/.test(text)) continue;
        clickedButtons.set(button, dialog.textContent);
        const old = capture();
        button.click();
        if (/^(下一位教师|下一课程)$/.test(text)) {
          return { old, phase: text === '下一位教师' ? 'next-teacher' : 'next-course' };
        }
        break;
      }
      // Even when the old submit button already reads "submitted", dismiss a visible
      // success modal first. A delayed dismissal must not trigger clicks behind it.
      if (received && !successDialogs.some(isVisible)) return;
      if (Date.now() - start > 20000) fail('submission-unconfirmed');
      await wait();
    }
    fail('stopped');
  }
  async function nextPendingCourse(id, detailsUrl, attempted, scope) {
    batch.phase = 'checking-task';
    if (location.href !== detailsUrl) {
      const link = [...document.querySelectorAll('a[href]')].find(el => el.href === detailsUrl);
      if (!link) fail('navigation-unavailable');
      link.click();
    }
    const seenPages = new Set();
    let pendingRows = false;
    while (batchActive(id)) {
      const start = Date.now();
      let rows, table, fingerprint = '', since = Date.now();
      while (batchActive(id)) {
        if (location.href !== detailsUrl) { if (Date.now() - start > 20000) fail('left-task'); }
        table = [...document.querySelectorAll(S.taskTable)].find(isVisible);
        rows = table ? [...table.querySelectorAll('tbody tr[data-row-key]')].filter(isVisible) : [];
        const value = table?.textContent;
        if (value !== fingerprint || loading()) { fingerprint = value; since = Date.now(); }
        if (location.href === detailsUrl && table && !loading() && Date.now() - since >= 600) break;
        if (Date.now() - start > 20000) fail('navigation-timeout');
        await wait();
      }
      if (!batchActive(id)) fail('stopped');
      const pageKey = rows.map(el => el.getAttribute('data-row-key')).join('|');
      if (seenPages.has(pageKey)) fail('navigation-loop');
      seenPages.add(pageKey);
      pendingRows ||= rows.length > 0;
      for (const row of rows) {
        const action = [...row.querySelectorAll('td:last-child span,td:last-child a,td:last-child button')]
          .find(el => compact(el.textContent) === '评价' && isVisible(el));
        const rowKey = row.getAttribute('data-row-key');
        if (!action || attempted.has(rowKey)) continue;
        attempted.add(rowKey);
        action.click();
        const navigationStart = Date.now();
        while (batchActive(id) && location.href === detailsUrl) {
          if (Date.now() - navigationStart > 20000) fail('navigation-timeout');
          await wait();
        }
        await waitReady(id, scope);
        return true;
      }
      const pagination = table.closest('.ant-tabs-tabpane') || document;
      const next = pagination.querySelector(S.taskNextPage);
      if (!next || next.classList.contains('ant-pagination-disabled') || next.getAttribute('aria-disabled') === 'true') {
        // An unfinished row still present after being processed is not proof of completion.
        if (pendingRows) fail('pending-questionnaires');
        return false;
      }
      const oldTable = table, oldText = table.textContent;
      next.click();
      const pageStart = Date.now();
      while (batchActive(id) && oldTable.isConnected && oldTable.textContent === oldText) {
        if (Date.now() - pageStart > 20000) fail('navigation-timeout');
        await wait();
      }
    }
    fail('stopped');
  }
  async function runBatch(id, scope, detailsUrl) {
    const visited = new Set();
    const courses = new Set([location.href]);
    const attemptedCourses = new Set();
    try {
      while (batchActive(id)) {
        if (detailsUrl && location.href === detailsUrl) {
          if (!await nextPendingCourse(id, detailsUrl, attemptedCourses, scope)) { batch.phase = 'completed'; break; }
        }
        await waitReady(id, scope);
        const key = questionnaireKey();
        if (!visited.has(key)) {
          if (isReadonly()) { batch.skipped++; visited.add(key); }
          else {
            batch.phase = 'filling';
            const button = submitButton();
            const oldNotices = new Map(notices(S.submitSuccess + ',' + S.submitError + ',' + S.submitDialog).map(el => [el, el.textContent]));
            const result = await apply(true, false, id);
            if (!result.ok || !result.submitted) fail(result.reason || 'submission-unconfirmed');
            const continuation = await confirmSubmission(id, button, oldNotices, scope, detailsUrl);
            if (!batchActive(id)) fail('stopped');
            batch.completed++;
            visited.add(key);
            if (continuation) {
              batch.phase = continuation.phase;
              const old = continuation.old;
              // Changing the old button to "submitted" does not prove that the
              // next questionnaire has loaded. Require changed fields or nodes.
              await waitReady(id, scope, now => now.context !== old.context && !sameForm(now, old, false), detailsUrl);
              continue;
            }
            // Some platform versions advance immediately after a successful submit.
            if (questionnaireKey() !== key) continue;
          }
        }
        const tabs = teacherTabs();
        const next = tabs.find((el, index) => !visited.has(location.href + '|' + index + ':' + compact(el.textContent)));
        if (next) {
          batch.phase = 'next-teacher';
          const old = capture();
          const targetKey = location.href + '|' + tabs.indexOf(next) + ':' + compact(next.textContent);
          next.click();
          await waitReady(id, scope, now => questionnaireKey() === targetKey && !sameForm(now, old));
          continue;
        }
        const nextCourse = [...document.querySelectorAll('button')]
          .find(el => isVisible(el) && compact(el.textContent) === S.nextCourseText);
        if (!nextCourse || nextCourse.disabled || nextCourse.getAttribute('aria-disabled') === 'true') {
          if (detailsUrl && await nextPendingCourse(id, detailsUrl, attemptedCourses, scope)) continue;
          batch.phase = 'completed'; batch.reason = null; break;
        }
        batch.phase = 'next-course';
        const oldUrl = location.href, oldForm = capture();
        nextCourse.click();
        const nextForm = await waitReady(id, scope, now => location.href !== oldUrl && !sameForm(now, oldForm), detailsUrl);
        if (!nextForm) continue;
        if (courses.has(location.href)) {
          if (detailsUrl && await nextPendingCourse(id, detailsUrl, attemptedCourses, scope)) continue;
          batch.phase = 'completed'; batch.reason = null; break;
        }
        courses.add(location.href);
      }
    } catch (error) {
      if (id !== batchRunId) return;
      if (!batch.running && batch.reason) return;
      batch.reason = error.message;
      batch.phase = error.message === 'stopped' || error.message === 'page-changed' ? 'stopped' : 'error';
    } finally {
      if (id === batchRunId) batch.running = false;
    }
  }
  function startBatch() {
    if (batch.running) return { ok: true, batch: { ...batch } };
    if (applying) return { ok: false, reason: 'busy' };
    if (!extractQuestions().length) return { ok: false, reason: 'no-questionnaire' };
    const detailsUrl = [...document.querySelectorAll('a[href]')]
      .find(el => el.origin === location.origin && el.hash.startsWith('#/my-task/details/'))?.href;
    if (!detailsUrl) return { ok: false, reason: 'navigation-unavailable' };
    const scope = taskScope();
    if (!scope) return { ok: false, reason: 'navigation-unavailable' };
    Object.assign(batch, { running: true, phase: 'filling', completed: 0, skipped: 0, reason: null });
    const id = ++batchRunId;
    runBatch(id, scope, detailsUrl);
    return { ok: true, batch: { ...batch } };
  }
  function stopBatch(reason = 'stopped') {
    if (batch.running) { batch.running = false; batch.phase = 'stopped'; batch.reason = reason; }
    return { ok: true, batch: { ...batch } };
  }
  // A user's navigation or answer change takes precedence over the running batch.
  // Label.click() also emits trusted input/change events; pointer/key events identify user intervention.
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, event => {
    if (!batch.running || !event.isTrusted) return;
    if (event.composedPath().some(el => el.id === 'ugh-userscript-root')) return;
    stopBatch('page-changed');
  }, true);

  function ignoreCurrent() {
    if (applying || batch.running || !extractQuestions().length || isReadonly()) return;
    const btn = [...document.querySelectorAll('button')]
      .find(b => isVisible(b) && !b.disabled && b.textContent.trim() === S.ignoreButtonText);
    if (btn) btn.click();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'GET_STATUS': return getStatus();
        case 'PREVIEW': return preview();
        case 'APPLY': return apply(msg.autoSubmit === true, msg.overwrite === true);
        case 'START_BATCH': return startBatch();
        case 'STOP_BATCH': return stopBatch();
        case 'CLEAR': return clearMarks();
        default: return { ok: false, reason: 'unknown-message' };
      }
    })().then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }));
    return true;
  });

  document.addEventListener('keyup', e => {
    const target = e.composedPath?.()[0] || e.target;
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey ||
        target?.isContentEditable || target?.closest?.('input, textarea, select, button, a, label, [role="button"], [role="textbox"], [role="combobox"], [contenteditable]')) return;
    // 快捷键只填选；自动提交必须由弹窗中本次明确勾选并点击应用。
    if (e.key === 'Enter') apply().catch(() => {});
    else if (e.key === 'Backspace') ignoreCurrent();
  });

  window.__ugh = { extractQuestions, isReadonly, getStatus, preview, apply, clearMarks, startBatch, stopBatch };
})();


// 来源：本项目 userscript/shell.js
// 用户脚本界面与存储适配。核心填选逻辑仍来自 content/，不复制另一份实现。
function createShell(popupHtml, optionsHtml) {
  const host = document.createElement('div');
  host.id = 'ugh-userscript-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #27324b;
        pointer-events: none; color-scheme: light; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button { font: inherit; }
      button:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 3px; }
      #ugh-launcher { display: flex; align-items: center; gap: 9px; padding: 10px 14px;
        border: 1px solid #355ac2; border-radius: 14px; background: #3f66d5;
        color: white; cursor: grab; box-shadow: 0 4px 16px #294caa30, 0 1px 3px #24357822;
        pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
      #ugh-launcher:hover { background: #3156bc; }
      #ugh-launcher.dragging { cursor: grabbing; box-shadow: 0 9px 25px #3949ab45; }
      .ugh-launcher-icon { display: grid; place-items: center; width: 26px; height: 26px;
        border-radius: 8px; background: #ffffff21; font-size: 16px; font-weight: 700; line-height: 1; }
      .ugh-launcher-text { font-weight: 600; letter-spacing: .4px; }
      .ugh-grip { opacity: .6; font-size: 15px; letter-spacing: -3px; padding-right: 3px; }
      #ugh-panel { position: fixed; width: min(392px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
        overflow: auto; overscroll-behavior: contain; border: 1px solid #dfe5ef; border-radius: 16px;
        background: #fff; box-shadow: 0 16px 48px #23386722, 0 3px 12px #23386710; pointer-events: auto;
        scrollbar-width: thin; scrollbar-color: #c9d3e4 transparent; }
      #ugh-panel.settings { width: min(760px, calc(100vw - 24px)); }
      #ugh-toolbar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: flex-end; gap: 6px;
        padding: 9px 14px; border-bottom: 1px solid #edf0f5; background: #fff; }
      .ugh-toolbar-label { margin-right: auto; color: #63728a; font-size: 11px; font-weight: 600; letter-spacing: .5px; }
      #ugh-toolbar button { min-height: 28px; padding: 3px 9px; border: 0; border-radius: 6px;
        background: #f1f4f9; color: #53627b; cursor: pointer; font-size: 12px; }
      #ugh-toolbar button:hover { color: #4263eb; background: #edf0ff; }
      .ugh-popup { padding: 16px 18px; }
      .ugh-note { margin: 0; padding: 10px 18px; border-top: 1px solid #edf0f5;
        background: #f8fafc; font-size: 11px; line-height: 1.6; color: #63728a; }
      @media (prefers-reduced-motion: no-preference) { #ugh-launcher { transition: box-shadow .15s, background .15s; } }
    </style>
    <section id="ugh-panel" aria-label="USTC评教助手" hidden>
      <div id="ugh-toolbar"><span class="ugh-toolbar-label">问卷速填 · 非官方工具</span><button id="ugh-back" hidden>← 返回</button><button id="ugh-close" aria-label="收起评教助手" title="收起面板（Esc）">收起</button></div>
      <div class="ugh-popup">${popupHtml}</div>
      <div id="ugh-options-host" hidden></div>
      <p class="ugh-note">请按实际情况调整答案 · 拖动下方入口可移动面板</p>
    </section>
    <button id="ugh-launcher" aria-expanded="false" aria-controls="ugh-panel" title="点击打开，拖动调整位置"><span class="ugh-launcher-icon" aria-hidden="true">✓</span><span class="ugh-launcher-text">评教助手</span><span class="ugh-grip" aria-hidden="true">⠿</span></button>`;
  const optionsHost = root.getElementById('ugh-options-host');
  const optionsRoot = optionsHost.attachShadow({ mode: 'open' });
  optionsRoot.innerHTML = `<div class="ugh-options">${optionsHtml}</div><style>
    :host { display: block; color-scheme: light; } * { box-sizing: border-box; } [hidden] { display: none !important; }
    .ugh-options { padding: 18px; }
  </style>`;
  document.documentElement.appendChild(host);

  function scope(node) {
    return {
      getElementById: id => node.querySelector('#' + id),
      querySelectorAll: selector => node.querySelectorAll(selector),
      createElement: name => document.createElement(name)
    };
  }
  const panel = root.getElementById('ugh-panel');
  const popup = root.querySelector('.ugh-popup');
  const autoSubmit = popup.querySelector('#autosubmit');
  const launcher = root.getElementById('ugh-launcher');
  const back = root.getElementById('ugh-back');
  let timer;
  let pageKey = '';
  let launcherPosition = { right: 16, bottom: 16 };
  let positionTouched = false;
  let drag = null;
  let suppressClick = false;
  let suppressClickTimer;
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  function viewport() {
    return { width: document.documentElement.clientWidth || innerWidth,
      height: document.documentElement.clientHeight || innerHeight };
  }

  function placePanel() {
    if (panel.hidden) return;
    const { width, height } = viewport();
    const margin = Math.min(12, width / 4, height / 4);
    const anchor = launcher.getBoundingClientRect();
    const above = Math.max(0, anchor.top - margin - 10);
    const below = Math.max(0, height - anchor.bottom - margin - 10);
    // Keep the launcher accessible even when the panel needs to scroll.
    panel.style.maxHeight = Math.max(above, below) + 'px';
    const bounds = panel.getBoundingClientRect();
    const left = clamp(anchor.right - bounds.width, margin, Math.max(margin, width - bounds.width - margin));
    let top = anchor.top - bounds.height - 10;
    if (top < margin && below >= bounds.height) top = anchor.bottom + 10;
    top = clamp(top, margin, Math.max(margin, height - bounds.height - margin));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function placeLauncher() {
    const { width, height } = viewport();
    const bounds = launcher.getBoundingClientRect();
    const maxRight = Math.max(0, width - bounds.width - 12);
    const maxBottom = Math.max(0, height - bounds.height - 12);
    launcherPosition.right = clamp(launcherPosition.right, Math.min(12, maxRight), maxRight);
    launcherPosition.bottom = clamp(launcherPosition.bottom, Math.min(12, maxBottom), maxBottom);
    host.style.right = launcherPosition.right + 'px';
    host.style.bottom = launcherPosition.bottom + 'px';
    placePanel();
  }

  function savePosition() {
    // Some script managers reject storage access; the current session must remain usable.
    try { Promise.resolve(GM.setValue('launcherPosition', { ...launcherPosition })).catch(() => {}); }
    catch (_) {}
  }

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    launcher.classList.remove('dragging');
    if (launcher.hasPointerCapture && launcher.hasPointerCapture(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
    if (moved) {
      savePosition();
      // The compatibility click follows pointerup. Consume only that click, then allow a real click.
      suppressClick = true;
      clearTimeout(suppressClickTimer);
      suppressClickTimer = setTimeout(() => { suppressClick = false; }, 500);
    }
  }

  const shell = {
    popupDocument: scope(popup),
    optionsDocument: scope(optionsRoot),
    refresh: null,
    scheduleRefresh() {
      const key = location.href + [...document.querySelectorAll(window.SELECTORS.activeTeacher)]
        .map(el => el.textContent).join('|');
      if (key !== pageKey) {
        autoSubmit.checked = false;
        pageKey = key;
        popup.querySelector('#msg').textContent = '';
        window.__ugh.clearMarks();
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (shell.refresh) shell.refresh().catch(() => {});
      }, 150);
    },
    show(settings = false) {
      if (settings) window.__ugh.stopBatch();
      autoSubmit.checked = false;
      panel.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      popup.hidden = settings;
      optionsHost.hidden = !settings;
      back.hidden = !settings;
      panel.classList.toggle('settings', settings);
      panel.scrollTop = 0;
      placePanel();
      shell.scheduleRefresh();
    },
    close() {
      autoSubmit.checked = false;
      panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
      launcher.focus({ preventScroll: true });
    },
    start() {
      launcher.addEventListener('pointerdown', event => {
        if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
        positionTouched = true;
        suppressClick = false;
        clearTimeout(suppressClickTimer);
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          right: launcherPosition.right, bottom: launcherPosition.bottom, moved: false };
        try { launcher.setPointerCapture(event.pointerId); } catch (_) {}
      });
      launcher.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        event.preventDefault();
        launcher.classList.add('dragging');
        launcherPosition = { right: drag.right - dx, bottom: drag.bottom - dy };
        placeLauncher();
      });
      launcher.addEventListener('pointerup', finishDrag);
      launcher.addEventListener('pointercancel', finishDrag);
      launcher.addEventListener('lostpointercapture', finishDrag);
      launcher.onclick = event => {
        if (suppressClick && event.detail !== 0) {
          suppressClick = false;
          clearTimeout(suppressClickTimer);
          event.preventDefault();
          return;
        }
        panel.hidden ? shell.show() : shell.close();
      };
      root.getElementById('ugh-close').onclick = () => shell.close();
      back.onclick = () => shell.show();
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.isComposing && !panel.hidden) {
          event.stopPropagation();
          shell.close();
        }
      });
      // popup 的 onclick 已先读取本次勾选；点击后立即复位，下一次须重新勾选。
      for (const id of ['apply', 'refill']) {
        const button = popup.querySelector('#' + id);
        if (button) button.addEventListener('click', () => { autoSubmit.checked = false; });
      }
      new MutationObserver(() => {
        if (!host.isConnected) document.documentElement.appendChild(host);
        shell.scheduleRefresh();
      }).observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'disabled', 'hidden', 'aria-selected'] });
      document.addEventListener('input', shell.scheduleRefresh);
      document.addEventListener('change', shell.scheduleRefresh);
      document.addEventListener('keyup', e => {
        if (!panel.hidden && !optionsHost.hidden && (e.key === 'Enter' || e.key === 'Backspace')) e.stopImmediatePropagation();
      }, true);
      addEventListener('resize', () => {
        placeLauncher();
        if (positionTouched) savePosition();
      });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(placePanel).observe(panel);
      placeLauncher();
      try {
        Promise.resolve(GM.getValue('launcherPosition', null)).then(saved => {
          if (positionTouched || !saved || typeof saved.right !== 'number' || typeof saved.bottom !== 'number' ||
              !Number.isFinite(saved.right) || !Number.isFinite(saved.bottom)) return;
          launcherPosition = { right: saved.right, bottom: saved.bottom };
          placeLauncher();
        }).catch(() => {});
      } catch (_) {}
      addEventListener('hashchange', shell.scheduleRefresh);
      GM.registerMenuCommand('USTC评教助手：打开面板', () => shell.show());
      GM.registerMenuCommand('USTC评教助手：规则设置', () => shell.show(true));
      shell.scheduleRefresh();
    }
  };
  return shell;
}


  const marks = document.createElement('style');
  marks.textContent = ".ugh-mark { outline: 3px solid #faad14 !important; outline-offset: 2px; border-radius: 4px; }\n.ugh-mark-text { outline: 3px dashed #faad14 !important; outline-offset: 2px; }\n";
  document.head.appendChild(marks);
  shell = createShell("<style>\n  .ugh-popup { width: auto; margin: 0; padding: 18px; box-sizing: border-box; background: #fff; color: #21304a; font: 13px/1.6 \"Segoe UI\", \"Microsoft YaHei\", sans-serif; }\n  .ugh-popup * { box-sizing: border-box; }\n  .ugh-popup [hidden] { display: none !important; }\n  .ugh-popup .hero { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }\n  .ugh-popup .app-icon { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid #dce6fb; border-radius: 12px; background: #eff4ff; color: #365fce; flex-shrink: 0; }\n  .ugh-popup h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -.4px; line-height: 1.4; }\n  .ugh-popup .subtitle { margin: 3px 0 0; color: #63728a; font-size: 12px; }\n  .ugh-popup .status-card { padding: 14px 16px; border: 1px solid #dfe7f4; border-radius: 12px; background: #f5f8ff; }\n  .ugh-popup .status-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #51627d; font-size: 12px; font-weight: 600; }\n  .ugh-popup #counter { color: #365fce; font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: -1px; font-variant-numeric: tabular-nums; }\n  .ugh-popup progress { display: block; appearance: none; width: 100%; height: 6px; margin: 12px 0 10px; border: 0; border-radius: 8px; overflow: hidden; background: #e1e8f5; accent-color: #4169d5; }\n  .ugh-popup progress::-webkit-progress-bar { background: #e1e8f5; border-radius: 8px; }\n  .ugh-popup progress::-webkit-progress-value { background: #4169d5; border-radius: 8px; }\n  .ugh-popup progress::-moz-progress-bar { background: #4169d5; border-radius: 8px; }\n  .ugh-popup .stat { color: #425570; font-size: 12px; }\n  .ugh-popup .warn { color: #945c1e; }\n  .ugh-popup #coverage { color: #62728b; font-size: 12px; margin-top: 3px; }\n  .ugh-popup #unmatched { font-size: 12px; color: #885619; background: #fff8eb; border-radius: 6px; padding: 7px 9px; max-height: 84px; overflow: auto; overflow-wrap: anywhere; margin-top: 9px; }\n  .ugh-popup #unmatched:empty { display: none; }\n  .ugh-popup .preset { margin: 16px 0; }\n  .ugh-popup .preset-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }\n  .ugh-popup #preset-name { font-size: 13px; font-weight: 600; }\n  .ugh-popup .chips { display: flex; flex-wrap: wrap; gap: 6px; }\n  .ugh-popup .chips span { padding: 4px 8px; border: 1px solid #e8ecf3; border-radius: 6px; background: #f8f9fc; color: #53627b; font-size: 12px; }\n  .ugh-popup .chips b { color: #304766; font-weight: 600; }\n  .ugh-popup .preset-caption { margin: 8px 0 0; color: #63728a; font-size: 12px; }\n  .ugh-popup button { font: inherit; cursor: pointer; border-radius: 9px; }\n  .ugh-popup :focus-visible { outline: 3px solid #a8bff7; outline-offset: 3px; }\n  .ugh-popup button:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }\n  .ugh-popup #settings { padding: 3px 0 3px 8px; border: 0; background: transparent; color: #365fce; font-size: 12px; }\n  .ugh-popup #settings:hover:not(:disabled) { text-decoration: underline; }\n  .ugh-popup #apply { display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%; min-height: 45px; padding: 10px 12px; border: 1px solid #365fce; background: #3f66d5; color: #fff; font-size: 14px; font-weight: 600; box-shadow: 0 3px 8px #294caa1a; }\n  .ugh-popup #apply:hover:not(:disabled) { background: #3156bc; }\n  .ugh-popup .action-hint { margin: 7px 0 0; text-align: center; color: #62728b; font-size: 12px; }\n  .ugh-popup #msg { margin: 10px 0 0; padding: 9px 11px; border-radius: 7px; background: #edf4ff; font-size: 12px; color: #34558e; overflow-wrap: anywhere; }\n  .ugh-popup #msg:empty { display: none; }\n  .ugh-popup .batch-section { margin-top: 16px; padding: 13px; border: 1px solid #e3e8f0; border-radius: 10px; }\n  .ugh-popup .batch-actions { display: flex; align-items: stretch; gap: 8px; }\n  .ugh-popup #batch { flex: 1; min-width: 0; min-height: 38px; padding: 7px 10px; border: 1px solid #cfdbf6; background: #f0f4ff; color: #3658b3; font-size: 13px; font-weight: 600; }\n  .ugh-popup #batch:hover:not(:disabled) { background: #e5edff; }\n  .ugh-popup #stop-batch { padding: 7px 13px; border: 1px solid #e7bdb6; background: #fff4f1; color: #a33e2d; font-size: 13px; font-weight: 600; }\n  .ugh-popup #stop-batch:hover:not(:disabled) { background: #ffe8e2; }\n  .ugh-popup .batch-note { margin: 8px 0 0; color: #63728a; font-size: 12px; }\n  .ugh-popup #batch-state { margin: 9px 0 0; padding-top: 9px; border-top: 1px solid #e6ebf4; color: #425570; font-size: 12px; overflow-wrap: anywhere; }\n  .ugh-popup #batch-state:empty { display: none; }\n  .ugh-popup #batch-state.running { color: #365fce; }\n  .ugh-popup #batch-state.completed { color: #22734e; }\n  .ugh-popup #batch-state.error { color: #a33e2d; }\n  .ugh-popup details { margin-top: 14px; }\n  .ugh-popup summary { min-height: 30px; align-items: center; color: #53627b; cursor: pointer; font-size: 12px; list-style: none; display: flex; justify-content: space-between; }\n  .ugh-popup summary::-webkit-details-marker { display: none; }\n  .ugh-popup summary::after { content: '⌄'; font-size: 17px; line-height: 1; }\n  .ugh-popup details[open] summary::after { content: '⌃'; }\n  .ugh-popup .secondary-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }\n  .ugh-popup .secondary-actions button { min-height: 36px; padding: 7px; border: 1px solid #dce3ed; background: #fff; color: #4c5f7c; font-size: 12px; }\n  .ugh-popup .secondary-actions button:hover:not(:disabled) { background: #f4f7fd; }\n  .ugh-popup #refill { grid-column: 1 / -1; }\n  .ugh-popup .auto { display: flex; align-items: flex-start; gap: 7px; margin-top: 12px; color: #63728a; font-size: 12px; cursor: pointer; }\n  .ugh-popup input { accent-color: #4169d5; margin: 3px 0 0; flex-shrink: 0; }\n  @media (prefers-reduced-motion: no-preference) { .ugh-popup button { transition: background .15s, box-shadow .15s; } .ugh-popup progress::-webkit-progress-value { transition: width .2s; } }\n</style>\n  <header class=\"hero\">\n    <div class=\"app-icon\" aria-hidden=\"true\"><svg width=\"23\" height=\"23\" viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M9 5H6a2 2 0 0 0-2 2v13h16V7a2 2 0 0 0-2-2h-3M9 3h6v4H9V3Z\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linejoin=\"round\"/><path d=\"m8 13 3 3 5-6\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></div>\n    <div><h1>USTC评教助手</h1><p class=\"subtitle\">按实际评价填写，提交前请核对</p></div>\n  </header>\n  <section class=\"status-card\" aria-label=\"当前问卷进度\">\n    <div class=\"status-top\"><span>当前问卷 · 已填写</span><strong id=\"counter\">—/—</strong></div>\n    <progress id=\"progress\" value=\"0\" max=\"1\" aria-label=\"问卷填写进度\"></progress>\n    <div class=\"stat\" id=\"status\">正在读取问卷…</div>\n    <div id=\"coverage\"></div><div id=\"unmatched\"></div>\n  </section>\n  <section class=\"preset\" aria-label=\"当前填写模板\">\n    <div class=\"preset-title\"><span id=\"preset-name\">默认模板</span><button id=\"settings\">自定义规则 <span aria-hidden=\"true\">→</span></button></div>\n    <div class=\"chips\" id=\"preset-values\"><span>评价 <b>非常好</b></span><span>难度 / 内容 / 进度 <b>适中</b></span><span>助教改进 <b>作业反馈</b></span></div>\n    <p class=\"preset-caption\" id=\"preset-caption\">PPT为主、板书为辅 · 课外1–2小时 · 教师改进：师生交流</p>\n  </section>\n  <button id=\"apply\" disabled><svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"m13 3-8 11h6l-1 7 9-12h-7l1-6Z\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/></svg>一键速填</button>\n  <p class=\"action-hint\">只补空白，保留已有答案 · 默认不提交</p>\n  <div id=\"msg\" role=\"status\" aria-live=\"polite\"></div>\n  <section class=\"batch-section\" aria-label=\"当前任务批量提交\">\n    <div class=\"batch-actions\"><button id=\"batch\" disabled>全部速填并提交</button><button id=\"stop-batch\" hidden disabled>停止</button></div>\n    <p class=\"batch-note\">自动提交当前任务的所有教师、课程问卷，保留已有答案；遇到缺答或失败会停止。</p>\n    <div id=\"batch-state\" role=\"status\" aria-live=\"polite\"></div>\n  </section>\n  <details>\n    <summary>更多操作</summary>\n    <div class=\"secondary-actions\">\n      <button id=\"preview\" disabled>预览待填答案</button><button id=\"clear\" disabled>清除高亮</button>\n      <button id=\"refill\" disabled>按模板重填（覆盖已有答案）</button>\n    </div>\n    <label class=\"auto\"><input type=\"checkbox\" id=\"autosubmit\" disabled> 本次填完后尝试提交，仅对下一次填选生效</label>\n  </details>\n  \n", "<style>\n  .ugh-options { color: #22344e; background: #fff; padding: 8px 20px 20px;\n    font: 13px/1.65 -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", sans-serif;\n    color-scheme: light; }\n  body.ugh-options { max-width: 820px; margin: 0; padding: 24px; }\n  .ugh-options, .ugh-options * { box-sizing: border-box; }\n  .ugh-options h1 { margin: 0 0 6px; color: #172b49; font-size: 22px; font-weight: 700; letter-spacing: -.5px; }\n  .ugh-options p { margin: 0; }\n  .ugh-options .options-intro { margin-bottom: 20px; color: #63728a; }\n  .ugh-options .options-intro strong { font-weight: 600; color: #3d506c; }\n  .ugh-options .rules-table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed;\n    border: 1px solid #e0e8f3; border-radius: 12px; overflow: hidden; }\n  .ugh-options th { padding: 10px 8px; background: #f3f7fc; color: #576982; font-size: 12px;\n    font-weight: 600; text-align: left; }\n  .ugh-options th:first-child { width: 52px; text-align: center; }\n  .ugh-options th:nth-child(2) { width: 32%; }\n  .ugh-options th:nth-child(3) { width: 23%; }\n  .ugh-options th:last-child { width: 62px; }\n  .ugh-options td { padding: 11px 7px; border-top: 1px solid #e9eef6; vertical-align: middle; }\n  .ugh-options tbody tr:hover { background: #fafcff; }\n  .ugh-options .rule-enabled { text-align: center; }\n  .ugh-options .rule-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }\n  .ugh-options .rule-toggle span, .ugh-options .rule-order { display: none; }\n  .ugh-options .rule-field { display: block; min-width: 0; }\n  .ugh-options .field-label, .ugh-options .sr-only { position: absolute; width: 1px; height: 1px;\n    padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }\n  .ugh-options input, .ugh-options select, .ugh-options button { font: inherit; }\n  .ugh-options input[type=text], .ugh-options select { display: block; width: 100%; min-width: 0;\n    padding: 9px 10px; border: 1px solid #d6e1ee; border-radius: 8px; background: #fff; color: #233954; }\n  .ugh-options input::placeholder { color: #8694a9; }\n  .ugh-options input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: #2563eb; cursor: pointer; }\n  .ugh-options button { padding: 9px 15px; border: 1px solid #2563eb; border-radius: 8px;\n    background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }\n  .ugh-options button:hover { background: #1d4ed8; border-color: #1d4ed8; }\n  .ugh-options button.ghost { background: #fff; color: #365d8e; border-color: #d7e2ef; }\n  .ugh-options button.ghost:hover { background: #f1f6fd; border-color: #a9c2e7; color: #1d4ed8; }\n  .ugh-options button.del { padding: 6px 7px; border-color: transparent; color: #79879a; font-size: 12px; font-weight: 400; }\n  .ugh-options button.del:hover { background: #fff1f2; border-color: #fecdd3; color: #be123c; }\n  .ugh-options button:disabled, .ugh-options input:disabled, .ugh-options select:disabled { opacity: .5; cursor: default; }\n  .ugh-options :focus-visible { outline: 3px solid #aac7fb; outline-offset: 2px; }\n  .ugh-options .row { margin: 16px 0 0; }\n  .ugh-options .add-rule { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }\n  .ugh-options .field-help { color: #75839a; font-size: 12px; }\n  .ugh-options .fallback-setting { display: grid; grid-template-columns: 1fr minmax(0, 290px); gap: 12px 18px;\n    align-items: center; padding: 16px; border: 1px solid #e2eaf5; border-radius: 12px; background: #f8fafd; }\n  .ugh-options .fallback-label { display: block; margin-bottom: 3px; color: #344b69; font-weight: 600; }\n  .ugh-options .options-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;\n    padding-top: 18px; border-top: 1px solid #e8eef6; }\n  .ugh-options #msg { flex-basis: 100%; color: #4e6481; font-size: 12px; overflow-wrap: anywhere; }\n  .ugh-options #msg:empty { display: none; }\n  @media (max-width: 600px) {\n    .ugh-options { padding: 8px 16px 16px; }\n    body.ugh-options { margin: 0; padding: 20px 16px; }\n    .ugh-options .options-intro { margin-bottom: 16px; }\n    .ugh-options .rules-table { display: block; border: 0; overflow: visible; }\n    .ugh-options thead { display: none; }\n    .ugh-options tbody { display: grid; gap: 12px; counter-reset: rule; }\n    .ugh-options tbody tr { position: relative; display: grid; grid-template-columns: minmax(0, 1fr);\n      gap: 11px; padding: 13px; border: 1px solid #dfe8f4; border-radius: 12px; counter-increment: rule; }\n    .ugh-options td { display: block; min-width: 0; padding: 0; border: 0; }\n    .ugh-options .rule-enabled { display: flex; align-items: center; gap: 10px; min-height: 29px; padding-right: 52px; }\n    .ugh-options .rule-order { display: inline-flex; align-items: center; justify-content: center;\n      min-width: 25px; height: 25px; border-radius: 7px; background: #eaf2ff; color: #3564a5; font-size: 12px; font-weight: 600; }\n    .ugh-options .rule-order::before { content: counter(rule, decimal-leading-zero); }\n    .ugh-options .rule-toggle span { display: inline; color: #506580; font-size: 12px; }\n    .ugh-options .field-label { position: static; display: block; width: auto; height: auto; margin-bottom: 5px;\n      overflow: visible; clip: auto; white-space: normal; color: #657891; font-size: 12px; }\n    .ugh-options .rule-actions { position: absolute; top: 12px; right: 12px; }\n    .ugh-options .fallback-setting { grid-template-columns: minmax(0, 1fr); padding: 14px; }\n    .ugh-options .add-rule { align-items: flex-start; flex-direction: column; }\n  }\n</style>\n  <h1>规则设置</h1>\n  <p class=\"options-intro\"><strong>从上到下匹配，命中第一条后停止。</strong><br>多个题目关键词用英文逗号分隔，任一命中即可。</p>\n  <table class=\"rules-table\" aria-label=\"填写规则，按显示顺序匹配\">\n    <thead><tr><th scope=\"col\">启用</th><th scope=\"col\">题目包含</th><th scope=\"col\">填写策略</th><th scope=\"col\">策略参数</th><th scope=\"col\"><span class=\"sr-only\">操作</span></th></tr></thead>\n    <tbody id=\"rules\"></tbody>\n  </table>\n  <div class=\"row add-rule\"><button id=\"add\" class=\"ghost\" type=\"button\">+ 添加规则</button><span class=\"field-help\">选「包含关键词」或「填充文本」时填写策略参数。</span></div>\n  <div class=\"row fallback-setting\">\n    <div><label class=\"fallback-label\" for=\"unmatched\">未匹配的必答题</label><p class=\"field-help\" id=\"unmatched-help\">没有命中上述规则时，如何处理必答题。</p></div>\n    <select id=\"unmatched\" aria-describedby=\"unmatched-help\">\n      <option value=\"highlight\">仅高亮提醒，手动填写（默认）</option>\n      <option value=\"best\">自动选最高档选项</option>\n    </select>\n  </div>\n  <div class=\"row options-actions\">\n    <button id=\"save\" type=\"button\">保存规则</button>\n    <button id=\"reset\" class=\"ghost\" type=\"button\">恢复默认</button>\n    <span id=\"msg\" role=\"status\" aria-live=\"polite\"></span>\n  </div>\n  \n  \n");
  {
    const document = shell.popupDocument;
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

    shell.refresh = refresh;
  }
  {
    const document = shell.optionsDocument;
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

  }
  shell.start();
})();
