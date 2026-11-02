# Agent App Manager · 品牌与 UI 资源包

> **一个入口，管理所有 Agent 驱动的应用。**

本目录是**独立品牌资源和静态 UI 原型**，不会替换项目现有 `skills/agent-app-manager/scripts/manager-ui/`，也不会修改任何 CLI 或后台进程逻辑。

## 预览

- 浏览器直接打开 [`index.html`](index.html) 可查看 Logo、SVG 变体、图标尺寸与 UI 原型；也可以使用本地静态服务：
  
  ```bash
  cd docs/brand
  python -m http.server 8080
  # http://localhost:8080/
  ```
- 直接打开 [`demo/dashboard.html`](demo/dashboard.html) 可操作模拟管理后台（深浅色切换、搜索、筛选、模拟启动/停止及页面导航）。**所有数据均为演示，不连接真实 API，也不代表已实现的业务能力。**
- 深色 / 浅色 / 移动端的截图位于 `demo/`；品牌对照图为 [`preview-contact-sheet.png`](preview-contact-sheet.png)。

## Logo 的官方视觉基准

- `reference/approved-original-full.png`：用户明确确认的**原始完整图片**。
- `reference/approved-icon-master.png`：从上述图片中提取的原始图标。
- `assets/png/app-icon-*.png`、`assets/app-icon.ico`：基于确认的位图导出的不同尺寸图标。
- `assets/svg/app-icon.svg`：为项目集成重新描绘的**原生 SVG 矢量版本**，保留蓝紫色圆角底、顶部交叠的 A 形丝带以及下方 2×2 方块。SVG 的光影是近似重绘，不能保证和原图片像素级一致。
- `reference/vector-redraw-preview.png`：矢量重绘对照；`reference/original-concept.png` 仅为早期概念保留，不应作为正式 Logo。

## 目录

```text
assets/
  svg/          # 主图标、深浅色、透明、单色、横版品牌、favicon，10 个 SVG
  png/          # 16 至 1024 像素、多种品牌变体的 PNG
  app-icon.ico  # Windows 多尺寸图标
styles/
  tokens.css    # 深浅色设计变量（--aam-*）
  dashboard.css # 演示 UI 样式
demo/
  dashboard.html / dashboard.js   # 零依赖模拟前端
  dashboard-{dark,light,mobile}.png
integrations/
  vue/AgentAppManagerLogo.vue
  react/AgentAppManagerLogo.tsx
reference/       # 确认的原图及对照素材
manifest.webmanifest
index.html       # 独立展示站（依赖本目录相对路径）
```

## 在实际项目中引用

将 `assets/svg/` 拷贝到站点可访问的静态目录 `public/brand/`：

```html
<img src="/brand/app-icon.svg" width="48" height="48" alt="Agent App Manager">
<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg">
```

Windows 快捷方式 / 可执行资源使用 `assets/app-icon.ico`。在 Vue / React 项目中可直接参考 `integrations/` 下的组件，调整其静态资源路径即可。

CSS 设计变量：

```css
@import url('/brand/tokens.css');
/* var(--aam-bg), var(--aam-surface), var(--aam-primary), ... */
```

原项目是 Node.js ESM + Skill，不使用前端打包器；本套件是可选素材。要应用到真正管理台，需要另外进行 API 适配和交互迁移，保留原项目的二次确认、受管边界和日志脱敏要求。

## 图标使用建议

- 桌面图标、系统托盘：优先使用 16 / 24 / 32 / 48px 位图或 Windows ICO。
- Web 标题、README、GitHub 社交预览：使用横版 Logo / 512px 主图标。
- 需要改变路径或配色的场景：使用 SVG；**不要把 SVG 当作完全等同于原图的光影复刻**。

## 设计变量

| 变量 | 深色默认 | 作用 |
|---|---|---|
| `--aam-bg` | `#080D1A` | 页面背景 |
| `--aam-sidebar` | `#0D1424` | 左侧导航 |
| `--aam-surface` | `#101A2D` | 卡片面板 |
| `--aam-border` | `#26354B` | 分隔线 |
| `--aam-text` | `#F0F5FF` | 主文字 |
| `--aam-primary` | `#4C8CFF` | 主交互色 |
| `--aam-accent` | `#945CFB` | 辅助色 |
| `--aam-success` | `#35D6A0` | 健康状态 |
