# RPC 历史门禁释放后的因果顺序修复

Status: implemented
Translation: current

[English](2026-10-16-turn-history-causal-order.md)

## 摘要

RPC 回合可能在执行端收到用户历史条目前就产生回复、通知或上传条目。门禁在 20 秒后释放输出，
两个并发 List 插入可能收敛成回复在提问之前。执行端现在创建门禁时即登记文档级迟到修复，共享读取层
同时为已有倒序提供因果顺序。修复保留用户容器，并在活跃权限请求尚未回复时推迟复制
assistant；等待期间输出仍可用，读取已呈现正确顺序。

## 证据与决策

当前基线为 `8bda5ae33f97fae84e388cb57d6d3ec92566b1f5`，Loro 锁定在 1.16.3，
与报告的生产复现版本一致。MessageHandler 所属测试使用真实 LoroRepo、SessionDocument
和第二个内存副本；客户端 peer 2、执行端 peer 1 会先产生确定的原始倒序，再验证修复后
两端的原始列表收敛。定时器为假时钟，副本同步通过显式 import 完成。本地验证不代表
已部署客户端验收。

创建门禁时即注册修复，早于等待和输出写入。仅在超时时注册会漏掉门禁被销毁或替换后释放的写入。修复归文档所有，因为回合结束和重启可能在用户
条目到达前销毁门禁。待处理 id 共享一个合并微任务订阅，用户缺失时先查身份索引以跳过修复扫描；用户到达且可安全移动后移除，
文档销毁时释放。权限回复和 assistant 终态也会触发检查，不依赖回合生命周期。

HistoryWriter 仍为唯一历史写入者。修复复制倒置的关联非用户条目到用户之后，并在
同一次提交删除旧位置，保留未知字段和内容，包括旧 inline 条目。移动附着容器会复制并产生新容器 id，
用户容器保持原身份，因此并发用户状态和配置修改仍能合并。流式写入在入队时绑定条目 id，每次写入按 id 重新定位；测试覆盖移动
前后及回合重启后的内容。这依赖既有单执行端约束。

renderer 的权限回复会远程写入 assistant 内部。尚未回复的活跃请求不能立即复制，修复
等待回复或 assistant 结束；读取排序立即生效。复制时保留已接受的 outcome，已结束回合
的权限回复不会重新授权执行。

`orderSessionHistory` 只移动倒置的关联非用户条目，不修改条目，保持用户及无关条目的相对
顺序，已正确排序的数组保留引用。显式 `userTurnId` 优先，旧记录回退到
`assistant:<userTurnId>`（仅 assistant 行）。通知在任何 await 前捕获用户身份；
活跃回合的文件/图片回退沿用上传开始时的身份，跨异步传输和门禁释放不改归属。用户和无关联
system 条目从不被移动。无关联的历史通知/文件无法恢复因果关系，保留原存储顺序。共享 Loro SessionData reader 服务 CLI/MCP history、export
和 renderer 的 ConversationView；浅目录和位置读取共用索引，仅结构、id、role 或关联
变化使其失效，正文变化仍按确切 id 通知。`readAll` 返回因果顺序，writer 的 capture 保留
原始存储顺序。SessionDocument 使用已组合的 SessionData writer 与历史订阅，控制 Mirror
和 useSessionDoc 不恢复完整历史物化。无效旧槽位仍保留，排序不会使读取崩溃。

本改动扩展[单 writer 决策](../architecture/2026-09-07-single-history-writer.md)，
没有允许任意 callback 重排。[历史写入契约](../../../../specs/session-history-writes.zh.md)
记录相关保证。

## 替代方案与限制

- 仅保留门禁订阅：回合清理仍会销毁它。
- 仅读取排序：已有视图正确，但迟到回合的持久列表仍会倒置。
- 移动用户：LoroList 会复制附着容器；双副本反例表明并发 canceled 状态可能丢失，
  用户行还接收 renderer 配置修改。
