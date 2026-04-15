import assert from "node:assert/strict";
import test from "node:test";
import {
	type ReviewTarget,
	buildDiffPromptHint,
	getCurrentBranch,
	getLocalBranches,
	getMergeBase,
	getRecentCommits,
	getSmartDefault,
	getTargetLabel,
	hasUncommittedChanges,
} from "./vcs.ts";

// ─── Fake ExtensionAPI ───────────────────────────────────────────────────────

type ExecCall = { command: string; args: string[] };
type ExecResponse = { stdout?: string; stderr?: string; code?: number };
type ExecHandler = (call: ExecCall) => ExecResponse;

function makeFakePi(handler: ExecHandler) {
	const calls: ExecCall[] = [];
	const pi = {
		async exec(command: string, args: string[]) {
			const call = { command, args };
			calls.push(call);
			const response = handler(call);
			return {
				stdout: response.stdout ?? "",
				stderr: response.stderr ?? "",
				code: response.code ?? 0,
			};
		},
	};
	return { pi: pi as unknown as Parameters<typeof getMergeBase>[0], calls };
}

// ─── buildDiffPromptHint sanitize coverage ──────────────────────────────────

test("buildDiffPromptHint(jj baseBranch): 分支名中的单引号会被剥离，避免破坏 revset 引号块", () => {
	const target: ReviewTarget = { type: "baseBranch", branch: "main';rm -rf /;'" };
	const hint = buildDiffPromptHint(target, "jj");
	// 单引号 / 分号 / 空格全部被去掉
	assert.equal(hint.includes("'"), true, "应当仍然有用于 revset 的合法单引号包裹");
	// 但不该出现两组单引号导致引号块被破坏（恶意片段）
	assert.equal(hint.includes("rm -rf"), false);
	assert.equal(hint.includes(";"), false);
	// 清洗后仍能拿到合法 ref
	assert.equal(hint.includes("mainrm-rf/"), true, "字母 / `-` / `/` 保留下来");
});

test("buildDiffPromptHint(jj baseBranch): 普通分支名原样保留", () => {
	const target: ReviewTarget = { type: "baseBranch", branch: "feature/foo-bar_1.2" };
	const hint = buildDiffPromptHint(target, "jj");
	assert.equal(hint.includes("heads(::@ & ::feature/foo-bar_1.2)"), true);
});

test("buildDiffPromptHint(git baseBranch with mergeBase): SHA 与分支名都做清洗", () => {
	const target: ReviewTarget = { type: "baseBranch", branch: "main';evil" };
	const hint = buildDiffPromptHint(target, "git", "abc1234'$evil");
	assert.equal(hint.includes("$evil"), false);
	assert.equal(hint.includes("'evil"), false);
	assert.equal(hint.includes("abc1234"), true);
	assert.equal(hint.includes("'main"), true); // sanitized branch 仍然在引号里
});

test("buildDiffPromptHint(git baseBranch fallback): 无 mergeBase 时也清洗 branch", () => {
	const target: ReviewTarget = { type: "baseBranch", branch: "topic`x" };
	const hint = buildDiffPromptHint(target, "git");
	assert.equal(hint.includes("`"), true, "命令模板里的 markdown ` 仍存在");
	// 但 branch 内的反引号被吞了
	assert.equal(hint.includes("topicx"), true);
});

test("buildDiffPromptHint(commit): SHA 做清洗", () => {
	const gitTarget: ReviewTarget = { type: "commit", sha: "abc;evil" };
	const gitHint = buildDiffPromptHint(gitTarget, "git");
	assert.equal(gitHint.includes(";"), false);
	assert.equal(gitHint.includes("git show abcevil"), true);

	const jjTarget: ReviewTarget = { type: "commit", sha: "xyz|pipe" };
	const jjHint = buildDiffPromptHint(jjTarget, "jj");
	assert.equal(jjHint.includes("|"), false);
	assert.equal(jjHint.includes("xyzpipe"), true);
});

test("buildDiffPromptHint(mergeRequest jj/git): 强制 git diff，base/source 都被清洗", () => {
	const target: ReviewTarget = {
		type: "mergeRequest",
		provider: "glab",
		id: 1,
		baseBranch: "main'$evil",
		sourceBranch: "feat`x",
		title: "irrelevant",
	};
	const jjHint = buildDiffPromptHint(target, "jj");
	assert.equal(jjHint.includes("jj diff"), false, "MR/PR 临时 worktree 走 git，不能提示 jj diff");
	assert.equal(jjHint.includes("git merge-base"), true);
	assert.equal(jjHint.includes("$evil"), false);
	assert.equal(jjHint.includes("'$"), false);
	const gitHint = buildDiffPromptHint(target, "git", "deadbeef';evil");
	assert.equal(gitHint.includes("';evil"), false);
	assert.equal(gitHint.includes("deadbeef"), true);
});

