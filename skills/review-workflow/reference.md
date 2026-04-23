# Shared Review Semantics

Canonical portable review semantics shared between Pi-specific runtime behavior and portable skill workflow.

## Risk tiers

- `trivial` — very small low-risk changes; bias toward approval
- `lite` — normal changes; run code-quality first, then only relevant specialists
- `full` — large or security-sensitive changes; run specialist passes and final coordinator merge

## Specialist + coordinator flow

1. Code Quality
2. Security
3. Performance
4. Release
5. Docs
6. AGENTS / workflow
7. Coordinator merge pass

Coordinator responsibilities:

- dedupe overlapping findings
- normalize severity
- preserve approval bias on low-risk changes
- map verdict to `approved_with_comments`, `minor_issues`, or `significant_concerns`

## Re-review continuity

Carry forward prior review state by target key. Give each finding a stable finding ID such as `F-auth-expiry` so later feedback can refer to one finding exactly. If your environment has a comment thread / 评论线程 per finding, also carry a thread ID such as `thread:T-auth-expiry` so reply-to-finding context stays attached to the right issue. Track findings as:

- `open`
- `resolved`
- `acknowledged`
- `disputed`

Keep unresolved or disputed findings active in follow-up review. Prune stale resolved history so memory stays compact.

## Human feedback handling

Treat these as structured feedback:

- `acknowledged`
- `won't fix`
- `I disagree`

`acknowledged` / `won't fix` suppress a finding unless risk materially increases.

Prefer explicit references like `acknowledged F-auth-expiry` or `I disagree thread:T-auth-expiry` when you have stable finding IDs or comment thread IDs.

`I disagree` keeps a finding alive as disputed so later re-review can re-check and explain whether it still stands.
