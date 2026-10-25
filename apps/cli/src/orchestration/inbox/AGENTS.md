# Inbox admission

`CLAUDE.md` links here; edit this file. Root/CLI/orchestration rules apply.

- Persist human/task input evidence before transport under the batch-fencing
  gate, with no await gap. Steer uses input kind/id, never batch.
  Post-fence uncertainty, including stale ACP, never replays; retry settlement only.
  Missing legacy evidence means unknown outcome.
