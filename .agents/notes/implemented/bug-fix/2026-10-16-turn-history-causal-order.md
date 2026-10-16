# Repair causal history order across RPC gate release

Status: implemented
Translation: current

[中文](2026-10-16-turn-history-causal-order.zh.md)

## Abstract

An RPC turn can produce reply, notice or upload rows before the user entry reaches
the executor. The 20-second gate timeout makes their list insertions concurrent,
so the converged list can place the reply before its prompt. The executing CLI
now arms document-owned late-user repair when creating the gate, and
shared readers project causal order for historical inversions. Repair retains
user containers and defers assistant relocation while a live permission response
is pending; output remains available and readers show causal order meanwhile.

## Evidence and decision

At upstream `8bda5ae33f97fae84e388cb57d6d3ec92566b1f5`, timeout opens the gate and
unsubscribes permanently. The owning MessageHandler suite reproduces the bad
merge with real LoroRepo/SessionDocument and a second real Loro replica, assigning
client peer 2 and executor peer 1. It asserts the raw inverted client list before
repair and both raw lists after repair and repeated synchronization. Timers are
fake; replica imports are explicit. The rebased repository pins Loro 1.16.3, matching the reported production
reproduction. This is local validation, not deployed-client acceptance.

Gate creation arms SessionDocument repair before waiting or creating output.
Timeout-only arming missed writers released by disposal, including turn replacement.
Document ownership matters: finalization and turn restart dispose the gate before
a delayed user might arrive. Only the executing turn arms repair, avoiding
uncoordinated migrations by every reader. Pending ids share one coalesced
microtask subscription; the identity index skips repair scans while a user is absent. User arrival plus safe relocation removes an id; document
destruction releases the subscription. Pending permission resolution and assistant
finalization also trigger rechecks, independently of turn teardown.

HistoryWriter remains the only history author. Its scoped repair clones inverted
associated non-user rows after their user and removes their old list occurrences
in one commit. Copying preserves opaque fields and content, including legacy inline rows.
Relocated attached containers get new ids; user containers are retained.
User containers are retained, so a concurrent user status/configuration edit still
merges into the original row. CLI streaming binds ownership by entry id at enqueue
and resolves the current container on each write; tests cover chunks before and
after relocation and turn restart. This relies on existing single-executor ownership.

Renderer permission responses are a remote writer inside assistant rows. A live
assistant with an unresolved permission therefore cannot be copied yet. The repair
waits for the response or terminal assistant state; read ordering applies immediately.
This preserves the live permission target and copies its accepted outcome. Responses
to an already finished turn do not authorize more agent execution.

`orderSessionHistory` relocates inverted associated non-user rows without mutation.
Failure/warning notices capture the current user id before any await. Active-turn
file/image fallbacks retain their captured upload owner across async transfer and
gate release. User rows and unassociated system rows are never relocation targets.
It preserves user order and unrelated entries. The shared Loro SessionData
reader feeds CLI/MCP history and export, plus the renderer ConversationView.
Directory and positional reads share a shallow canonical index rebuilt on
structure/id/role/association changes; content-only notifications keep exact ids.
`readAll` returns canonical order, while writer captures retain raw storage order.
Invalid legacy slots remain present and cannot crash ordering.
SessionDocument uses its composed SessionData writer and history observation;
the control Mirror and useSessionDoc never materialize history. Already ordered histories retain array identity. Explicit
userTurnId wins over the assistant-only id fallback. Unassociated historical
notices/files cannot be causally reconstructed and remain in their stored order.

This extends the [single writer decision](../architecture/2026-09-07-single-history-writer.md)
with a repair command; arbitrary callback reordering remains forbidden.
Contract: [history writes](../../../../specs/session-history-writes.md).

## Alternatives and limits

- Keeping only the gate subscription fails once turn teardown disposes the gate.
- Read ordering alone heals old views but leaves the durable list inverted.
- Moving the user is rejected: LoroList copies attached containers. A deterministic
  two-replica experiment showed a concurrent canceled status lost when that user
  map was replaced. User rows also receive renderer status/configuration writes.
- Moving an assistant with an unresolved live permission has the same response-loss
  problem. Deferring only that structural operation retains the remote response target.
- Holding output until an uplink recovers removes bounded degradation.
- Changing history to a movable list requires a cross-version storage migration.

Relocated attached non-user containers receive new ids; supported producers must
continue resolving by entry id. Arbitrary remote edits to retired assistant
containers are outside single-executor ownership; live permissions are the known
exception handled here. Multiple concurrent executors remain outside that contract.
A closed document loses pending repair registrations. Reopening still reads in
causal order but does not migrate storage; historical storage is not rewritten by
readers. No deployed MCP/CLI binary or Android acceptance is claimed.

## Verification

Focused tests cover gate timeout, late import after turn cleanup, real two-replica
convergence, user identity and concurrent edits, streamed content before/after
repair, repeated imports, turn reuse, pending permission response/finalization,
opaque stored fields, associated notices/files, disposal-before-open, replacement
during upload, historical CLI/MCP/export projection, and the renderer's
shipped windowed ConversationView and streaming update path. The removed
accepted-history projection implementation is not restored. The gate and repair
remain in their existing document/Promise lifetime; migrating the broader backend
and turn lifecycle to Effect is outside this correction. Tests do not replace
independent Review.

Correction: the original implementation used a stale base. It is rebased onto
`8bda5ae33f97fae84e388cb57d6d3ec92566b1f5`; current SessionData composition,
backend subscriptions, and windowed renderer boundaries replace the old full
Mirror/getHistory interfaces. A subsequent review correction extends repair to notices/upload fallbacks and
arms it at creation; permission deferral and bounded gate waits remain. Verification below is rerun on this base; prior
full-workspace check results do not establish the rebased result.

Environment: Node 22.23.2 and pnpm 10.20.0. Installation and adapter preparation
preceded this follow-up; final focused verification uses the commands below:

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

Focused CLI/shared/renderer results: 78/100/41 tests passed. All three package
typechecks passed. The image-upload suite retains the existing upload behavior;
the real MessageHandler/two-replica regression stubs only transfer/validation and
the failed active-turn append to force the file fallback. It asserts the captured
association, raw inversion, reader order before repair, both converged raw lists,
payload retention, user container identity and continued streaming/restart.
The renderer regression extends its existing windowed reader suite.

Remove-fix checks were executed and restored in `finally`: timeout-only arming
fails the dispose-before-open regression (1 failed); removing notice/file
association fails both producer regressions (2 failed); assistant-only repair/read
ordering fails system, inline notice and projection regressions (3 failed).
Per-observer prior order retains the earlier shifted-prefix regression.
Scoped type-aware Oxlint reports 348 warnings and zero errors. Oxfmt checks all
PR-changed files; documentation checking reports zero errors. Full `pnpm check`
was not rerun for this follow-up. No deployed-client acceptance or independent
passing review of this correction is claimed.
