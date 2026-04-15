import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	cleanupMrWorktree,
	createMrWorktree,
	inferMrProvider,
	parseMrReference,
	parseRemoteHost,
	prepareMrTarget,
} from "./pr.ts";
import type { ReviewTarget } from "./vcs.ts";

// ─── Fake ExtensionAPI ──────────────────────────────────────────────────────

type ExecCall = { command: string; args: string[] };
type ExecResponse = { stdout?: string; stderr?: string; code?: number };

function makeFakePi(handler: (call: ExecCall) => ExecResponse) {
	const calls: ExecCall[] = [];
	const pi = {
		async exec(command: string, args: string[]) {
			const call = { command, args };
			calls.push(call);
			const r = handler(call);
			return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
		},
	};
	return { pi: pi as unknown as Parameters<typeof prepareMrTarget>[0]["pi"], calls };
}

function makeCallbacks() {
	const info: string[] = [];
	const err: string[] = [];
	return {
		info,
		err,
		onInfo: (msg: string) => info.push(msg),
		onError: (msg: string) => err.push(msg),
	};
}

// ─── parseMrReference ───────────────────────────────────────────────────────

test("parseMrReference: 纯数字", () => {
	assert.deepEqual(parseMrReference("123"), { id: 123 });
});

test("parseMrReference: 完整 URL 一律拒绝，避免丢失 repo/project 信息", () => {
	assert.equal(parseMrReference("https://gitlab.com/group/project/-/merge_requests/42"), null);
	assert.equal(parseMrReference("https://gitlab.example.com/g/sub/p/-/merge_requests/7"), null);
	assert.equal(parseMrReference("https://github.com/owner/repo/pull/9"), null);
});

test("parseMrReference: 无效输入返回 null", () => {
	assert.equal(parseMrReference("abc"), null);
	assert.equal(parseMrReference("0"), null);
	assert.equal(parseMrReference(""), null);
});

// ─── provider inference ────────────────────────────────────────────────────

test("parseRemoteHost: 支持常见 remote URL 形式", () => {
	assert.equal(parseRemoteHost("git@github.com:org/repo.git"), "github.com");
	assert.equal(parseRemoteHost("https://gitlab.example.com/group/repo.git"), "gitlab.example.com");
	assert.equal(parseRemoteHost("ssh://git@gitlab.com/group/repo.git"), "gitlab.com");
	assert.equal(parseRemoteHost("github.com/org/repo"), "github.com");
});

test("inferMrProvider: 基于 remote host 判断，GitHub 仓库名含 gitlab 不误选 glab", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.command === "git" && call.args.join(" ") === "remote get-url origin") {
			return { stdout: "git@github.com:org/gitlab-migration.git\n" };
		}
		return { code: 1 };
	});
	assert.equal(await inferMrProvider(pi), "gh");
});

test("inferMrProvider: GitLab host 选 glab", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.command === "git" && call.args.join(" ") === "remote get-url origin") {
			return { stdout: "https://gitlab.example.com/group/repo.git\n" };
		}
		return { code: 1 };
	});
	assert.equal(await inferMrProvider(pi), "glab");
});

test("inferMrProvider: 无可识别 remote + 两个 CLI 都未安装 → null", async () => {
	const { pi } = makeFakePi(() => ({ code: 1 }));
	assert.equal(await inferMrProvider(pi), null);
});

test("prepareMrTarget: glab/gh CLI 都未安装且无 providerOverride → 明确报错", async () => {
	const { pi } = makeFakePi(() => ({ code: 1 }));
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "42", ...cb });
	assert.equal(result, null);
	assert.match(cb.err[0]!, /未检测到 glab 或 gh CLI/);
});

// ─── prepareMrTarget: 不切分支 ─────────────────────────────────────────────

test("prepareMrTarget: 成功路径只读取元数据，不调 checkout", async () => {
	const { pi, calls } = makeFakePi((call) => {
		if (call.command === "git" && call.args[0] === "status") return { stdout: "" };
		if (call.command === "glab" && call.args[0] === "mr" && call.args[1] === "view") {
			return {
				stdout: JSON.stringify({
					target_branch: "main",
					source_branch: "feat-x",
					title: "Feat X",
				}),
			};
		}
		return { code: 1 };
	});
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "42", providerOverride: "glab", ...cb });
	assert.deepEqual(result, {
		type: "mergeRequest",
		provider: "glab",
		id: 42,
		baseBranch: "main",
		sourceBranch: "feat-x",
		title: "Feat X",
	});
	// 关键：未调用 checkout
	assert.equal(calls.some((c) => c.args.includes("checkout")), false);
	assert.equal(cb.err.length, 0);
});

test("prepareMrTarget: 只读元数据，不因当前工作树有改动而拒绝", async () => {
	const { pi, calls } = makeFakePi((call) => {
		if (call.command === "glab") {
			return { stdout: JSON.stringify({ target_branch: "main", source_branch: "feat", title: "F" }) };
		}
		return { stdout: " M tracked.ts\n" };
	});
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "42", providerOverride: "glab", ...cb });
	assert.ok(result && result.type === "mergeRequest");
	assert.equal(calls.some((c) => c.command === "glab"), true);
	assert.equal(calls.some((c) => c.args.includes("checkout")), false);
});

test("prepareMrTarget: 引用无效", async () => {
	const { pi } = makeFakePi(() => ({ stdout: "" }));
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "abc", providerOverride: "glab", ...cb });
	assert.equal(result, null);
	assert.match(cb.err[0]!, /MR\/PR 引用无效/);
});

