# Node.js 测试项目

用于验证 Project Runner 对 Node.js 项目的识别、受管启动、就绪检查和日志查看。只监听 `127.0.0.1:18275`，使用 Node.js 20+ 内置模块，无需安装依赖，不用于生产。

## 启动

在本目录运行：

```bash
npm start
```

也可以让已安装 `project-runner` 的 Agent 启动 `examples/node-demo`，建议别名 `node-demo`。可直接托管真实 Node 可执行文件并运行 `server.mjs`，设置预期端口 `18275` 及就绪地址 `http://127.0.0.1:18275/api/health`；`detect` 也可识别 `npm start` 对应的命令候选。

手工启动后按 Ctrl+C 退出；受管启动后可通过 `manager ui` 或 `manager status/logs/stop node-demo` 管理。不要同时启动两份。

## 接口

```bash
curl --fail http://127.0.0.1:18275/api/health
curl --fail "http://127.0.0.1:18275/api/hello?name=Runner"
curl --fail -X POST "http://127.0.0.1:18275/api/logs?level=WARN"
```

健康接口返回状态、应用名、PID 和时间；问候接口返回文本及版本；日志接口支持 `INFO`、`WARN`、`ERROR`，其他级别返回 400。代码变更后需重新启动，默认不启用自动重载。
