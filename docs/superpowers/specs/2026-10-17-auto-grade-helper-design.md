# USTC评教助手 浏览器扩展 — 设计文档

日期：2026-10-17
状态：待用户确认

## 背景

参考 Greasyfork 脚本 [Auto grading](https://greasyfork.org/zh-CN/scripts/457282-auto-grading)（作者 PRO_2684，GPL-3.0）的功能思路，**从零重写**一个 Manifest V3 浏览器扩展，用于 USTC 教学质量管理平台（tqm.ustc.edu.cn）的评教辅助填写，目标上架 Chrome Web Store 与 Microsoft Edge Add-ons。

法律边界：不复制原脚本的代码、结构、命名，不使用其远程 answers.json 答案库；仅借鉴"自动评教"这一功能概念。原脚本的核心模式（远程公共答案库查表）废弃，改为本地规则引擎。

## 原脚本分析摘要（作为需求依据）

- 答案机制：`GM_getResourceText` 加载远程 answers.json（题目文本 → 答案文本字典），子串匹配选项后点击
- 已知缺陷（重写时需规避）：
  1. 快捷键守卫 `!= "INPUT" || != "TEXTAREA"` 逻辑错误，输入框内也触发
  2. 选项定位用 `[style="width: 100%;"]`，极脆弱
  3. 答案匹配用子串包含，选项互为子串时误选
  4. 多处数组下标访问无空值保护
  5. 远程答案库无本地兜底，CDN 挂则功能失效
- 值得保留的交互概念：侧边栏入口、Enter/Backspace 快捷键、倒计时等待/绕过、逐教师循环

## 目标

- 规则化自定义填选：内置通用好评规则 + 用户自定义规则
- dry-run 预览：填选前高亮并列出将选选项
- 提交默认留给用户手动点击；自动提交需显式开启
- 上架 Chrome 与 Edge 商店，审核友好（无远程代码、无混淆、权限最小化）

## 非目标

- 不支持除 tqm.ustc.edu.cn 外的平台（v1 范围）
- 不内置任何"标准答案库"数据
- 不做多平台适配框架（未来如需再立项）

## 架构

技术选型：纯 JavaScript + 原生 MV3，无框架无构建步骤。

```
auto-grade-helper/
├── manifest.json        # MV3；content script 仅匹配 https://tqm.ustc.edu.cn/index.html*
├── content/
│   ├── engine.js        # 纯逻辑：题目解析 + 规则匹配，无 DOM 依赖，Node 可单测
│   ├── content.js       # 页面交互：问卷观察、填选、高亮、快捷键、与 popup 通信
│   ├── selectors.js     # 选择器配置集中处，平台改版只改这一个文件
│   └── content.css      # 高亮样式
├── popup/popup.html|js  # 主面板：问卷状态、预览、应用、自动提交开关
├── options/options.html|js # 规则编辑器
├── background.js        # 快捷键命令转发（chrome.commands）
├── icons/               # 16/48/128
└── test/
    ├── fixtures/        # 用户保存的已评问卷 HTML 回放页
    └── engine.test.js   # Node 内置 test runner
```

权限申请：`storage`、host 仅限 `tqm.ustc.edu.cn`。不申请 `tabs`、`activeTab` 之外的敏感权限。

## 规则引擎设计

存储于 `chrome.storage.sync`（跨设备同步），结构：

```json
{
  "rules": [
    {
      "id": "uuid",
      "enabled": true,
      "match": { "titleIncludes": ["总体评价"] },
      "action": { "strategy": "best" }
    }
  ],
  "unmatchedStrategy": "highlight"
}
```

- `strategy: "best"`：选最高档选项。具体算法：用内置的有序评价词表（非常满意 > 满意 > 一般 > 不满意 > 非常不满意，含常见同义词）匹配选项文本，选命中最靠前的；一个词都没匹配到时回退为选第一个选项
- `strategy: "contains"`：选项文本含指定关键词才选（规则带 `keyword` 字段）
- `strategy: "skip"`：跳过，留人工
- 未匹配必答题由 `unmatchedStrategy` 控制：`highlight`（默认，高亮提醒）或 `best`
- engine.js 接口：`resolveAnswers(questions, ruleset) → Array<{questionId, optionIndexes, matchedRuleId|null}>`

## 数据流与交互

1. content script 用 MutationObserver 检测问卷页加载完成
2. popup 打开时向 content script 查询：题目数、必答题数、规则命中数
3. 用户点"预览"→ 高亮将选选项 + 清单展示（不修改表单）
4. 用户点"应用"→ 实际填选
5. 提交按钮默认不自动点；popup 中显式开启"自动提交"后才执行
6. 快捷键：Enter 应用/下一教师，Backspace 忽略当前；输入框聚焦时不触发（修复原脚本 bug）

## 错误处理

- 所有 DOM 查询空值保护，选择器失配不崩溃
- 结构失配时 popup 状态区提示"页面结构可能已变更，请等待扩展更新"
- 选择器集中于 selectors.js，便于快速发版修复
- 不引入远程配置/远程代码（避免审核风险）

## 测试策略

- 已获取测试夹具：用户提供的已评问卷完整存档，位于 test/fixtures/questionnaire-completed.html（含 _files 资源目录）

### DOM 实测发现（2026-10-17，基于夹具）

- 当前平台 CSS 模块命名已从 `index_subject-xxx`（原脚本时代）变更为 `index__subject--hash`（BEM 风格）——原脚本的选择器前缀匹配已失效，证实其现在大概率无法工作
- 实测结构：题目容器 `index__subject--*`、必答标记 `index__necessary--*`、题干 `index__title--*`（内含 `*` 前缀、题号、"(单选题)"后缀，需清洗）、选项组 `index__selectGroup--*`、选项容器 `div[style="width: 100%;"]`、提交按钮 class 含 `index__submit--*`
- 夹具含 12 题：9 道必答单选、2 道多选、1 道主观文本题（textarea，3000 字上限）
- 已评问卷为只读态：选项带 `ant-radio-wrapper-disabled`，可作为"已提交检测"的识别特征
- 选择题选项文案实测为"非常好/好/一般/差"式分档（非"非常满意"），best 策略的有序词表需覆盖此类词

- engine.js 用 `node --test` 跑纯逻辑单测（规则匹配、best/contains/skip、空值）
- 集成验证：本地静态服务器加载 fixture 页 + 开发者模式加载扩展，走通 预览→应用 流程
- 真机 dry-run 零风险验证（已评问卷只读状态下验证高亮与识别）

## 上架清单（2026-10 核实）

### Chrome Web Store
- $5 一次性开发者注册费（需 Visa/MasterCard 等外币卡），账号永久有效
- 注册时需做 EEA 交易者声明：个人免费项目选"非交易者"，否则强制公开联系地址和电话
- 必须在「帐户」页填写并**验证联络邮箱**，否则无法发布
- manifest.json 中 description 有 132 字符上限，提前控制
- 打包 zip 时 manifest.json 必须在根目录（不能多套一层文件夹）
- 素材：128×128 图标、至少 1 张 1280×800 截图（最多 5 张）、可选小宣传图
- 隐私政策 URL（可托管 GitHub Pages）；无数据上报则数据收集项全留空
- 审核周期约 1-3 个工作日；新开发者账号可能有发布配额风控
- 单一用途原则：描述里只讲评教辅助这一件事，权限用途逐条说明

### Microsoft Edge Add-ons
- Partner Center 注册，**免费**（需 Microsoft 账户 MSA）
- 素材基本复用 Chrome 的：zip 包、图标、截图、描述、隐私政策链接
- 审核认证最长约 7 个工作日；每次更新重新触发审核

### 审核友好策略
- 命名建议"评教助手 - USTC"（避免"自动"字样）
- 描述强调"辅助填写、预览确认、用户手动提交"
- 无远程代码加载、无混淆，源码即可读

## 待确认项

- [ ] 扩展最终名称与图标风格
- [ ] 是否保留"绕过 5 秒倒计时"功能（原脚本实验性功能，审核可能敏感；默认设计不含）
- [ ] 用户已评问卷 HTML 存档的获取
