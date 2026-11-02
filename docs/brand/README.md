# Agent App Manager · 品牌与 UI 资源包

> 一个入口，管理所有 Agent 驱动的应用。

这是一套独立的品牌资源和 UI 演示，不修改现有 CLI、Skill、运行时或管理台代码。

## 预览

在本目录运行 `python -m http.server 8080` 并打开 `http://localhost:8080`，或直接打开 [index.html](index.html)。交互式管理台位于 [demo/dashboard.html](demo/dashboard.html)。

**所有数据和启停操作均为模拟，不连接实际管理器 API。**

## 目录

- `assets/svg/`：10 个 SVG，包括主图标、透明/单色、横版和 favicon；
- `assets/png/`：16–1024px PNG、多种深浅色与组合图标；
- `assets/app-icon.ico`：Windows 多尺寸 ICO；
- `styles/`：CSS 设计变量和后台样式；
- `demo/`：交互式静态管理台与深色/浅色/移动端截图；
- `integrations/`：Vue 3 / React Logo 组件；
- `reference/`：用户确认原图、原图裁切、SVG 重绘对照及早期概念；
- `manifest.webmanifest`：PWA 图标清单。

## 正式视觉基准

`reference/approved-original-full.png` 是用户确认的完整原图。位图图标来自这张图片，保留蓝紫色圆角底、交叠的 A 形丝带及四方块。SVG 为可编辑重绘版，并非像素级一比一矢量化。

## 使用

```html
<img src="/brand/app-icon.svg" alt="Agent App Manager" width="48" height="48">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
```

如在 Vue/React 项目使用，请参考 `integrations/` 下的组件并调整静态资源路径；Windows 图标使用 `assets/app-icon.ico`。

当前仓库是零依赖 Node ESM + Skill 项目。UI Demo 仅供设计参考，后续需单独对接实际控制台，不能直接替换真实进程管理流程。
