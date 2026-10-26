# 已结束输入在重启后的执行结果分类

Status: implemented
Translation: current

[English](2026-10-23-ended-input-outcome.md)

## 摘要

daemon 停止会结束 Inbox 输入，但用户历史仍可能待处理。旧恢复流程一律显示启动前失败，即使代理已经接到请求。现在提交许可在启动传输前持久记录提交证据，重启时只有明确未提交的输入保留启动前失败；已提交或旧记录缺少证据时使用结果未知。不会自动重放，下一条消息可以执行，用户主动重发前会看到重复工作警告。

## 决定

这是对[已结束输入兜底](2026-10-15-access-pending-inbox-withdraw.md)的分类修正，不改变撤回、释放与禁止重放。`inbox_inputs.submission_started` 是可空整数：新接受输入写 0，真实提交许可在批次 fence 后、调用传输前写 1；迁移旧记录保留 null。写入失败会阻止传输。该证据表示提交可能开始，不证明请求完成或未修改外部状态。

原生 Effect OperationInbox 许可拥有此写入，按执行 owner 当前 input kind/id 判断，不依赖可选的初始 batch：automatic receipt 没有 `inbox_inputs` 行，steer 也不传 batch。adopt 原子更新输入身份，所以即使保留 automatic 初始批次，后续 human/task steer 仍须持久记录自己的 marker。许可核对 active inputId；marker 绑定 inputId、kind、user 和 execution。human/task 缺行阻止传输，不吞任何缺行错误。lease、auth、Stop/pause、claims 和资源恢复保留既有归属，不新增运行时或生命周期迁移。

恢复仅在输入已结束且历史未终结时分类：0 使用 `turn_pre_prompt_failed`；1/null 使用 `delivery_unknown` 和 `turn_outcome_unknown`。清理原激活以释放后续消息，旧输入始终不自动重放。

UI 复用结果未知消息的重发确认，不增加新的状态枚举。英文和中文将原本针对引导的警告改为普通消息也适用。该状态已排除末尾 Edit & Resend，因此不会通过该路径绕过确认。手动复制或重新输入无法识别为原消息的重发，通知正文也说明重复工作风险。

## 取舍与验证

仅修改标题无法区分真正未提交的失败，也不会提供重发警告。依赖 assistant 历史或内存中的 promptStarted 无法覆盖提交后没有输出及进程重启。持久证据更准确；旧数据宁可显示未知，不虚构没有开始或已经完成。移除 marker 或统一容忍缺行会丢 human/task 证据；额外传 steer 类型 flag 或重复查询 kind 会重复 owner 已拥有的身份。

测试使用真实 SQLite 文件、原生提交/释放、导出的 Loro 合成历史和新建恢复对象，覆盖提交、未提交、旧模式迁移、提交证据写入失败、二次恢复不重放及下一条消息执行。组件测试检查中英文结果未知状态、取消及明确确认后的单次新发送。它们不替代 VM 上真实 daemon 停止重启与浏览器截图验收。

真实 SQLite Inbox 测试还覆盖 automatic 提交后 steer、human adopt、transport 内可见的 human/task 证据、首次提交和 steer 前缺行，以及不同 inputId 被拒绝。已观察到的问题破坏即时 steer，可能退回普通队列；未证实消息丢失。
