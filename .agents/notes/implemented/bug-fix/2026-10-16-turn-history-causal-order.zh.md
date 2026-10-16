# RPC 历史门禁释放后的因果顺序修复

Status: implemented
Translation: current

[English](2026-10-16-turn-history-causal-order.md)

## 摘要

有界历史门禁释放后，RPC 输出可能排在迟到用户条目之前。执行端创建门禁时登记文档级修复，
共享读取为已有倒序提供因果顺序。修复保留用户容器，等待所有未决权限 outcome，包括已结束条目，
因为复制 assistant 会废弃远程回复所指向的容器。权限一直未决时存储可长期倒序，读取仍保持因果顺序。

## 证据与决策

基线为 `8bda5ae33f97fae84e388cb57d6d3ec92566b1f5`，Loro 为 1.16.3。
测试使用真实 MessageHandler、LoroRepo、SessionDocument 和两个内存副本，以执行端 peer 1、
客户端 peer 2 复现并发倒序。门禁使用假时钟，副本通过显式 import 同步；断言修复前原始倒序、
即时读取顺序，以及修复后两端原始列表收敛。

创建门禁时先登记修复。超时、门禁销毁及回合替换释放写入，但不撤销文档级修复。
失败/警告通知在 await 前捕获 `userTurnId`；活跃回合文件/图片回退跨上传与门禁等待保留原所属用户。
writer 只移动关联非用户条目，用户及无关条目保留相对顺序。修复和读取以第一份真正的用户副本为锚点，
两份用户副本之间的合法 assistant 不移动；普通定向身份查询仍选择最后一份匹配条目。

`HistoryWriter` 将倒置的关联非用户附着容器复制到锚点之后，并在同次提交删除旧位置，保留未知字段。
复制产生新容器 id；用户容器保留原身份及并发状态/配置修改。流式写入每次按业务条目 id 重新定位，
测试覆盖移动后的继续输出与重启。

已结束条目仍可接受原先缺失的权限 outcome。双副本回归在 outcome 缺失时保留原 assistant 容器，
在尝试修复之后由另一副本提交决定，再验证修复复制已接受结果并在两端收敛。`finished` 从不解除等待。
显式 null 也保守推迟，尽管当前单赋值 responder 会拒绝已有 null 的 outcome。
回复不构成重新执行已结束回合的授权。

修复、读取排序及单回合输出共用关联函数。字符串 `userTurnId` 优先，否则仅 assistant 可使用
`assistant:<userTurnId>` 回退，包括非字符串的损坏关联。用户不作为执行端输出关联。
目录、位置及完整读取共享因果顺序，不改存储；CLI/MCP 导出和 renderer ConversationView 使用该读取层。

编辑尾部规划现在与资格检查使用相同的投影顺序，再将保留行引用映射回存储位置，避免重排原始前缀。
条件回滚恢复原始存储顺序；交错的保留行仍受保守的变更区间冲突检查保护。导入提交哈希原本使用原始存储，
但 CLI 冲突预检查使用投影读取；两处预检查现改用已有存储快照接口，cursor 基线保持原始顺序，
不改变哈希或存储格式。若完整导入替换要重排保留的存储身份，仍沿用 writer 既有
`unsupported_reorder` 拒绝规则，本次不放宽该限制。

修复观察器直接订阅所组合的 Loro 文档，不再生成未使用的初始目录。结构、身份、item 结构及权限变化
触发重试，普通流式文本不触发。待处理 id 共用合并微任务，用户缺失时先查身份索引。
重新组合会清理订阅、待处理 id 和旧队列工作；Roost 不登记这项仅适用于 Loro 的修复。

契约：[历史写入](../../../../specs/session-history-writes.zh.md)。
本决策扩展[单写入者约束](../architecture/2026-09-07-single-history-writer.zh.md)。

## 替代方案与剩余限制

- 仅超时登记会遗漏打开前销毁和重启路径。
- 仅读取排序不修复持久顺序，但可安全覆盖历史会话及 outcome 永不到达的权限。
- 移动用户会因 LoroList 复制附着容器而丢失并发编辑；移动带未决权限的已结束 assistant 也有同类风险。
- 门禁无限等待会破坏有界退化，因此只推迟结构移动。
- 改为 movable list 可跨副本保留移动容器身份，但需要跨版本存储迁移，超出本次修正。

没有简单守卫能证明任意副本以后不会写入旧非用户子树。这里保护权限回复；其他旧副本子树编辑及
锚定旧条目的插入仍未验证。单执行端流式写入按 id 找当前条目。更广泛的远程修改安全需要存储/身份设计，
不能假定 `finished` 意味着不可变。

