// 从公开题目数据生成本地演示页，不读取真实问卷或学校页面资源。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const questions = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/questions.json'), 'utf8'));
const escape = text => String(text).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const blocks = questions.map((question, index) => `<section class="index__subject--demo">
  <div class="index__title--demo">${question.required ? '<span class="index__necessary--demo">*</span>' : ''}${escape(question.title.replace(/^\*\s*/, ''))}</div>
  ${question.type === 'text' ? '<textarea></textarea>' : question.options.map(option => `<label class="ant-${question.type === 'multi' ? 'checkbox' : 'radio'}-wrapper"><input type="${question.type === 'multi' ? 'checkbox' : 'radio'}" name="question-${index}">${escape(option)}</label>`).join('\n')}
</section>`).join('\n');
const html = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>USTC评教助手 · 本地演示</title>
<style>body{max-width:850px;margin:24px auto;font:14px/1.8 system-ui}section{padding:16px;border-bottom:1px solid #ddd}label{display:block}textarea{width:95%;height:80px}</style>
<h1>本地演示问卷</h1><p>仅演示题目与选项，不连接学校平台。</p>${blocks}
<button class="index__submit--demo" onclick="this.textContent='已提交';this.disabled=true">提交演示问卷</button>
<script>window.GM={async getValue(key,fallback){return fallback},async setValue(){},registerMenuCommand(){}};</script>
<script src="ustc-grade-helper.user.js"></script></html>`;
const output = path.join(root, 'dist', 'harness.html');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html, 'utf8');
console.log('Demo: ' + output);
