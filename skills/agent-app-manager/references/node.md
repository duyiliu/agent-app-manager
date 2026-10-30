# Node / 前端项目启动参考

本文件承接 `SKILL.md` 第 1A 节。执行前遵守 `SKILL.md` 第 0 节意图分流、第 2 节歧义报告、第 3 节构建授权与第 4 节启动前检查；受管形态与包装边界见第 1A 节。

1. **[项目] 包管理器**：`package.json` 的 `packageManager` 字段 > `pnpm-lock.yaml`/`yarn.lock`/`bun.lock(b)`/`package-lock.json`。包管理器只决定"如需安装依赖用什么命令"，不影响受管启动形态。
2. **[项目] 启动脚本**：`package.json` `scripts` 里的 `dev`/`serve`/`start`/`dev:*` 等及 README 约定；多候选时选一个并说明理由，不擅自全试。
3. **[比对] 依赖就绪**：`node_modules` 缺失或明显过期（lockfile 更新于 `node_modules`）时报告所需安装命令，按授权规则处理，不擅自 `install`。
4. **受管启动形态（关键）**：`npm run dev`/`pnpm dev`/`yarn dev` 在 Windows 下经 `.cmd` shim + cmd 包装拉起真实 node——包装进程不是受管目标，`.cmd` 会被 manager 直接拒绝；Linux 下 `npm`/`pnpm` 通常是 `#!` 脚本，同样会被 `exe` 校验拒绝。**受管做法是把 script 映射为真实 node 入口**：
   - script 形如 `<bin> <args…>`：Windows 读 `node_modules/.bin/<bin>.cmd` 里被调用的 js 入口（`%dp0%` 相对路径）；Linux 读 `node_modules/.bin/<bin>` 符号链接目标。两种平台都可直接读对应包的 `package.json` `bin` 字段解析。常见映射：vite→`node_modules/vite/bin/vite.js`，vue-cli-service→`node_modules/@vue/cli-service/bin/vue-cli-service.js`，react-scripts→`node_modules/react-scripts/scripts/start.js`，next→`node_modules/next/dist/bin/next`，nuxt→`node_modules/nuxt/bin/nuxt.mjs`，ng→`node_modules/@angular/cli/bin/ng.js`（`.mjs`/`.cjs` 同理）。
   - script 形如 `node <file>`（Node 后端）→ 该文件即 args[0]。
   - 复合命令（`&&` 串联、`cross-env KEY=V <bin>`）：把最终真正拉起服务的那个进程解析出来；**非敏感字面值**（如 `PORT=3001`）放入 desc 的 `env` 对象持久化（跨会话 start/restart 保留，并覆盖调用 manager 时同名环境变量）；**禁止将机密写入 env**，机密由系统环境变量提供并以 `envRefs` 只记名称（值不落注册表），或用 desc 的 `envFile` 指向本机 env 文件（启动时读取注入，值不落 registry/runtime/status/UI）。`envRefs` 缺失会在启动前以 `ENV_MISSING` 一次列出全部缺失名称并拒绝启动；`env` 中疑似机密的字面值会告警但不阻断，敏感名称在 status/UI 回显为 `***`。
   - desc（直连）：`exe`=真实解释器（Windows `node.exe`，可用 `where node` 解析；Linux `node`，按 PATH 或 `process.execPath`；agent 自身运行在 Node 上时直接用 `process.execPath` 最可靠），`args`=[入口 js 路径, 其余参数]，`cwd`=项目根，`mode`=`node`。
   - **解析不了唯一入口时的命令模式**：`command`=`npm run dev`/`pnpm dev`/原始项目命令原样，`expectedImage`=Windows `node.exe` / Linux `node`，`mode`=`node`——manager 拉起对应 shell wrapper（Windows `cmd /d /s /c`、Linux `/bin/sh -c`）后在后代中自动定位真实 node 进程托管（含 turbo/nx、自定义串联）。若后代出现多个 node 进程（并行编排多服务）→ `DISCOVERY_AMBIGUOUS` 拒绝并报候选，此时才转非受管。
   - 命令模式与直连都不可行 → 报 `UNSUPPORTED_LAUNCH` 类限制说明后按原授权执行项目命令，`record-unmanaged` 登记日志线索（`--log-hints` 指向 `.tmp/runner-local-*` 日志），不伪造托管。
5. **[比对] 端口**：以实际输出/配置为准；`vite.config.*`/`vue.config.js`/`next.config.*`/`.env*` 中的 `server.port`/`PORT` 优先于框架默认（vite 5173、next 3000、ng 4200、vue-cli 8080）。注意 vite 等在端口被占用时可能自动换用下一个端口并在输出中说明——就绪端口以实际输出为准，不是配置文件。`.env*` 只读取值，不改写、不外泄。
6. **热更新**：前端 dev server 的 HMR/文件监听是框架能力，不是本 Skill 承诺；验证方式=改动源文件后看 dev server 输出或页面。