Loro 1.16.3 的插入/删除修复不是可中止事务。原生调用中途异常可能留下待提交的部分操作，
临时故障注入探针确认后续无关提交会刷出部分复制；探针在执行后移除。
本次不声称修复具备异常原子性。fork/import 暂存会绕过仅上传本地事件的传输契约，整文档 revert
会引入无关补偿写入，因此延后处理异常安全移动。相关结构/权限事件仍可能触发扫描。
没有真正用户条目的 id（即使非用户条目同 id）持续等待到用户到达或文档销毁。
关闭/重新组合丢弃登记；重新打开仅投影顺序，不迁移历史存储。未关联历史通知/文件无法从时间戳恢复。
未声称已部署客户端验收。

## 验证

修复前新增共享回归实际出现六个失败，覆盖已结束权限、重复用户、损坏关联回退、旧式单回合输出及
两种倒序编辑尾部。两个真实导入 writer 回归也因投影/原始基线分歧失败。
这些已执行失败证明移除修复会失败；最终聚焦命令与结果如下。

独立审查由 host 安排，自测不替代独立审查。

环境：Node 22.23.2、pnpm 10.20.0；未改依赖或 submodule 锁定版本。

```sh
TMPDIR="$PWD/.turn-order-followup-tmp" corepack pnpm --filter lody exec vitest run tests/message-handler-turn-history-gate.test.ts src/session/turn-history-gate.test.ts tests/session-history-targeted-write.test.ts src/session/session-backend.test.ts src/lib/session-export/formatters.test.ts tests/message-handler-image-upload.test.ts tests/local-project-history-sync-writer.test.ts tests/local-project-history-sync-service.test.ts src/session/session-edit-and-resend-service.test.ts --maxWorkers=2
corepack pnpm --filter @lody/shared exec vitest run tests/history-writer.test.ts tests/session-doc-forward-compat.test.ts tests/session-data-review-boundaries.test.ts tests/session-history-import-port.test.ts tests/session-history-actions.test.ts --maxWorkers=2
corepack pnpm --filter @lody/components exec vitest run tests/conversation-view-from-reader.test.ts tests/use-session-doc-open.test.tsx tests/latest-frame-subscription.test.ts tests/no-materialized-history-in-components.test.ts --maxWorkers=2
TMPDIR="$PWD/.turn-order-followup-tmp" corepack pnpm --filter lody exec vitest run tests/message-handler-turn-history-gate.test.ts src/session/turn-history-gate.test.ts --maxWorkers=2
corepack pnpm --filter lody typecheck
corepack pnpm --filter @lody/shared typecheck
corepack pnpm --filter @lody/components typecheck
corepack pnpm check:local-loro-writer-boundary
corepack pnpm run docs status
corepack pnpm run docs check
corepack pnpm exec oxlint --type-aware --quiet apps/cli/src/lib/local-project-history-sync-service.ts apps/cli/src/lib/loro/doc.ts apps/cli/src/session/turn-history-gate.ts apps/cli/tests/local-project-history-sync-writer.test.ts apps/cli/tests/message-handler-turn-history-gate.test.ts packages/shared/src/history-writer.ts packages/shared/src/session-data/loro.ts packages/shared/src/session-data/read.ts packages/shared/src/session-history-order.ts packages/shared/tests/history-writer.test.ts packages/shared/tests/session-data-review-boundaries.test.ts
corepack pnpm exec oxfmt --check .agents/notes/implemented/bug-fix/2026-10-16-turn-history-causal-order.md .agents/notes/implemented/bug-fix/2026-10-16-turn-history-causal-order.zh.md apps/cli/src/lib/local-project-history-sync-service.ts apps/cli/src/lib/loro/doc.ts apps/cli/src/session/turn-history-gate.ts apps/cli/tests/local-project-history-sync-writer.test.ts apps/cli/tests/message-handler-turn-history-gate.test.ts packages/shared/src/history-writer.ts packages/shared/src/session-data/AGENTS.md packages/shared/src/session-data/loro.ts packages/shared/src/session-data/read.ts packages/shared/src/session-history-order.ts packages/shared/tests/history-writer.test.ts packages/shared/tests/session-data-review-boundaries.test.ts specs/session-history-writes.md specs/session-history-writes.zh.md
```

CLI 9 套件 / 168 项、共享层 5 套件 / 106 项、components 4 套件 / 41 项全部通过；
最后门禁复跑 2 套件 / 36 项通过。三包 typecheck、local-writer 边界检查均通过。
聚焦 type-aware Oxlint 为 164 warnings、零 errors；Oxfmt 检查 16 个变更文件；
docs check 零错误，保留仓库既有警告。未重跑完整 `pnpm check`。本次无伙伴委派，
host 安排的独立审查与这些自测分开。
