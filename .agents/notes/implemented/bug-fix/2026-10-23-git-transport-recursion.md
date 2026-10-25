# Git transport must reject recursive wrapper paths

Status: implemented
Translation: current

[中文](2026-10-23-git-transport-recursion.zh.md)

## Abstract

An inherited `GIT_EXEC_PATH` could make the generated Git wrapper select itself as native Git, and a persisted marker could preserve that target after the environment changed. Probes now use a copied environment with every case spelling of `GIT_EXEC_PATH` removed, while marker and probe paths are rejected when they resolve into any generated Lody transport layout. Only an exact-identity, path-safe marker skips probing; mismatched or unsafe markers cannot rescue a failed probe, so preparation fails closed when no safe native layout can be established.

## Evidence

- The default probe previously ran `git --exec-path` with the inherited process environment and selected `<execPath>/git` without checking whether that file was a generated wrapper.
- A marker with matching `realGit` and `statePath` bypassed probing, while a usable marker with a different identity could be reused after probe failure.
- The generated wrapper's child target is captured in tests through the real `ensureGitHubGitTransport` entrypoint; the recursive process is never executed.

## Decision

The probe receives a copy of `process.env` after deleting keys that match `GIT_EXEC_PATH` case-insensitively. Paths are resolved through symlinks and checked against transport markers and generated Git shims, including renamed standalone shims. The output directory is always excluded, even before its first marker exists; wrapper inspection reads at most 8 KiB per candidate. The probe command itself must resolve to an executable outside every transport layout. A marker is reusable only when its version, exact `realGit` and `statePath` identity, executable `nativeGit`, and non-transport `execPath` are all valid. A failed probe never reuses a mismatched or invalid marker. After a successful safe probe, an unsafe or missing core Git executable falls back only to the already validated native `realGit`.

## Alternatives

- Reusing a mismatched marker on probe failure can retain a wrapper target after the caller changes Git installations or state paths, so it is no longer an emergency fallback.
- Falling back to an unvalidated `realGit` after probe failure could start a recursive wrapper or produce an incomplete transport layout; the safe outcome is to fail preparation.

## Verification and limits

- The focused transport suite covers polluted environments, exact marker reuse, invalid/self/cross-workspace markers, symlink aliases, probe failure, and intercepted wrapper spawn targets.
- The target behavior is verified locally by the requested Vitest suite. Windows path behavior is covered by shared path checks in code but was not executed on Windows.
