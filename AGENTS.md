# AGENTS.md — 棱镜指挥 / PRISM COMMAND

> 本文件说明**怎么在这个仓库干活**、有哪些坑不能踩。**要做什么**一律以用户当前指令为准。

## 0. 项目是什么

- **纯 JavaScript 浏览器 RTS**，HTML 端实验项目，落地在 `prism-rts/`。
- **电脑与手机共用同一份代码、同一份战场**：没有独立的移动端版本，桌面与手机只是布局、输入方式和视口不同。
- **无框架、无第三方依赖、无 CDN、无构建步骤、无 `node_modules`**。`dist/` 就是可直接运行的游戏源码。
- 每个浏览器标签页是一场独立单人战役，**刷新即重置**；没有服务端逻辑，没有存档系统。
- 核心机制：独立能量核心经济（无公共资源池）、平面几何俯视战场、战争迷雾、地图编辑器、数值实验室与对局报告。

## 1. 优先级

**用户当场指令 > 本文件 > `prism-rts/README.md` > `能量核心 RTS 经济与生产机制简案.md` > 你的推断。**

- `prism-rts/README.md` 是**当前规格**（玩法、数值表、操作、验证方式）。它不是历史文档，行为改了要同步，否则文档会撒谎。
- 根目录《能量核心 RTS 经济与生产机制简案.md》是 2026/10/4 的**设计原案**，里面大量"待定"项已被实现覆盖。**只当设计意图参考，不要拿它当验收标准**，更不要用它反驳用户或现有实现。

## 2. 硬规则（TL;DR）

1. **`dist/` 是手写源码，不是构建产物。** 禁止"构建"、禁止生成或整体覆盖 `dist/`、禁止引入 npm 依赖 / 打包器 / CDN / 外部字体 / 贴图素材。改代码就直接改 `dist/` 下的文件。
2. 改完至少跑 `npm run check` 和 `npm test`。
3. **新增 `dist/*.js` 后必须把该文件加进 `package.json` 的 `check` 脚本列表**，否则语法检查会漏掉它。
4. **模拟层必须零 DOM 依赖**：`engine.js`、`terrain.js`、`navigation.js`、`fog.js`、`balance.js`、`telemetry.js`、`interaction.js`、`core-drag.js`、`production.js` 不碰 `document`/`window`，因为 `tests/` 直接 `import` 它们在 Node 里跑。要读 DOM 的改动放 `app.js` / `render.js`。
5. **任何 UI / 交互 / 布局改动都要同时验证桌面与手机**，手机不得出现横向溢出（`document.documentElement.scrollWidth <= innerWidth`）。
6. **战争迷雾是硬约束**：任何可能暴露敌情的新信息通道（HUD、日志、警报、弹道、特效、小地图）都必须先过 `fog.js` 的共享视野判定。
7. **数值改动落在 `dist/balance.js` 的基准里**，在 `tests/balance.test.mjs` 有可验证期望，并同步 README 的数值表。
8. **不要改 WebMCP 工具名 `read_battle_state` / `set_battle_paused`**——`.verification/` 的浏览器验证脚本依赖它们。
9. **面向玩家的文案、README、注释性文档用中文；代码注释与测试名用英文。** 代码风格沿用现状：紧凑、不写分号、原生 ESM。
10. 做不到、被卡住、越界了，立刻说清楚，**不要假装通过**。

## 3. 目录结构

| 路径 | 作用 |
|---|---|
| `prism-rts/dist/` | 游戏本体：静态页面 + 全部运行时代码（手写源码） |
| `prism-rts/dist/index.html` | 游戏入口（`<script type="module" src="app.js">`），`server.mjs` 的默认页 |
| `prism-rts/dist/lab.html` `lab.css` `lab.js` | 数值实验室：数值编辑、派生指标、真实对局曲线、地图编辑页 |
| `prism-rts/dist/terrain.js` | 地图尺寸、基地/仓库/据点坐标、地形、圆形与多边形碰撞 |
| `prism-rts/dist/navigation.js` | 按半径缓存的网格 + A* + 路线平滑；建筑变动后更新缓存 |
| `prism-rts/dist/engine.js` | 主模拟：经济、生产、科技、编队、指令队列、战斗、AI |
| `prism-rts/dist/fog.js` | 双方独立视野、永久探索、建筑发现记忆 |
| `prism-rts/dist/balance.js` | 可验证的平衡基准与字段限制；每个 `World` 用独立冻结配置 |
| `prism-rts/dist/telemetry.js` | 有界历史采样、事件订阅、调试标记、报告校验 |
| `prism-rts/dist/map-config.js` `map-editor.js` | 地图格式与几何校验、SVG 编辑器、撤销重做、通路检查 |
| `prism-rts/dist/lab-storage.js` | localStorage 配置与报告存储、JSON 下载 |
| `prism-rts/dist/render.js` | 俯视投影、单位与建筑绘制、事件动效、小地图、相机 |
| `prism-rts/dist/app.js` | 指挥界面、触控、队列面板、调试面板、WebMCP 注册 |
| `prism-rts/dist/interaction.js` `core-drag.js` `production.js` | 点击判定优先级、核心抓取预览、按建筑独立生产 |
| `prism-rts/dist/style.css` | 桌面、手机竖屏、手机横屏三套布局 |
| `prism-rts/tests/` | `node:test` 用例，直接 import `dist/` 的模拟层 |
| `prism-rts/scripts/balance-audit.mjs` | 空地交战平衡审计脚本 |
| `prism-rts/.verification/` | 浏览器联动验证脚本（`*-browser-check.mjs`）+ 生成的报告/截图 |
| `prism-rts/.backups/` | 手工快照，按 `日期-功能` 命名 |
| `prism-rts/server.mjs` | 24 行的静态服务器，**只服务 `dist/`**，监听 `0.0.0.0` |