test("prepareMrTarget: glab CLI 退出非 0 → not-found", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.command === "git") return { stdout: "" };
		if (call.command === "glab") return { code: 2 };
		return { code: 0 };
	});
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "9999", providerOverride: "glab", ...cb });
	assert.equal(result, null);
	assert.match(cb.err[0]!, /找不到 MR #9999/);
});

test("prepareMrTarget: glab schema 缺字段 → throw 被边界 catch 透传", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.command === "git") return { stdout: "" };
		if (call.command === "glab") return { stdout: JSON.stringify({ title: "x" }) }; // 缺 target/source
		return {};
	});
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "42", providerOverride: "glab", ...cb });
	assert.equal(result, null);
	assert.match(cb.err[0]!, /解析 glab 输出失败/);
});

test("prepareMrTarget: gh provider 用 baseRefName/headRefName 字段", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.command === "git") return { stdout: "" };
		if (call.command === "gh") {
			return { stdout: JSON.stringify({ baseRefName: "main", headRefName: "feat", title: "F" }) };
		}
		return {};
	});
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "9", providerOverride: "gh", ...cb });
	assert.ok(result && result.type === "mergeRequest", "应返回 mergeRequest target");
	assert.equal(result.provider, "gh");
	assert.equal(result.baseBranch, "main");
	assert.equal(result.sourceBranch, "feat");
});

test("prepareMrTarget: glab snake_case 未给则 fallback 到 camelCase", async () => {
	const { pi } = makeFakePi((call) => {
		if (call.command === "git") return { stdout: "" };
		if (call.command === "glab") {
			return { stdout: JSON.stringify({ targetBranch: "main", sourceBranch: "feat", title: "F" }) };
		}
		return {};
	});
	const cb = makeCallbacks();
	const result = await prepareMrTarget({ pi, ref: "1", providerOverride: "glab", ...cb });
	assert.ok(result && result.type === "mergeRequest");
	assert.equal(result.baseBranch, "main");
	assert.equal(result.sourceBranch, "feat");
});

// ─── createMrWorktree / cleanupMrWorktree ──────────────────────────────────

const sampleMr: ReviewTarget & { type: "mergeRequest" } = {
	type: "mergeRequest",
	provider: "glab",
	id: 42,
	baseBranch: "main",
	sourceBranch: "feat-x",
	title: "Feat X",
};

test("createMrWorktree: glab MR 通过 git fetch + git worktree add 创建临时 worktree，不 checkout 当前仓库", async () => {
	const { pi, calls } = makeFakePi((call) => {
		if (call.command === "git" && call.args[0] === "fetch") return { stdout: "ok" };
		if (call.command === "git" && call.args.join(" ").startsWith("worktree add")) return { stdout: "ok" };
		return { code: 1 };
	});
	const cb = makeCallbacks();
	const worktree = await createMrWorktree({ pi, target: sampleMr, ...cb });
	assert.ok(worktree);
	const tmpDir = path.dirname(worktree.path);
	try {
		assert.match(worktree.path, /pi-review-/);
		assert.match(worktree.ref, /^refs\/pi-review\/glab\/42\//);
		assert.equal(calls.some((c) => c.command === "glab" || c.command === "gh"), false);
		assert.equal(calls.some((c) => c.args.includes("checkout")), false);
		assert.equal(calls.some((c) => c.args.includes("+refs/merge-requests/42/head:" + worktree.ref)), true);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("createMrWorktree: gh PR 使用 refs/pull/<id>/head", async () => {
	const ghTarget = { ...sampleMr, provider: "gh" as const };
	const { pi, calls } = makeFakePi((call) => {
		if (call.command === "git" && call.args[0] === "fetch") return { stdout: "ok" };
		if (call.command === "git" && call.args.join(" ").startsWith("worktree add")) return { stdout: "ok" };
		return { code: 1 };
	});
	const cb = makeCallbacks();
	const worktree = await createMrWorktree({ pi, target: ghTarget, ...cb });
	assert.ok(worktree);
	const tmpDir = path.dirname(worktree.path);
	try {
		assert.equal(calls.some((c) => c.args.some((arg) => arg.startsWith("+refs/pull/42/head:"))), true);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("createMrWorktree: fetch MR 失败则返回 null 且不 add worktree", async () => {
	const { pi, calls } = makeFakePi((call) => {
		if (call.command === "git" && call.args[0] === "fetch") return { code: 128, stderr: "missing ref" };
		return {};
	});
	const cb = makeCallbacks();
	const worktree = await createMrWorktree({ pi, target: sampleMr, ...cb });
	assert.equal(worktree, null);
	assert.match(cb.err[0]!, /missing ref/);
	assert.equal(calls.some((c) => c.args.join(" ").startsWith("worktree add")), false);
});

test("cleanupMrWorktree: 移除 worktree 并删除临时 ref", async () => {
	const { pi, calls } = makeFakePi(() => ({ stdout: "ok" }));
	const errors = await cleanupMrWorktree(pi, { path: "/tmp/pi-review-x/worktree", ref: "refs/pi-review/gh/1/x" });
	assert.deepEqual(errors, []);
	assert.equal(calls.some((c) => c.args.join(" ") === "worktree remove --force /tmp/pi-review-x/worktree"), true);
	assert.equal(calls.some((c) => c.args.join(" ") === "update-ref -d refs/pi-review/gh/1/x"), true);
});
