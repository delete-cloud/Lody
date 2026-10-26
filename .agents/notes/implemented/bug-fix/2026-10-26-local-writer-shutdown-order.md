# Keep the local writer alive through workspace shutdown

Status: implemented
Translation: current
PR: [#8](https://github.com/delete-cloud/Lody/pull/8)

[中文](2026-10-26-local-writer-shutdown-order.zh.md)

## Abstract

Fleet stopped the shared local-writer runtime while workspace cleanup still needed
it. An active turn could delay engine disposal until after that runtime had closed,
causing `ManagedRuntime disposed` before the Repo's final persistence barrier.
Socket admission still stops immediately, but the shared writer now closes after
workspace and local-service cleanup succeeds. Unit regressions prove the ordering,
unflushed metadata recovery and release retry; real desktop restart acceptance is
still pending.

## Ownership and recovery

This corrects the application integration of the
[existing native writer](../architecture/2026-10-12-effect-local-presence-writer.md).
The socket phase disconnects peers without destroying the application executor.
Each workspace releases its engine owner and then its Repo; Fleet closes the shared
writer after those owners and local services finish. No new runtime or migration is
introduced: Fleet and the Repo remain existing Legacy orchestration.

A failed workspace or local-service release keeps its existing failure policy.
Final writer failure retains the same writer and full Cause. Its close occurs before
assigning the global shutdown receipt, so `recoverShutdown()` can retry it; concurrent
recovery callers share the existing receipt. This does not broaden retry behavior for
other global cleanup or weaken the local-service failure gate.

Skipping `closeOwner` when `isReleased()` is true would avoid an already-completed
global close, but a boolean check alone leaves a race while runtime disposal is in
progress. Preserving the dependency lifetime avoids adding coordination to that facade.

## Evidence and limits

The production Fleet regression holds workspace cleanup on an explicit barrier:
the real Unix socket closes and refuses new connections while the writer remains
usable. Releasing the barrier closes engine, Repo and writer in that order. With the
normal persistence debounce held by a fake clock and no explicit `repo.flush()`,
metadata absent from SQLite before shutdown is present after reopening the database.
A real writer drain-unsubscribe failure retains its subscription and runtime until a
successful shared recovery; the original failure remains observable.

Both regressions fail before the change and pass after it. These are isolated Node
storage/socket tests with synthetic data. They do not establish Electron IPC/provider
resumption, VM desktop acceptance or the outcome of an interrupted hosted operation.
