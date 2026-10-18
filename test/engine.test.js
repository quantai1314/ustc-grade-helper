const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../content/engine.js');

test('cleanTitle 去除星号/题号/题型后缀/空白/nbsp', () => {
  assert.strictEqual(Engine.cleanTitle('* 1.您对本课程的总体评价 (单选题)'), '您对本课程的总体评价');
  assert.strictEqual(Engine.cleanTitle('9.您对助教的工作总体评价 （没有助教的课程此题无需作答） (单选题)'),
    '您对助教的工作总体评价（没有助教的课程此题无需作答）');
  assert.strictEqual(Engine.cleanTitle('* 12、多选示例 (多选题)'), '多选示例');
  assert.strictEqual(Engine.cleanTitle('  '), '');
});

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

test('best 词表无命中时不猜测首项', () => {
  const [r] = Engine.resolveAnswers([Q({ options: ['5分', '3分', '1分'] })], RS({ unmatchedStrategy: 'best' }));
  assert.deepStrictEqual(r.optionIndexes, []);
  assert.strictEqual(Engine.bestOptionIndex(['5分', '3分', '1分']), -1);
  assert.strictEqual(Engine.bestOptionIndex([]), -1);
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

test('best 优先精确匹配，避免差评在最前时误选（不满意/满意）', () => {
  const [r] = Engine.resolveAnswers([Q({ options: ['不满意', '满意'] })], RS({ unmatchedStrategy: 'best' }));
  assert.deepStrictEqual(r.optionIndexes, [1]);
});

test('带选项前缀时，否定评价不能因包含满意/好而提升档位', () => {
  assert.strictEqual(Engine.bestOptionIndex(['A.不满意', 'B.满意']), 1);
  assert.strictEqual(Engine.bestOptionIndex(['A.非常不好', 'B.比较好']), 1);
  assert.strictEqual(Engine.bestOptionIndex(['一般', 'A.非常满意']), 1);
  assert.strictEqual(Engine.bestOptionIndex(['不太好', '比较好']), 1);
});

test('未匹配自动选项仅作用于必答题，选答题保留人工决定', () => {
  const answers = Engine.resolveAnswers([Q({ required: false })], RS({ unmatchedStrategy: 'best' }));
  assert.deepStrictEqual(answers[0].optionIndexes, []);
});

// 只解析夹具中的题目 div、题干和选项 label，无浏览器或第三方依赖。
function fixtureQuestions() {
  const questions = require('./fixtures/questions.json');
  return questions.map((question, index) => ({
    ...question,
    id: 'fixture-' + index,
    title: Engine.cleanTitle(question.title),
    options: question.options.map(text => text.replace(/\s+/g, ''))
  }));
}

test('真实12题模板覆盖9道必答，并准确填选助教、授课形式和时间', () => {
  const questions = fixtureQuestions();
  const answers = Engine.resolveAnswers(questions, Engine.DEFAULT_RULESET);
  assert.strictEqual(questions.length, 12);
  assert.strictEqual(questions.filter(q => q.required).length, 9);
  assert.strictEqual(answers.filter((answer, i) => questions[i].required && answer.optionIndexes.length > 0).length, 9);
  assert.deepStrictEqual(answers.map(answer => answer.optionIndexes), [[0], [1], [1], [1], [0], [3], [0], [3], [0], [0], [1], []]);
  assert.match(questions[9].options[answers[9].optionIndexes[0]], /^作业反馈/);
  assert.strictEqual(questions[7].options[answers[7].optionIndexes[0]], '师生交流');
  assert.strictEqual(questions[5].options[answers[5].optionIndexes[0]], 'PPT为主，板书为辅');
  assert.strictEqual(questions[10].options[answers[10].optionIndexes[0]], '1-2小时');
  assert.ok(answers.every(answer => answer.textValue === null));
});

test('默认规则按题意匹配，题目重排和题号改变不影响模板', () => {
  const questions = fixtureQuestions().reverse().map((question, i) => ({ ...question, title: Engine.cleanTitle(`${i + 31}. ${question.title}`) }));
  const answers = Engine.resolveAnswers(questions, Engine.DEFAULT_RULESET);
  assert.deepStrictEqual(answers.map(answer => answer.optionIndexes), [[], [1], [0], [0], [3], [0], [3], [0], [1], [1], [1], [0]]);
});

test('助教改进优先于教师改进，主观题与未知新题不误填', () => {
  const questions = [
    Q({ title: '助教的工作应该在哪些方面调整（教师应该在哪些方面改进）', type: 'multi', options: ['师生交流', '作业反馈'] }),
    Q({ title: '您对未知新活动的看法', options: ['非常好', '一般', '差'] }),
    Q({ title: '本课程的难度', options: ['难', '易'] }),
    Q({ title: '本课程总体评价', options: ['5分', '3分', '1分'] }),
    Q({ title: '您的具体意见或建议', type: 'text', options: [] })
  ];
  const answers = Engine.resolveAnswers(questions, Engine.DEFAULT_RULESET);
  assert.deepStrictEqual(answers.map(answer => answer.optionIndexes), [[1], [], [], [], []]);
  assert.strictEqual(answers[0].matchedRuleId, 'default-ta-improvement');
  assert.ok(answers.every(answer => answer.textValue === null));
});

test('默认最高档规则支持同义量表，其他模板不会猜测缺失目标选项', () => {
  const answers = Engine.resolveAnswers([
    Q({ title: '您对课程的总体评价', options: ['不满意', '一般', '非常满意'] }),
    Q({ title: '您认为本课程的讲义', options: ['差', '优秀', '合格'] }),
    Q({ title: '本课程的上课形式', options: ['纯PPT', '纯板书'] }),
    Q({ title: '每周课外时间', options: ['0-1小时', '2-3小时'] })
  ], Engine.DEFAULT_RULESET);
  assert.deepStrictEqual(answers.map(answer => answer.optionIndexes), [[2], [1], [], []]);
});

function oldDefault() {
  return { rules: [{ id: 'r-random-saved-id', enabled: true, match: { titleIncludes: ['总体评价', '总体满意', '满意度'] }, action: { strategy: 'best' } }], unmatchedStrategy: 'highlight' };
}

test('空存储和语义完全相同的旧版默认升级，不依赖旧随机ID且不修改存储对象', () => {
  assert.strictEqual(Engine.getRuleset(null), Engine.DEFAULT_RULESET);
  assert.strictEqual(Engine.getRuleset(undefined), Engine.DEFAULT_RULESET);
  const original = oldDefault();
  const before = structuredClone(original);
  assert.strictEqual(Engine.getRuleset(original), Engine.DEFAULT_RULESET);
  assert.deepStrictEqual(original, before);
  original.rules[0].match.titleIncludes = ['满意度', '总体评价', '总体满意', '满意度'];
  assert.strictEqual(Engine.getRuleset(original), Engine.DEFAULT_RULESET);
});

test('清空规则和修改过的关键词、动作、开关或未匹配策略全部保留', () => {
  const changes = [
    stored => { stored.rules = []; },
    stored => { stored.rules.push({ id: 'custom', enabled: true, match: { titleIncludes: ['难度'] }, action: { strategy: 'contains', keyword: '偏难' } }); },
    stored => { stored.rules[0].enabled = false; },
    stored => { stored.rules[0].match.titleIncludes = ['总体评价']; },
    stored => { stored.rules[0].match.titleIncludes.push('教材'); },
    stored => { stored.rules[0].action = { strategy: 'contains', keyword: '满意' }; },
    stored => { stored.unmatchedStrategy = 'best'; },
    stored => { stored.rules[0].match.titleExcludes = ['助教']; }
  ];
  for (const change of changes) {
    const stored = oldDefault();
    change(stored);
    const before = structuredClone(stored);
    assert.strictEqual(Engine.getRuleset(stored), stored);
    assert.deepStrictEqual(stored, before);
  }
});
