# 工作区关闭完成前保留本地 writer

Status: implemented
Translation: current
PR: [#8](https://github.com/delete-cloud/Lody/pull/8)

[English](2026-10-26-local-writer-shutdown-order.md)

## 摘要

Fleet 曾在工作区清理仍需使用共享本地 writer 时关闭其 runtime。活跃 Turn
可能使 engine 释放晚于 runtime 关闭，从而在 Repo 最终持久化之前触发
`ManagedRuntime disposed`。现在 socket 仍立即停止接收连接，但共享 writer
会等待工作区和本地服务清理成功后再关闭。单元回归证明了关闭顺序、未显式
flush 的元数据恢复及释放重试；真实桌面重启验收仍待完成。

## 所有权与恢复

本次修正[既有原生 writer](../architecture/2026-10-12-effect-local-presence-writer.zh.md)
的应用集成。socket 阶段断开 peer，但不销毁应用 executor；每个工作区先释放
engine owner，再关闭 Repo，最后由 Fleet 在这些 owner 和本地服务释放完成后
关闭共享 writer。未新增 runtime 或迁移；Fleet 和 Repo 仍采用既有 Legacy 编排。

工作区或本地服务释放失败时沿用既有处理策略。最终 writer 释放失败保留同一
writer 和完整 Cause。关闭发生在赋值全局 shutdown receipt 之前，因此
`recoverShutdown()` 能实际重试；并发恢复仍共享既有 receipt。这不扩展其他
全局清理的重试行为，也不放宽本地服务失败门禁。

在 `isReleased()` 为 true 时跳过 `closeOwner` 可以避开已完成的全局关闭，
但单一布尔检查仍存在 runtime 正在销毁时的竞争窗口。保留依赖的完整生命周期
可以避免给该 facade 增加新的协调机制。

## 证据与边界

生产 Fleet 回归用显式 barrier 暂停工作区清理：真实 Unix socket 已关闭并
拒绝新连接时，共享 writer 仍可用。解除 barrier 后依次关闭 engine、Repo、
writer。用 fake clock 固定正常持久化 debounce，且不显式调用 `repo.flush()`，
关闭前尚未进入 SQLite 的元数据在数据库重开后完整保留。
真实 writer 的 drain-unsubscribe 故障会保留订阅和 runtime，直到共享恢复成功；
原始失败仍可观察。

两项回归在修改前失败、修改后通过。它们是使用合成数据的隔离 Node 存储／socket
测试，不证明 Electron IPC／provider 恢复、VM 桌面验收或被中断托管操作的结果。
