# Shared ACP history

`CLAUDE.md` links here; edit this file. Root/shared rules apply.
Session storage/readers also follow [Session history](../session-data/AGENTS.md).

- Normalized subagent events persist inside `subagent_task.run`, keyed by root ACP
  session plus run id. Bind the initiating turn once; child output never changes root
  turn identity, plan, tools, or accounting. Ignore unregistered/terminal output,
  reject lineage cycles, and retain incomplete observation across snapshots. Declare
  nested transcript streaming fields in `schema.ts`; legacy rows stay unchanged.
- Root and normalized child ACP tools share `buildToolCallMessageForHistory` and
  `mergeToolCallMessage` in `acp/history-apply.ts`: omit read bodies/edit diff text,
  strip images/unused resource bytes, and bound terminal commands/output identically.
  Derive paths before filtering; preserve omitted vs explicitly cleared lists and
  monotonic status. Keep only displayed switch-mode plans and scheduling raw fields,
  not generic raw or provider metadata copies. Permission enrichment preserves stored
  content; malformed new retained values reach writer validation. CLI edit evidence
  consumes enriched notifications with the original owning turn, not stored diff bodies.
