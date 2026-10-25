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

Ordinary tail appends extend the shallow index even when the stored prefix remains
inverted; every observer receives only the appended suffix. A late user matching an
orphan output, middle insertion/deletion, identity edit, or mixed prefix-content edit
still invalidates the affected prefix. Legacy text association edits also invalidate it.
With 1000 existing rows, each independent append reads one index slot plus one slot per
directory consumer instead of rescanning every prefix. Both 128/1000-row regressions
and two shipped conversation-reader instances cover this behavior deterministically.

The current adapter also preserves bounded child-run display previews, exact opened-run
reads and narrow model summaries. Authoritative/export reads remain complete. Ordering
never rewrites containers or materializes child transcript bodies for the directory.

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
