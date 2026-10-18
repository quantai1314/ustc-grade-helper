# USTC评教助手

中国科学技术大学教学质量管理平台的非官方评教用户脚本，仅发布于 Greasy Fork 和 GitHub。

## 安装与下载

- [Greasy Fork 安装与更新](https://greasyfork.org/zh-CN/scripts/600722-ustc%E8%AF%84%E6%95%99%E5%8A%A9%E6%89%8B)
- [GitHub 发布页](https://github.com/quantai1314/ustc-grade-helper/releases/latest)：下载用户脚本及 SHA-256 校验文件。

安装前需要支持现代 GM API 的脚本管理器。

## 用户脚本

已发布：[Greasy Fork：USTC评教助手](https://greasyfork.org/zh-CN/scripts/600722-ustc%E8%AF%84%E6%95%99%E5%8A%A9%E6%89%8B)，当前版本 `1.2.1`。

`1.2.1` 修复批量提交卡在成功弹窗的问题，支持弹窗中的“下一位教师”“下一课程”和“确定”，等待下一份表单加载后继续。

构建命令（无需安装 npm 依赖）：

```powershell
node tools/build-userscript.js
```

输出：`dist/ustc-grade-helper.user.js`。构建会将本项目的规则引擎、页面逻辑、面板和规则编辑器完整内嵌到单一可读脚本中，不加载远程代码或答案库。

构建后的 `.user.js` 纳入 GitHub 仓库，供 Greasy Fork 从固定源码地址同步；`dist/` 中的其他发布凭证及临时产物仍不纳入仓库。

用户脚本在平台右下角提供可拖动并记住位置的“评教助手”入口，内置完整速填模板，面板分别显示全部题目进度和必答进度；一键速填保留已有答案，按模板重填可明确覆盖。通过脚本管理器的 GM 存储保存规则和入口位置。单页速填默认不提交；“全部速填并提交”会处理当前任务中的教师和课程问卷，确认成功后继续，可随时停止。具体默认规则、操作方法、限制和数据处理见 [油叉发布说明](docs/greasyfork-listing.md)。

当前发布状态与验证记录见 [用户脚本发布记录](docs/greasyfork-release.md)。

## 源码与验证

- `content/`：规则引擎、问卷提取、预览和填选逻辑。
- `popup/`、`options/`：面板和规则编辑器，通过用户脚本内部的私有适配对象运行。
- `userscript/shell.js`：浮动界面、GM 菜单及页面切换适配。
- `userscript/metadata.json`：用户脚本版本号。
- `tools/build-userscript.js`：用户脚本构建。

```powershell
node --test test/engine.test.js test/popup.test.js test/options.test.js
python -m http.server 0 --bind 127.0.0.1
```

根据服务器输出的端口，在浏览器打开 `/test/content.test.html`、`/test/userscript.test.html`、`/test/quickfill.test.html` 与 `/test/batch.test.html`，运行核心 DOM、完整用户脚本、速填拖动与批量提交回归。用户脚本集成页使用模拟的 GM 存储，不会修改或提交学校平台的真实问卷。

页面数据处理及 GM 存储说明见 [隐私说明](docs/privacy-policy.md)。早期扩展方案仅作历史记录，不再构建或发布。

## 测试数据与授权

公开测试只包含题目和选项，以及本地生成的演示问卷，不含账号信息、真实填写内容或学校页面的第三方代码。原始页面快照不纳入公开仓库。

本项目暂未授予额外开源许可证；源码公开不等于提供开源许可。