test("buildDiffPromptHint(mergeRequest worktree): 提示 git -C 临时 worktree 与 read 路径", () => {
	const target: ReviewTarget = {
		type: "mergeRequest",
		provider: "gh",
		id: 9,
		baseBranch: "main",
		sourceBranch: "feat",
		title: "irrelevant",
		worktreePath: "/tmp/pi-review abc/worktree",
		worktreeRef: "refs/pi-review/gh/9/x",
	};
	const hint = buildDiffPromptHint(target, "jj");
	assert.equal(hint.includes("git -C '/tmp/pi-review abc/worktree' merge-base"), true);
	assert.equal(hint.includes("/tmp/pi-review abc/worktree/ 下的对应文件"), true);
});

test("buildDiffPromptHint(uncommitted): 不含 ref，不需要清洗", () => {
	const jjHint = buildDiffPromptHint({ type: "uncommitted" }, "jj");
	assert.equal(jjHint.includes("jj status"), true);
	const gitHint = buildDiffPromptHint({ type: "uncommitted" }, "git");
	assert.equal(gitHint.includes("git status --porcelain"), true);
});

test("buildDiffPromptHint(git uncommitted): 提示包含 ls-files 与 read 未跟踪文件的要求", () => {
	const hint = buildDiffPromptHint({ type: "uncommitted" }, "git");
	assert.equal(hint.includes("git ls-files --others --exclude-standard"), true);
	assert.equal(hint.includes("`read`"), true, "需要明确要求用 read 工具查看未跟踪文件");
});

// ─── getTargetLabel ─────────────────────────────────────────────────────────

test("getTargetLabel: 各类型与 provider 区分", () => {
	assert.equal(getTargetLabel({ type: "uncommitted" }, "git"), "当前未提交改动");
	assert.equal(getTargetLabel({ type: "baseBranch", branch: "main" }, "git"), "相对 'main' 的改动");

	const gitCommit = getTargetLabel({ type: "commit", sha: "abcdef1234567890", title: "hi" }, "git");
	assert.equal(gitCommit, "commit abcdef1: hi");

	const jjCommit = getTargetLabel({ type: "commit", sha: "qprstu" }, "jj");
	assert.equal(jjCommit, "change qprstu");

	const mr = getTargetLabel(
		{ type: "mergeRequest", provider: "glab", id: 42, baseBranch: "main", sourceBranch: "feat", title: "Fix things" },
		"git",
	);
	assert.equal(mr, "MR !42: Fix things");

	const pr = getTargetLabel(
		{ type: "mergeRequest", provider: "gh", id: 9, baseBranch: "main", sourceBranch: "feat", title: "x".repeat(50) },
		"git",
	);
	assert.equal(pr.startsWith("PR #9: "), true);
	assert.equal(pr.endsWith("..."), true, "超长标题应被截断");
});

// ─── getMergeBase ───────────────────────────────────────────────────────────

test("getMergeBase(jj): 直接返回 branch（jj revset 用法）", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "should-not-be-used" }));
	const result = await getMergeBase(pi, "jj", "topic");
	assert.equal(result, "topic");
});

test("getMergeBase(git): 优先用 upstream tracking branch", async () => {
	const { pi, calls } = makeFakePi((call) => {
		if (call.args[0] === "rev-parse" && call.args.includes("--abbrev-ref")) {
			return { stdout: "origin/main\n", code: 0 };
		}
		if (call.args[0] === "merge-base" && call.args.includes("origin/main")) {
			return { stdout: "deadbeef\n", code: 0 };
		}
		return { stdout: "", code: 1 };
	});
	const result = await getMergeBase(pi, "git", "main");
	assert.equal(result, "deadbeef");
	assert.equal(calls.some((c) => c.args.includes("origin/main")), true);
});

test("getMergeBase(git): 无 upstream 时回退到本地 branch", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.args.includes("--abbrev-ref")) return { stdout: "", code: 128 };
		if (call.args[0] === "merge-base" && call.args.includes("main")) return { stdout: "abc123\n" };
		return { stdout: "" };
	});
	const result = await getMergeBase(pi, "git", "main");
	assert.equal(result, "abc123");
});

