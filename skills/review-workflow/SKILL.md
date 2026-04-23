---
name: review-workflow
description: >
  Run high-signal AI code review on a diff, pull request, merge request, commit,
  or uncommitted changes. Use this whenever the user asks to review code,
  audit a patch, inspect a PR/MR, check a git/jj diff, do a re-review after
  fixes, or asks whether a change is safe to ship. Also use it when the user
  wants specialist-style review (security/performance/docs/release/AI workflow),
  incremental re-review, or structured findings with priority and verdict.
  Trigger on phrases like "review this diff", "代码审查", "看下这个 PR",
  "re-review after fixes", "audit this patch", "check this merge request",
  "审一下这次改动", even if they do not explicitly mention code review workflow.
---

# Review Workflow — Portable AI Code Review

Portable review workflow for agents that do **not** have Pi's dedicated review extension.

Goal: reproduce most of the extension's value with plain tools, shell commands,
and disciplined prompting.

Detailed **Shared Review Semantics / 共享审查语义** live in `reference.md`.
Read that file when you need canonical risk tiers, specialist/coordinator flow,
and re-review feedback handling shared with the Pi-side implementation.

## What this skill covers

- Diff target selection (`git` or `jj`)
- Risk tiering: `trivial` / `lite` / `full`
- Specialist-style multi-pass review
- Final coordinator merge pass
- Structured findings with P0-P3 priority
- Incremental re-review after fixes
- Human feedback handling: `acknowledged`, `won't fix`, `I disagree`

## What this skill does NOT provide

- Pi widget / session UI
- Hidden side sessions or non-modal review state
- Automatic persistence unless you write it into files or conversation notes

If Pi extension exists, prefer extension for UI/runtime. Otherwise use this skill.

## Step 1: Detect VCS

```bash
# Prefer jj in colocated repos
if test -d .jj; then echo jj; else echo git; fi
```

## Step 2: Select review target

### Git

- Uncommitted changes:
  ```bash
  git status --porcelain
  git diff
  git diff --staged
  ```
- Against base branch:
  ```bash
  git merge-base HEAD main
  git diff <merge-base>
  ```
- Specific commit:
  ```bash
  git show <sha>
  ```

### JJ

- Uncommitted changes:
  ```bash
  jj status
  jj diff
  ```
- Against bookmark:
  ```bash
  jj log -r 'heads(::@ & ::main)' --no-graph
  jj diff --from 'heads(::@ & ::main)' --to @
  ```
- Specific change:
  ```bash
  jj --ignore-working-copy diff -r <change>
  ```

## Step 3: Risk-tier the change

Use these rules:

- **trivial**
  - ≤10 changed lines
  - ≤20 files
  - no security-sensitive files
- **lite**
  - ordinary review-sized change
  - no obvious high-risk surface
- **full**
  - >100 changed lines, or >20 files, or touches auth/crypto/session/token/permission/etc.

Also strip review noise mentally:

- lockfiles
- minified bundles
- source maps
- obvious generated files

Do **not** filter out:

- migrations
- schema changes
- auth/permission changes
- destructive operations

## Step 4: Run multi-pass review

### trivial

Use one code-quality pass, then coordinator conclusion.

### lite

Do code-quality first, then only relevant specialist passes.

### full

Run specialist passes explicitly:

1. **Code Quality** — correctness, state flow, silent failure, maintainability regressions
2. **Security** — exploitable auth/input/secret/injection issues
3. **Performance** — hot-path regressions, backpressure gaps, unbounded growth, extra IO
4. **Release** — dependency, migration, compatibility, deployment risk
5. **Docs** — changed behavior not reflected in docs, comments, user prompts
6. **AGENTS / workflow** — AI workflow or repo conventions changed but AI instructions not updated
7. **Coordinator** — dedupe, severity normalization, final verdict

For each specialist pass, ask:

- What to flag?
- What NOT to flag?
- Which concrete changed lines prove it?

## Step 5: Keep findings high-signal

Only report issues that satisfy all of these:

1. real effect on correctness / security / performance / maintainability
2. actionable and specific
3. introduced by this diff
4. likely worth fixing if author knew
5. backed by concrete changed code

Avoid:

- style-only comments
- speculative risks with weak preconditions
- unchanged legacy problems
- generic "add more error handling" noise

## Step 6: Use explicit decision rubric

- only suggestions → `approved_with_comments`
- warning but no production risk → `approved_with_comments`
- multiple warnings forming a risk pattern → `minor_issues`
- any critical / obvious production-safety issue → `significant_concerns`

Bias toward approval for small, clean changes.

## Step 7: Output format

Use structured output with stable finding IDs. If your environment supports a comment thread / 评论线程 per finding, carry that too:

```markdown
## Findings
- [P1][F-auth-expiry][thread:T-auth-expiry] path/to/file.ts: short headline
  Why this matters. Concrete scenario. Changed lines only.

## Verdict
approved_with_comments | minor_issues | significant_concerns

## 人工审查提示（非阻塞）
- **此改动修改了认证/权限逻辑：** <details>
- （无）
```

Priority guide:

- `[P0]` release-blocking / severe universal break
- `[P1]` urgent, next-cycle fix
- `[P2]` important but ordinary
- `[P3]` low priority

## Step 8: Re-review after fixes

When reviewing follow-up changes:

1. read previous findings first
2. separate old issues into:
   - still open
   - resolved
   - disputed / acknowledged / won't-fix
3. only re-emit issues that still exist, got worse, or remain disputed
4. do **not** blindly repeat fixed issues

## Step 9: Human feedback handling

If the author says:

- `acknowledged ...` or `won't fix ...`
  - keep as historical context
  - suppress from active re-review findings unless risk materially increases
- `I disagree ...`
  - keep it active as a disputed finding
  - re-check code before repeating
  - if still valid, explain why briefly and concretely

Prefer explicit finding IDs or thread IDs in follow-up feedback, e.g. `acknowledged F-auth-expiry`, `I disagree F-cache-growth`, or `I disagree thread:T-cache-growth`.
Loose natural language still counts too. If user clearly acknowledges or disputes a finding, treat it as feedback even if they do not quote the exact text verbatim.

## Step 10: Portable memory strategy

Without Pi extension state, persist review memory in one of these ways:

- notes in conversation
- a local markdown file
- a structured JSON file with finding keys/status

Minimum fields:

- target key (`git:baseBranch:main`, `jj:commit:abc`, etc.)
- summary
- finding list
- optional `threadId` / reply-to-finding comment thread ID when available
- status: `open`, `resolved`, `acknowledged`, `disputed`

## Example portable flow

1. detect repo type
2. compute diff target
3. classify `trivial/lite/full`
4. run specialist passes only where needed
5. run coordinator merge
6. emit structured findings + verdict
7. persist review memory for later re-review
