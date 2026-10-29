# Issue 146 执行记录

代码基线：`review-project-runner-scenario-test-146` / `9cff42c02addc23831c8a798a9504882cacfffea`。开始时只有本任务旧设计为未跟踪文件。

- [x] 实现受管工作台发现、启动、状态、停止（AC01–AC04）。
- [x] 实现管理台 API、入口、安全边界（AC01–AC05）。
- [ ] 完成跨平台验收和既有回归（AC01–AC06）。

Windows：隔离项目模拟 CLI 与真实 scenario-test runtime 冒烟通过，覆盖两项目、同配置复用、独立停止、缺失 CLI 后停止及运行中管理台响应；UI 源码交互测试和 HTTP 安全回归通过。浏览器自动化访问宿主不可用，尚未进行真实浏览器点击验收。

199 Linux：使用无外网、限制资源的临时 Pi 沙箱派生容器，真实 scenario-test runtime 冒烟、`npm test` 及 discovery-redaction 专项通过。原始 `pi-sandbox:1.4.0` 缺少 Python，安全停止返回 `PIDFD_UNAVAILABLE`；派生镜像添加 Python 3.11 后通过，不改动原镜像。临时容器、派生镜像和测试目录已清理。

Windows 首次完整回归中进程发现超时：检查实际进程快照发现 PID 复用产生父链环，原有祖先遍历缺少防环。已限制遍历至 wrapper 并防止重复节点，原失败的 discovery-redaction 专项及 `npm run check` 复测通过。原测试产生的两个残留进程已核验身份并终止；env 测试报告一个临时目录清理超时，不影响断言。

实现审查：同上下文检查发现缺少内部登记时不应从残留 runtime 显示工作台 PID，已修正；并发首次打开可能返回锁冲突，调用方需重试。设计和实现均尚未经过独立审查。
