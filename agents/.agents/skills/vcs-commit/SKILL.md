---
name: vcs-commit
description: >
  Generate and execute a conventional commit for the current changes. Trigger when the user says
  "帮我提交", "commit 一下", "生成 commit message", "create a commit", "commit my changes", or any
  similar request to commit or describe current work. Supports both git and jj (Jujutsu) —
  auto-detects the repo type. Produces Conventional Commits-formatted messages, auto-detects
  commit language from project history, analyzes the diff to understand intent, and asks the
  user when file inclusion is ambiguous.
---

# VCS Commit — Conventional Commits for Git & JJ

Generate a meaningful Conventional Commits message from the current diff, confirm with the user, then execute the commit. Works with both git and jj (Jujutsu).

## Step 1: Detect Version Control System

```bash
# If .jj/ exists, use jj — even if .git/ is also present (colocated mode)
test -d .jj && echo "jj" || echo "git"
```

## Step 2: Inspect Current Changes

**jj repo:**
```bash
jj status    # list changed files
jj diff      # full diff of current change
```

**git repo:**
```bash
git status --porcelain    # file-level overview
git diff --staged         # analyze staged changes first
git diff                  # also review unstaged changes
```

> **If nothing is staged (git):** Don't silently stage everything. Tell the user what's changed and ask which files they want to include — or offer to stage all of them.

## Step 3: Analyze the Diff

Read the diff carefully to understand the *intent* of the changes — not just which files changed, but *why*. Ask yourself:

- What problem does this solve, or what capability does it add?
- Do all the changed files belong to the same logical unit of work?
- Is anything here unrelated to the main purpose (e.g., a README touched while fixing a bug)?

**Proactively ask the user when:**
- A file's changes seem unrelated to the rest (e.g., a config tweak alongside feature work)
- Auto-generated files are present (lock files, generated code) — confirm whether to include them
- Changes span multiple unrelated modules — suggest splitting into separate commits

Example questions:
> "I see `package-lock.json` also changed — should that be included in this commit?"
> "The changes touch both the auth module and the logging system. Would you like one commit or two?"

## Step 3b: Split Changes (if needed)

If the changes span multiple unrelated concerns, offer to help the user split them into separate commits before generating a message. Don't just flag the issue — walk them through it.

### Splitting in a jj repo

Use `jj split` to interactively divide the current change:

```bash
# Split by specific files (non-interactive — good when concerns map cleanly to files)
jj split src/auth.js        # first change gets only src/auth.js; rest stays in a new change
jj split src/auth.js src/auth.test.js   # multiple files

# Interactive split (hunk-level granularity)
jj split                    # opens a diff editor to select hunks
```

After splitting, describe each change separately:
```bash
# jj split leaves you on the second change — describe it first, then go back
jj describe -m "chore: update changelog"
jj edit <first-change-id>
jj describe -m "feat(auth): 添加 JWT token 生成与验证功能"
jj commit   # seal and move on
```

Or use `jj log` to find the change IDs and describe them in any order.

### Splitting in a git repo

Use selective staging to split into separate commits:

```bash
# Stage only the files for the first commit
git add src/auth.js
git commit -m "feat(auth): 添加 JWT token 生成与验证功能"

# Then stage and commit the rest
git add README.md
git commit -m "docs: 更新 changelog"
```

For hunk-level splits:
```bash
git add -p src/auth.js    # interactively select hunks within a file
```

### When to suggest splitting

Suggest splitting (and offer to guide through it) when:
- Two or more clearly distinct features or fixes are mixed together
- A functional change is bundled with unrelated refactoring or docs
- The user says "separate commits" or "split this"

Don't over-split — if the changes are small and naturally related, a single commit is fine.

## Step 4: Generate the Commit Message

### Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | When to use                              |
|------------|------------------------------------------|
| `feat`     | New feature                              |
| `fix`      | Bug fix                                  |
| `docs`     | Documentation changes only               |
| `style`    | Formatting, whitespace (no logic change) |
| `refactor` | Refactor (not a feature or fix)          |
| `perf`     | Performance improvement                  |
| `test`     | Add or update tests                      |
| `build`    | Build system or dependency changes       |
| `ci`       | CI/CD configuration                      |
| `chore`    | Maintenance, tooling, misc               |
| `revert`   | Revert a previous commit                 |