test("getMergeBase(git): 全部失败返回 null", async () => {
	const { pi } = makeFakePi(() => ({ code: 128 }));
	const result = await getMergeBase(pi, "git", "main");
	assert.equal(result, null);
});

// ─── getLocalBranches / getCurrentBranch ────────────────────────────────────

test("getLocalBranches(git): 解析 git branch 输出", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "main\nfeature\n  \nbug-fix\n" }));
	const branches = await getLocalBranches(pi, "git");
	assert.deepEqual(branches, ["main", "feature", "bug-fix"]);
});

test("getLocalBranches(jj): 用 jj bookmark 列表，去重", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "main\nfeature\nmain\n" }));
	const branches = await getLocalBranches(pi, "jj");
	assert.deepEqual(branches, ["main", "feature"]);
});

test("getCurrentBranch(jj): 永远返回 null（jj 没有 current branch 概念）", async () => {
	const { pi, calls } = makeFakePi(() => ({ stdout: "ignored" }));
	const result = await getCurrentBranch(pi, "jj");
	assert.equal(result, null);
	assert.equal(calls.length, 0);
});

test("getCurrentBranch(git): 返回 trim 后的输出", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "feat-x\n" }));
	const result = await getCurrentBranch(pi, "git");
	assert.equal(result, "feat-x");
});

// ─── getRecentCommits ───────────────────────────────────────────────────────

test("getRecentCommits(git): 解析 git log --oneline", async () => {
	const { pi, calls } = makeFakePi(() => ({
		stdout: "abc1234 fix: a\ndeadbee feat: b\n",
	}));
	const commits = await getRecentCommits(pi, "git", 5);
	assert.deepEqual(commits, [
		{ sha: "abc1234", title: "fix: a" },
		{ sha: "deadbee", title: "feat: b" },
	]);
	assert.equal(calls[0]?.args.includes("5"), true);
});

test("getRecentCommits(jj): 解析 jj log 自定义 template", async () => {
	const { pi } = makeFakePi(() => ({
		stdout: "qprstu  feat: hi\nvwxyza  chore: x\n",
	}));
	const changes = await getRecentCommits(pi, "jj");
	assert.deepEqual(changes, [
		{ sha: "qprstu", title: "feat: hi" },
		{ sha: "vwxyza", title: "chore: x" },
	]);
});

test("getRecentCommits: 命令失败返回空数组", async () => {
	const { pi } = makeFakePi(() => ({ code: 1 }));
	assert.deepEqual(await getRecentCommits(pi, "git"), []);
	assert.deepEqual(await getRecentCommits(pi, "jj"), []);
});

// ─── hasUncommittedChanges ─────────────────────────────────────────────────

test("hasUncommittedChanges: porcelain 输出非空 → true", async () => {
	const { pi } = makeFakePi(() => ({ stdout: " M file.ts\n" }));
	assert.equal(await hasUncommittedChanges(pi), true);
});

test("hasUncommittedChanges: 无输出 → false", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "" }));
	assert.equal(await hasUncommittedChanges(pi), false);
});

// ─── getSmartDefault ────────────────────────────────────────────────────────

test("getSmartDefault(jj): 永远 uncommitted", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "ignored" }));
	assert.equal(await getSmartDefault(pi, "jj"), "uncommitted");
});

test("getSmartDefault(git): 有未提交改动 → uncommitted", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.args[0] === "status") return { stdout: " M x\n" };
		return { stdout: "" };
	});
	assert.equal(await getSmartDefault(pi, "git"), "uncommitted");
});

test("getSmartDefault(git): 工作树干净，当前在非默认分支 → baseBranch", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.args[0] === "status") return { stdout: "" };
		if (call.args[0] === "branch" && call.args.includes("--show-current")) return { stdout: "feat-x\n" };
		if (call.args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
		return { stdout: "" };
	});
	assert.equal(await getSmartDefault(pi, "git"), "baseBranch");
});

test("getSmartDefault(git): 在默认分支上 → commit", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.args[0] === "status") return { stdout: "" };
		if (call.args[0] === "branch" && call.args.includes("--show-current")) return { stdout: "main\n" };
		if (call.args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
		return { stdout: "" };
	});
	assert.equal(await getSmartDefault(pi, "git"), "commit");
});
