# Classify ended inputs by persistent submission evidence

Status: implemented
Translation: current

[中文](2026-10-23-ended-input-outcome.zh.md)

## Abstract

Daemon shutdown can finish an Inbox input while its user history stays pending.
Recovery previously reported a pre-prompt failure even after prompt submission.
Submission admission now persists evidence before transport starts; only a proven
unsubmitted input retains the pre-prompt classification. Submitted and legacy unknown
inputs become outcome-unknown, never replay automatically, and allow later messages.
An explicit fresh send requires the existing duplicate-work warning.

## Decision

This corrects the classification in the [ended-input backstop](2026-10-15-access-pending-inbox-withdraw.md),
without changing withdraw, release or no-replay behavior. The nullable integer
`inbox_inputs.submission_started` is 0 for newly accepted inputs, 1 at submission
admission after batch fencing and before transport invocation, and null for migrated
legacy rows. Failure to persist it prevents transport. Evidence means submission may
have begun, not that the provider completed work or left external state unchanged.

The existing native Effect OperationInbox admission owns this write. No additional
runtime or partial migration of Session orchestration is introduced. Existing execution
owners retain cancellation, raw requests, resource release and recovery. Recovery
classifies only ended inputs whose history is still nonterminal: 0 retains
`turn_pre_prompt_failed`; 1/null records `delivery_unknown` with `turn_outcome_unknown`.
Retiring activation releases successors without replaying the original input.

The UI reuses unknown-outcome resend confirmation rather than adding another status.
English and Chinese warnings apply to ordinary messages as well as guidance. This
status already excludes tail Edit & Resend, so it cannot bypass confirmation there.
Manual copying/retyping cannot be identified as a resend; the notice also explains
the duplicate-work risk.

## Alternatives and verification

Changing only the title would neither preserve genuine pre-prompt classification nor
provide resend consent. Assistant history and in-memory promptStarted cannot prove
submission across no-output attempts and process restart. Durable evidence is more
precise; legacy rows conservatively report uncertainty.

Tests use a real SQLite file, native submission/release, exported synthetic Loro history
and fresh recovery objects. They cover submitted/unsubmitted inputs, legacy schema
migration, submission-evidence write failure, repeat restart with no replay, and a
subsequent message executing. Component tests cover English/Chinese unknown outcomes,
cancellation and one fresh send after explicit confirmation. These do not replace
real daemon shutdown/restart and browser screenshot acceptance on the authorized VM.
