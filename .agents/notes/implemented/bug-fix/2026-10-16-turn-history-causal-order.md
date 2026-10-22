# Causal turn history reads after delayed user sync

Status: implemented
Translation: current

[中文](2026-10-16-turn-history-causal-order.zh.md)

## Abstract

An RPC turn can produce output before its user row synchronizes. After the bounded
20-second gate releases, a plain LoroList can converge with that output first.
Shared readers return associated output after the user without changing storage.
Every turn-scoped producer captures the user id before asynchronous work or teardown.
Raw captures keep stored order for import baselines and rollback.

## Decision and correction

This revision removes the earlier executor copy/delete repair. Copying an attached
LoroList container gives it a new identity; an offline peer can still update the old
assistant, tool or permission container, losing its visible edit after deletion.
Waiting for a pending permission does not establish that all peers stopped writing.
Read ordering is the simpler safe alternative and needs no storage migration.
A LoroMovableList migration is outside this fix.

`session-history-order.ts` associates non-user rows by `userTurnId`, falling back to
`assistant:<userTurnId>` only for assistants. Inverted rows follow the first matching
user; unrelated rows retain their relative order. Historical unassociated notices
cannot be inferred from timestamps. Identity lookup still chooses the last duplicate.

The Loro reader shares a shallow order index for directories, windows, model summaries,
selected output and full transcript/export reads. Association edits invalidate positions;
body edits retain the index and report the original turn id. Editable-tail planning uses
reader order and translates retained rows back to storage; import comparisons use raw
captures. Failure notices, warnings and file/image fallbacks keep their captured owner.

Ordinary tail appends extend the existing shallow index. A new user matching an
orphan output, insertion/deletion, identity edit, or existing inversion rebuilds it.
Legacy text association edits invalidate positions too. The previous eager observer
rescanned every prefix during synchronous history seeding: 128 appends performed
8256 slot reads. The deterministic regression fails before this correction and passes
with the incremental path, while still checking late-user causal order. Browser
acceptance is needed to classify the old CI timeout conclusively.

## Verification and limits

Deterministic tests drive the real MessageHandler gate with fake time and two Loro
replicas, including disposal, restart, finalization, notices, uploads and permission
responses. The shipped windowed renderer reader, transcript consumers and editable-tail
rollback are covered. Tests keep raw order and container identities while checking
causal read order and continued edits after sync. Browser/daemon acceptance is separate
and runs on the authorized VM. Old readers that do not implement causal ordering still
see physical order. No Effect migration is needed for the pure ordering computation;
the existing gate and Session orchestration dependencies remain unchanged.

Related decisions: [single writer](../architecture/2026-09-07-single-history-writer.md),
[reader rules](../../../../packages/shared/src/session-data/AGENTS.md).
