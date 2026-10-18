// 仅拼接本项目源码，不压缩，不依赖构建库或远程资源。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '');
const project = JSON.parse(read('userscript/metadata.json'));
function html(name, className) {
  const source = read(name);
  const style = source.match(/<style>([\s\S]*?)<\/style>/i)[1]
    .replace(/\bbody\s*\{/g, '.' + className + ' {')
    .replace(/width: (?:300|360)px;/g, 'width: auto;')
    .replace(/margin: 24px auto;/g, 'margin: 0;');
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)[1]
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return `<style>${style}</style>${body}`;
}
const metadata = `// ==UserScript==
// @name         USTC评教助手
// @namespace    https://greasyfork.org/users/1573189
// @version      ${project.version}
// @description  中科大评教问卷完整模板速填，保留手动答案，显示全部题目和必答进度，支持拖动入口及一键逐教师逐课程提交，可随时停止。
// @author       quantai1314
// @match        https://tqm.ustc.edu.cn/index.html*
// @run-at       document-idle
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// ==/UserScript==`;
const bundle = `${metadata}

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
${read('content/engine.js')}

// 来源：本项目 content/selectors.js
${read('content/selectors.js')}

// 来源：本项目 content/content.js
${read('content/content.js')}

// 来源：本项目 userscript/shell.js
${read('userscript/shell.js')}

  const marks = document.createElement('style');
  marks.textContent = ${JSON.stringify(read('content/content.css'))};
  document.head.appendChild(marks);
  shell = createShell(${JSON.stringify(html('popup/popup.html', 'ugh-popup'))}, ${JSON.stringify(html('options/options.html', 'ugh-options'))});
  {
    const document = shell.popupDocument;
${read('popup/popup.js')}
    shell.refresh = refresh;
  }
  {
    const document = shell.optionsDocument;
${read('options/options.js')}
  }
  shell.start();
})();
`;
const destination = path.join(root, 'dist', 'ustc-grade-helper.user.js');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, bundle, 'utf8');
new (require('node:vm').Script)(bundle, { filename: destination });
console.log(`Userscript: ${destination} (${Buffer.byteLength(bundle)} bytes)`);