- 移动未回复权限的 assistant：同样会丢失发往旧容器的远程回复，因此仅推迟该结构操作。
- 一直等待网络恢复：破坏有界降级。
- 换成可移动 List：需要跨版本存储迁移。

附着的非用户容器移动后获得新容器 id，生产者必须按业务 id 定位。任意远程修改已退休的 assistant
容器和多个并发执行端不在单执行端契约内；活跃权限是此处处理的已知例外。文档关闭会丢弃
待修复登记，重新打开仍能正确读取，但不会迁移已有存储。门禁与修复仍由原有文档及 Promise
生命周期持有，将整个 backend 和回合生命周期迁到 Effect 不属于此次修正。

## 验证

修正说明：初始实现使用了过期基线。本次在 rebase 后进一步补齐通知/上传回退与门禁创建时登记修复，保留权限等待和有界门禁，
改用当前 SessionData 组合、backend 订阅及窗口化 renderer 入口，不恢复上游已删除的
accepted-history projection。原基线的全工作区检查不能证明本次结果。

聚焦验证覆盖超时、回合清理后迟到、双副本收敛、用户容器身份与并发编辑、修复及重启后的
流式输出、重复同步、权限回复及终态、未知字段、关联通知/文件、门禁打开前销毁、上传期间
回合替换、已有倒序的 CLI/MCP/export 读取，以及
真实窗口 ConversationView 的持续更新。测试不替代独立 Review。

执行环境为 Node 22.23.2、pnpm 10.20.0；依赖安装与 adapter 构建在本次跟进之前完成，
最终聚焦验证使用以下命令：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter lody prepare:acp-adapters
TMPDIR="$PWD/.turn-order-followup-tmp" corepack pnpm --filter lody exec vitest run tests/message-handler-turn-history-gate.test.ts src/session/turn-history-gate.test.ts tests/session-history-targeted-write.test.ts src/session/session-backend.test.ts src/lib/session-export/formatters.test.ts tests/message-handler-image-upload.test.ts --maxWorkers=2
corepack pnpm --filter @lody/shared exec vitest run tests/history-writer.test.ts tests/session-doc-forward-compat.test.ts tests/session-data-review-boundaries.test.ts tests/session-history-import-port.test.ts tests/session-history-actions.test.ts --maxWorkers=2
corepack pnpm --filter @lody/components exec vitest run tests/conversation-view-from-reader.test.ts tests/use-session-doc-open.test.tsx tests/latest-frame-subscription.test.ts tests/no-materialized-history-in-components.test.ts --maxWorkers=2
corepack pnpm --filter lody typecheck
corepack pnpm --filter @lody/shared typecheck
corepack pnpm --filter @lody/components typecheck
corepack pnpm check:local-loro-writer-boundary
corepack pnpm run docs status
corepack pnpm run docs check
```

聚焦 CLI/shared/renderer 结果为 78/100/41 项通过，三个包的 typecheck 均通过。
图片上传所属套件保留既有行为。真实 MessageHandler/双副本回归仅替代传输/路径验证，
并强制活跃回合 append 返回未命中以触发文件回退；断言捕获的关联、原始倒序、修复前的
reader 顺序、两端原始列表收敛、payload 保留、用户容器身份以及后续流式写入/重启。
renderer 回归扩展既有的窗口 reader 套件。

已执行移除修正的反证，并在 `finally` 恢复源码：仅超时登记导致门禁打开前销毁用例失败
（1 项）；移除通知/文件关联导致两条生产路径失败（2 项）；仅 assistant 排序/修复导致
system、inline 通知与读取投影回归失败（3 项）。保留每个订阅者前序排序状态的既有前缀回归。
聚焦 type-aware Oxlint 为 348 warnings、零 errors；Oxfmt 检查整个 PR 的变更文件，
docs check 为零错误。本次跟进未重跑全量 `pnpm check`，未声称已部署客户端验收或
此次修正的独立通过审查。