### Breaking Changes

```
# Exclamation mark after type/scope
feat!: remove deprecated endpoint

# Or use footer (for additional detail)
feat(api): redesign authentication flow

BREAKING CHANGE: token format changed from JWT to opaque strings
```

### Scope

- Use a scope when the affected module/component is clear: `fix(auth): ...`
- Leave scope empty when the change is broad or cross-cutting: `chore: ...`
- Keep scope in **English** (matching your codebase identifiers)

### Language Detection

Before writing the description, infer the commit language from recent history:

**jj repo:**
```bash
jj log --no-graph -r 'ancestors(@, 5)' --template 'description ++ "\n"'
```

**git repo:**
```bash
git log --oneline -10
```

Look at the description part (after `type(scope):`) of recent commits:
- If most are in **Chinese** → write in Chinese
- If most are in **English** → write in English
- If mixed → default to English (more universally readable)
- If no history (fresh repo) → default to English

Apply the same detected language to the body as well.

### Description

- Concise, under 50 characters (or ~72 for English)
- Start with a verb (English: imperative mood — "add", "fix", "remove"; Chinese: 添加、修复、重构、更新、移除)
- Describe *what changed*, not *how*

### Body (optional)

- Add a body when the one-liner doesn't capture the motivation or context
- Also in Chinese
- Keep lines under 72 characters

### Issue References (optional footer)

- `Closes #123` — closes the issue on merge
- `Refs #456` — links without closing

### Examples

```
feat(auth): 添加 JWT 登录功能

支持用户名和密码换取 token，有效期 7 天。
移除了旧的 session-based 认证逻辑。

Closes #42
```

```
fix: 修复列表为空时的崩溃问题
```

```
chore(deps): 升级 React 到 18.3.0
```

```
feat!: 移除旧版用户 API

BREAKING CHANGE: /api/v1/users 端点已下线，请迁移至 /api/v2/users
```

## Step 5: Present and Confirm

Show the proposed message in a code block and ask for confirmation:

> 建议的提交信息如下：
> ```
> feat(user): 添加用户头像上传功能
> ```
> 确认提交吗？（直接回复"确认"，或告诉我要修改的地方）

Revise based on feedback until the user approves.

## Step 6: Execute the Commit

**jj repo:**
```bash
# Default: seal the current change and start a new empty one
jj commit -m "<message>"

# If user explicitly wants to only update the description without moving on:
jj describe -m "<message>"
```

**git repo:**
```bash
# Single-line message
git commit -m "<type>[scope]: <description>"

# Multi-line (body or footer present)
git commit -m "$(cat <<'EOF'
<type>[scope]: <description>

<body>

<footer>
EOF
)"
```

After a successful commit, confirm briefly: `✅ 提交成功`

## Safety Rules

### Git
- **Never** update git config without being asked
- **Never** run destructive commands (`--force`, hard reset) without explicit user request
- **Never** skip hooks (`--no-verify`) unless the user specifically asks
- **Never** force-push to `main` or `master`
- **Never** commit secrets (`.env`, credentials, private keys)
- If a commit fails due to hooks: fix the issue and create a **new** commit — don't amend

### JJ
- **Never** use `jj config set` to modify user or repo config without being asked
- **Never** run `jj abandon` on a change that has already been pushed to remote (has a bookmark tracking a remote) without explicit user confirmation
- **Never** run `jj rebase` or `jj edit` on immutable/published changes without explicit user request — jj will block it, but don't attempt it
- **Never** run `jj op restore` to an earlier operation without confirming with the user — this discards all work done since that operation
- **Never** use `git` commands directly in a jj repo (no `git add`, `git commit`, `git stash`, `git checkout`) — always use jj equivalents
- If in doubt after an operation goes wrong, use `jj undo` — it is always safe and fully reversible