## 4. 常用命令

在 `prism-rts/` 下执行：

```sh
npm start          # 或双击 start.cmd；http://localhost:4173/，日志同时打印手机可用的 LAN 地址
npm test           # node:test，当前 155 个用例、约 10 秒
npm run check      # 15 个 dist 文件的 node --check 语法检查
node scripts/balance-audit.mjs [预算] [--json]   # 结果写入 balance-audit.json
node .verification/fog-browser-check.mjs         # 浏览器联动验证（另有 core-drag / objectives / technology 三个）
```

- 端口：游戏默认 `4173`（`PORT` 环境变量可覆盖），各验证脚本自用独立端口（如 fog 用 `4177`）。
- `PORT` 改动、`server.pid`、`server.log`、`server-error.log` 都是本地运行产物，不要提交。

## 5. 本机沙箱注意（重要）

- `npm test` 与 `.verification/*-browser-check.mjs` 会 `spawn` 子进程并走**管道 stdio**。在 DSH 文件沙箱下这会失败并报 **`spawn EPERM`**（受限模式下程序不能创建命名管道）。
  - 这是**环境限制，不是项目坏了**，别去改测试代码来"修"它。
  - 正确做法：在沙箱外运行，或把**同一条命令**提权重试一次。
- `npm run check`（纯 `node --check`）不受影响，沙箱内可正常通过。
- 浏览器验证脚本硬编码 Chrome 路径 `C:/Program Files/Google/Chrome/Application/chrome.exe`，换机器需要改脚本。
- 本机 Node.js 为 v24.15.0。

## 6. 改动工作流

- **只读调研随时做，不用问**：读代码 / README / 报告 / 截图、查 git 历史、跑只读检查。
- **小改直接做**：文案、样式微调、单个数值、明确的 bug 修复。做完给验证证据。
- **大改先说方案再动手**：新机制、重构模拟层、改经济模型、改地图或存储格式、删除文件、改变 README 已承诺的行为。方案里写清影响面、验证方式、需要用户拍板的点。
- 用户说"敏捷模式 / 直接做"时，跳过上面的确认环节。
- **只做用户要的事**：不顺手重构、不改名、不加功能、不换依赖。
- 用户确认过的事不要重复追问。

## 7. 验证与证据

| 改动类型 | 必须做的验证 |
|---|---|
| 模拟规则、经济、战斗、寻路、迷雾 | 先在 `tests/` 补一个可复现用例，再改实现；`npm test` 全绿 |
| 任意 JS 改动 | `npm run check` |
| UI、触控、渲染、布局、迷雾显示 | 跑或新写 `.verification/*-browser-check.mjs`：断言 + 桌面与手机截图 + JSON 报告 |
| 数值平衡 | `tests/balance.test.mjs` + `node scripts/balance-audit.mjs` |

- 新增交互功能时，按现有套路补一个 `*-browser-check.mjs`：脚本自带独立端口的服务器、headless Chrome + CDP、注入 `document.modelContext` 桩以取用 `read_battle_state` / `set_battle_paused`，失败时写 `*-failure.png`。
- 报告与截图**被 gitignore**（只有 `*.mjs` 入库）。给用户结论时附上截图路径与报告文件。
- 结论要基于实际执行结果，不要凭代码阅读就断言"已验证"。

## 8. 具体坑

- **手机手势与长按冲突**：长按约 0.38 秒才进入核心拖动；长按触发前的拖动仍是桌面框选 / 触控平移。改手势代码必须同时验证这两个分支，以及拖到战场边缘的自动平移。
- **迷雾不能漏信息**：视野外不显示敌军、敌方核心、中立仓库与据点的实时归属；已发现建筑只保留不含生命与生产信息的"上次发现"轮廓；隐藏期间被摧毁也要重新侦察才能确认消失。
- **四种 JSON 格式互相独立**：地图 JSON、数值 JSON、对局报告、战场快照。不要混用或互相导入。
- **存储按同源隔离**：`localhost` 与 LAN 地址、不同设备与浏览器之间不共享，跨设备要用 JSON 转移。
- **独立生产不能退化**：生产按建筑 ID 分派（`production.js`），不要退回"主建造厂转发"；取消已付款任务要全额退回**原付款核心**，换核不改变退款目标。
- **规模上限**：每方最多 60 个作战单位，每栋生产建筑最多 8 个订单。调平衡时注意这两个上限。
- **美术契约**：纯俯视、纯色、平面几何符号，无贴图无图片素材。别为了"好看"引入图片或渐变贴图式渲染。
- **ESM 依赖方向**：`dist/` 用原生 ESM 互相 import。改导出签名时，同步检查所有导入方（`engine.js` 被引用最多）。
- **README 要说真话**：玩法、数值、操作、文件职责变了，同步更新 `prism-rts/README.md` 对应段落。

## 9. git 与备份

- 仓库根为 `E:\unityproject\RTStest`，分支 `main`，目前只有一个初始提交。
- `.backups/` 是手工快照，按 `日期-功能` 命名（如 `fog-of-war-20261016`、`map-editor-20261015`）。做大改前可照此约定留一份快照；`.backups/` 已被 gitignore。
- 不要提交：`node_modules/`、`*.log`、`*.pid`、`.backups/`、`.verification/` 下的报告与截图。
- 提交前用 `git status` 确认没有把验证产物或运行日志带进去。
