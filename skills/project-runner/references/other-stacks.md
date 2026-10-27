# 其他栈启动参考（Go / .NET / PHP / Rust 等）

本文件承接 `SKILL.md` 第 1A 节。执行前遵守 `SKILL.md` 第 0 节意图分流、第 2 节歧义报告、第 3 节构建授权与第 4 节启动前检查；受管形态与包装边界见第 1A 节。

受管形态首选**真实可执行进程**直连：编译产物 exe、`dotnet <app>.dll`、`php -S`/`php artisan serve`（真实 `php.exe`+参数）这类"运行时+产物"形态。`go run`、`dotnet run` 这类工具链命令的目标是子进程——可直接用命令模式（`command`=原命令，`expectedImage`=最终服务进程映像基名，Windows 如 `dotnet.exe`/`app.exe`/`php.exe`，Linux 如 `dotnet`/`php`）托管；两者都不行才走非受管登记，`mode`=`proc`。
