# Repair causal history order across RPC gate release

Status: implemented
Translation: current

[中文](2026-10-16-turn-history-causal-order.zh.md)

## Abstract

RPC output can precede its late user row after the bounded history gate releases.
The executor arms document-owned repair at gate creation, and shared readers
project causal order for historical inversions. Repair retains user containers and
waits for every unresolved permission outcome, including on finished entries,
because copying an assistant would retire the remote response target. Unresolved
permissions may leave storage inverted indefinitely; reads remain causal.

## Evidence and decision

The base is `8bda5ae33f97fae84e388cb57d6d3ec92566b1f5`, with Loro 1.16.3.
Real MessageHandler, LoroRepo, SessionDocument and two in-memory replicas reproduce
the concurrent ordering with executor peer 1 and client peer 2. Gate waits are
fake-timed and imports explicit. Tests assert the raw inverted list before repair,
read order immediately, and convergence of both raw lists after repair.

Gate creation arms repair before any output. Timeout, gate disposal and turn
replacement release writers without dropping document-owned repair. Failure and
warning notices capture `userTurnId` before awaits; active-turn file/image fallbacks
retain their captured owner through upload and gate release. The writer relocates
associated non-user rows only. User and unrelated rows retain relative order.
Both repair and projection anchor on the first actual user copy, so a legitimate
assistant between duplicate user rows stays in place; ordinary targeted lookup
still selects the last matching identity.

`HistoryWriter` copies inverted attached non-user containers after that anchor and
deletes their old occurrences in one commit, preserving opaque stored fields.
Copies receive new container ids. The user container retains its identity and
concurrent status/configuration edits. Streaming producers resolve by entry id on
every write; tests cover continued streaming and restart after relocation.

Finished entries still accept a previously missing permission outcome. A two-replica
regression holds the original assistant container while its outcome is absent,
commits the decision on the peer after the attempted repair, and verifies that
repair then copies the accepted decision and both replicas converge. `finished`
never releases this guard. Explicit null also defers conservatively, although the
current single-assignment responder rejects an already present null outcome.
No response is treated as renewed authorization to execute a finished turn.

One association helper serves repair, projection and selected turn output. A
string `userTurnId` wins; otherwise only `assistant:<userTurnId>` supplies a legacy
fallback, including malformed non-string associations. User rows never associate
as executor output. Directory/positional/full reads share causal order without
rewriting storage; CLI/MCP export and renderer ConversationView consume it.

Editable-tail planning now uses the same projected order as eligibility checks.
It translates retained row references back to their stored positions instead of
reordering the raw prefix. Conditional rollback restores the original stored order;
interleaved retained rows remain subject to its conservative changed-range conflict
check. Import commit hashes already used raw storage, but CLI conflict prechecks
used projected reads: both prechecks now use the existing storage snapshot surface.
Cursor baselines remain raw; hashes and storage formats do not change. Complete
import replacements that reorder retained stored identities still follow the
writer's existing `unsupported_reorder` refusal; this correction does not relax it.

The repair watcher subscribes directly to its composed Loro document, without an
unused initial directory. It retries on structure, identity, item structure and
permission changes, skipping ordinary streamed text. Pending ids share a coalesced
microtask; the identity index skips absent users. Recomposition drops subscriptions,
pending ids and obsolete queued work; Roost does not arm this Loro-only repair.

Contract: [history writes](../../../../specs/session-history-writes.md).
This extends the [single writer decision](../architecture/2026-09-07-single-history-writer.md).

## Alternatives and remaining limits

- Timeout-only subscriptions miss dispose-before-open and restart paths.
- Read ordering alone does not repair durable order, but safely covers historical
  sessions and permissions whose outcomes never arrive.
- Moving a user loses concurrent edits because attached LoroList containers copy.
  Moving a finished assistant with an unresolved permission has the same hazard.
- Waiting forever at the gate would remove bounded degradation; only relocation waits.
- A movable-list migration could retain relocated container identity across peers,
  but requires a cross-version storage change and is outside this correction.

No cheap guard proves that an arbitrary peer will never write into a retired
non-user subtree. Permission responses are protected; other stale remote subtree
edits and inserts anchored to retired rows remain unverified. Single-executor
streaming resolves current entries by id. Broader remote mutation safety needs a
storage/identity design rather than assuming `finished` means immutable.

The insert/delete repair is not an abortable transaction in Loro 1.16.3. Unexpected
native exceptions partway through mutation can leave pending partial operations;
a temporary fault-injection probe confirms that a later unrelated commit flushes
the partial copy. The probe is removed after execution. This follow-up does not
claim exception-atomic repair. Fork/import staging is
rejected because local transports upload local events only; full-document revert
would introduce unrelated compensation writes. An exception-safe move remains deferred.
Retries still scan on relevant structural/permission events. An id with no actual
user row (even if a non-user shares its id) stays pending until arrival or document
disposal. Closing/recomposing drops registrations; reopening projects order but
does not migrate historical storage. Unassociated historical notices/files cannot
be reconstructed from timestamps. No deployed-client acceptance is claimed.

## Verification

Before the fixes, the new shared regressions produced six failures covering
finished permissions, duplicate users, malformed association fallback, selected
legacy output and two inverted-tail shapes. Two real import-writer regressions
also failed on the projected/raw baseline split. These executed failures establish
remove-fix sensitivity; the final focused commands and results are recorded below.

Independent review is arranged by the host; these checks do not constitute that review.

Environment: Node 22.23.2, pnpm 10.20.0. No dependencies or submodule pins changed.

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

CLI: 9 suites, 168 tests; shared: 5 suites, 106 tests; components: 4 suites, 41 tests.
All passed; the final gate rerun passes 2 suites / 36 tests. All three package
typechecks and the local-writer boundary check pass. Scoped type-aware Oxlint has
164 warnings and zero errors. Oxfmt checks 16 changed files; docs check has zero
errors with existing repository warnings. Full `pnpm check` was not rerun. No
partners were dispatched; host-owned independent review remains separate.
