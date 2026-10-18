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
  function taskScope() {
    // The course segment may change; the evaluation task and semester must not.
    const match = location.hash.match(/^(#\/my-task\/answer\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+)\//);
    return match ? match[1] + (location.hash.split('?')[1] || '') : location.origin + location.pathname;
  }
  function loading() {
    return [...document.querySelectorAll(S.loading)].some(isVisible);
  }
  async function waitReady(id, scope, changed, detailsUrl = null) {
    const start = Date.now();
    let stable = null, since = 0;
    while (batchActive(id)) {
      if (detailsUrl && location.href === detailsUrl) return null;
      if (taskScope() !== scope) fail('left-task');
      const now = capture();
      const ready = now.entries.length && submitButton() && !loading() && (!changed || changed(now));
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
    Object.assign(batch, { running: true, phase: 'filling', completed: 0, skipped: 0, reason: null });
    const id = ++batchRunId;
    runBatch(id, taskScope(), detailsUrl);
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
