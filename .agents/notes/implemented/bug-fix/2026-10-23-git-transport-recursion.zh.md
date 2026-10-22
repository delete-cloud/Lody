# Git transport 必须拒绝递归 wrapper 路径

Status: implemented
Translation: current

[English](2026-10-23-git-transport-recursion.md)

## 摘要

继承的 `GIT_EXEC_PATH` 可能让生成的 Git wrapper 把自身选作原生 Git；持久化 marker 还可能在环境变化后继续保留这个目标。现在探测使用 `process.env` 的副本，并以不区分大小写的方式移除所有 `GIT_EXEC_PATH` 拼写；marker 和探测路径若解析到任一 Lody transport 布局内都会被拒绝。只有身份完全匹配且路径安全的 marker 才能跳过探测；身份不匹配或不安全的 marker 不能在探测失败时作为回退，因此无法建立安全原生布局时会 fail closed。

## 证据

- 之前默认探测会携带继承的进程环境执行 `git --exec-path`，并直接选择 `<execPath>/git`，没有检查该文件是否为生成的 wrapper。
- `realGit` 和 `statePath` 匹配的 marker 会绕过探测；身份不同但仍可用的 marker 则可能在探测失败时被复用。
- 测试通过真实的 `ensureGitHubGitTransport` 入口捕获生成 wrapper 的子进程目标；不会执行递归进程。

## 决策

探测使用 `process.env` 副本，并删除所有大小写形式匹配 `GIT_EXEC_PATH` 的键。路径会解析符号链接，并检查 transport marker 和生成的 Git shim，包括改名后独立存放的 shim。输出目录即使尚未创建 marker 也始终排除；每个候选文件最多读取 8 KiB。探测命令本身必须解析为 transport 布局之外的可执行文件。marker 只有在版本、精确的 `realGit` 与 `statePath` 身份、可执行的 `nativeGit` 和布局外的 `execPath` 都有效时才可复用。探测失败时不复用身份不匹配或无效的 marker。安全探测成功后，如果 core Git 不存在或不安全，只回退到已验证的原生 `realGit`。

## 备选方案

- 探测失败时复用身份不匹配的 marker，可能在调用方切换 Git 安装或 state 路径后保留 wrapper 目标，因此不再作为紧急回退。
- 探测失败后回退到未验证的 `realGit`，可能启动递归 wrapper 或生成不完整的 transport 布局；安全结果应是准备失败。

## 验证与限制

- transport 定向套件覆盖污染环境、精确 marker 复用、无效／自身／跨 workspace marker、符号链接别名、探测失败及拦截 wrapper 子进程目标。
- 按要求通过本地 Vitest 定向套件验证目标行为。代码包含 Windows 路径检查，但本次未在 Windows 执行。
