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
