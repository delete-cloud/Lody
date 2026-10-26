# 浏览器回归前先编译 Storybook

Status: implemented
Translation: current

[English](2026-10-27-static-storybook-browser-regression.md)

## 摘要

会话浏览器回归耗尽30秒用例时限时，Storybook 开发服务器仍在加载故事模块图。
真实3000条历史的视图尚未出现就绪标记，也未执行 Open，因此失败没有测到预期的挂载和滚动行为。
浏览器回归现在先构建静态 Storybook，再由独立配置的 Vite preview 提供构建产物。
构建失败会阻止进入测试；用例时限、夹具和界面断言保持不变。这项准备流程修改仍需真实浏览器验证。

## 证据与决定

原基线和历史修复版 trace 在就绪断言前均显示 `sb-show-preparing-story`，没有故事的就绪或 Open 节点。
两版实际 index 资源均包含目标故事 ID。iframe 内的 No Preview/error 文本属于隐藏模板，不能证明可见的故事错误。
导航已消耗30秒用例时限中的约16–18秒，结束时部分故事依赖尚未记录响应完成。
这些事实支持将编译与行为测试分开，不支持归因于历史 reader，也不能据此宣称某个具体 Vite 缺陷。

使用已有 `build-storybook` 命令和 Vite 依赖。CI 在原 Playwright 命令前增加明确的构建步骤。
包内 `test:e2e`、`test:e2e:ui` 也先构建，构建失败即停止，即使已有旧产物也不会继续。
直接调用 Playwright 前需显式完成新构建。托管服务器使用独立的 preview 配置，避免加载产品 Vite 插件成为开发编译器。
端口冲突直接失败，不复用无关服务器。原服务器启动等待和用例时限均不改变。

考虑过增加模块准备 fixture；它需要为开发优化器定义额外的就绪信号、错误处理和进程归属。
单纯预热故事或延长等待仍可能掩盖模块错误，已有静态构建提供了更简单的准备步骤。
这条路径使用生产构建而非 React 开发模式，旧开发服务器的时序不能直接当作同条件性能基线。
交互式 Storybook 开发仍独立保留。

本决定补充 [Storybook 环境修正](../bug-fix/2026-09-26-storybook-dev-node-env.zh.md)，
不修改 [onboarding 最终动作决定](2026-10-14-e2e-onboarding-final-action.zh.md)。
一次加探针的 intro 成功不能证明此前未修改源码的超时已修复；本补丁不包含 intro 产品或 harness 修改。

## 验证与限制

纯 Node 命令契约测试使用合成外部工具，执行真实包脚本与托管服务器命令。
测试观察浏览器消费者运行前旧构建内容被替换、构建失败阻止消费旧内容、UI 参数保留和 preview 目录选择。
四项在旧入口均失败，修改准备流程后均通过。这些测试不启动浏览器，也不能证明真实视图已渲染。

未修改的静态构建首次失败，是独立依赖副本尚未构建 ACP core 和 DSH 导出的 JavaScript。
构建已锁定的 core 和 DSH 可补齐这些工作区准备条件；失败日志保留，不归为产品回归。
静态 Storybook 编译随后通过，相关检查和 VM 验收分别在交接中记录。浏览器/Electron 仅在指定 VM 执行，不宣称本机界面验收。
