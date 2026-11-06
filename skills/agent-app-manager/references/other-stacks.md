# 其他栈启动参考（Go / .NET / PHP / Rust 等）

本文件承接 `SKILL.md` 第 1A 节。执行前遵守 `SKILL.md` 第 0 节意图分流、第 2 节歧义报告、第 3 节构建授权与第 4 节启动前检查；受管形态与包装边界见第 1A 节。

受管形态首选**真实可执行进程**直连：编译产物 exe、`dotnet <app>.dll`、`php -S`/`php artisan serve`（真实 `php.exe`+参数）这类"运行时+产物"形态。`go run`、`dotnet run` 这类工具链命令的目标是子进程——可直接用命令模式（`command`=原命令，`expectedImage`=最终服务进程映像基名，Windows 如 `dotnet.exe`/`app.exe`/`php.exe`，Linux 如 `dotnet`/`php`）托管；两者都不行才走非受管登记，`mode`=`proc`。

多 worktree 按 [worktree 与端口流程](worktrees.md) 选端口。先从项目文档、源码或当前版本 CLI 帮助确认监听地址的参数/环境变量，再写入 `args`、`command` 或 `env`；区分工具链参数与应用参数及其转发位置。Go/Rust 自定义服务没有统一的 `PORT` 约定，.NET/PHP 也需核对项目实际启动形态及配置优先级。容器端口映射不代表容器进程可受管，不为解决端口冲突扩大接管范围。
