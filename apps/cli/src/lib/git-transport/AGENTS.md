# Git transport and credential selection

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Parent rules apply.

- GitHub auth: conversation-owner personal → matching-owner machine → repo App,
  once per source. Failures advance without a policy RPC; local context grants
  machine eligibility. Never persist managed tokens or replay uncertain writes.
  Checkout/LFS share the pinned helper context. Contract: [identity fallback](../../../../../specs/github-identity-fallback.md).

- Git transport uses exact-identity safe markers, clears `GIT_EXEC_PATH` for
  probes, and never targets wrappers.
  [Decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-23-git-transport-recursion.md).
