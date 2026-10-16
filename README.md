# 棱镜指挥 / PRISM COMMAND

纯 JavaScript 编写的浏览器即时战略游戏，采用独立能量核心经济、平面几何战场、战争迷雾与地图编辑器，无第三方依赖或构建步骤。

## 本地运行

需要 Node.js。在仓库根目录执行：

```sh
cd prism-rts
npm start
```

在浏览器打开 <http://localhost:4173/>，或在 Windows 中双击 `prism-rts/start.cmd`。

## 验证

在 `prism-rts` 目录执行：

```sh
npm test
npm run check
```

## 项目内容

- [游戏说明与操作指南](prism-rts/README.md)
- [经济与生产机制设计](能量核心%20RTS%20经济与生产机制简案.md)
- `prism-rts/dist/`：直接运行的游戏源码与静态页面。
- `prism-rts/tests/`：游戏规则与交互测试。
- `prism-rts/scripts/`：数值平衡审计工具。
