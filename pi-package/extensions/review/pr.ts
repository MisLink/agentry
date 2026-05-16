/**
 * MR / PR 审查支持。
 *
 * 服务商优先级：
 * 1. 显式子命令（`/review mr` → glab；`/review pr` → gh）
 * 2. 远端 host 推断（`github.com` → gh；host 含 gitlab → glab）
 * 3. CLI 兜底（PATH 上有 glab 用 glab，否则 gh）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewTarget } from "./vcs.ts";

export type MrProvider = "glab" | "gh";

export type MrInfo = {
	provider: MrProvider;
	id: number;
	baseBranch: string;
	sourceBranch: string;
	title: string;
};

async function getRemoteUrl(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["remote", "get-url", "origin"]);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function isCliAvailable(pi: ExtensionAPI, bin: "glab" | "gh"): Promise<boolean> {
	const { code } = await pi.exec(bin, ["--version"]);
	return code === 0;
}

export function parseRemoteHost(remoteUrl: string): string | null {
	const trimmed = remoteUrl.trim();
	if (!trimmed) return null;

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		try {
			return new URL(trimmed).hostname.toLowerCase() || null;
		} catch {
			return null;
		}
	}

	// scp-like SSH remote: git@github.com:owner/repo.git
	const scpLike = trimmed.match(/^(?:[^@\s]+@)?([^:\s]+):.+$/);
	if (scpLike?.[1]) return scpLike[1].toLowerCase();

	// host/path form: github.com/owner/repo
	const hostPath = trimmed.match(/^([^/\s]+)\/.+$/);
	if (hostPath?.[1]) return hostPath[1].toLowerCase();

	return null;
}

export async function inferMrProvider(pi: ExtensionAPI): Promise<MrProvider | null> {
	const url = await getRemoteUrl(pi);
	const host = url ? parseRemoteHost(url) : null;
	if (host) {
		if (host === "github.com") return "gh";
		if (/(^|\.)gitlab/i.test(host)) return "glab";
	}
	if (await isCliAvailable(pi, "glab")) return "glab";
	if (await isCliAvailable(pi, "gh")) return "gh";
	return null;
}

/**
 * 解析 MR / PR 引用。只接受当前仓库中的纯数字编号。
 *
 * 不接受完整 URL：URL 可能指向其它仓库；如果丢弃 repo/project 信息后只拿
 * 编号，会误审当前仓库中相同编号的 MR/PR。
 */
export function parseMrReference(ref: string): { id: number } | null {
	const trimmed = ref.trim();
	const num = parseInt(trimmed, 10);
	if (!isNaN(num) && num > 0 && /^\d+$/.test(trimmed)) {
		return { id: num };
	}
	return null;
}

/**
 * 抓取返回值语义：
 *   - { ok: true, info }　CLI 返回成功且字段完整
 *   - { ok: false, kind: "not-found" }　CLI 退出非 0（MR 不存在 / 未认证 / 未安装）
 *
 * 字段解析失败不放到返回值表达 —— 直接 throw 交给边界处理层，
 * 由 prepareMrTarget 用 onError 把原因透传给用户。
 */
export type FetchMrResult = { ok: true; info: MrInfo } | { ok: false; kind: "not-found" };

function pickString(data: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value) return value;
	}
	return null;
}

async function fetchMrInfoGlab(pi: ExtensionAPI, id: number): Promise<FetchMrResult> {
	// `glab mr view <id> -F json` 把 JSON 打印到 stdout。glab >=1.x 用 snake_case
	// 字段名（`target_branch` / `source_branch`）；部分版本可能输出 camelCase，
	// 为保险同时回退尝试。
	const { stdout, code } = await pi.exec("glab", ["mr", "view", String(id), "-F", "json"]);
	if (code !== 0) return { ok: false, kind: "not-found" };
	const data = JSON.parse(stdout) as Record<string, unknown>;
	const baseBranch = pickString(data, "target_branch", "targetBranch");
	const sourceBranch = pickString(data, "source_branch", "sourceBranch");
	const title = pickString(data, "title") ?? "";
	if (!baseBranch || !sourceBranch) {
		throw new Error(`glab MR JSON 缺少 target_branch/source_branch 字段：${stdout.slice(0, 200)}`);
	}
	return { ok: true, info: { provider: "glab", id, baseBranch, sourceBranch, title } };
}

async function fetchMrInfoGh(pi: ExtensionAPI, id: number): Promise<FetchMrResult> {
	const { stdout, code } = await pi.exec("gh", [
		"pr", "view", String(id), "--json", "baseRefName,title,headRefName",
	]);
	if (code !== 0) return { ok: false, kind: "not-found" };
	const data = JSON.parse(stdout) as Record<string, unknown>;
	const baseBranch = pickString(data, "baseRefName");
	const sourceBranch = pickString(data, "headRefName");
	const title = pickString(data, "title") ?? "";
	if (!baseBranch || !sourceBranch) {
		throw new Error(`gh PR JSON 缺少 baseRefName/headRefName 字段：${stdout.slice(0, 200)}`);
	}
	return { ok: true, info: { provider: "gh", id, baseBranch, sourceBranch, title } };
}

export async function fetchMrInfo(
	pi: ExtensionAPI,
	provider: MrProvider,
	id: number,
): Promise<FetchMrResult> {
	return provider === "glab" ? fetchMrInfoGlab(pi, id) : fetchMrInfoGh(pi, id);
}

export type ReviewWorktree = {
	path: string;
	ref: string;
};

function worktreeRemoteRef(provider: MrProvider, id: number): string {
	return provider === "gh" ? `refs/pull/${id}/head` : `refs/merge-requests/${id}/head`;
}

function worktreeLocalRef(provider: MrProvider, id: number): string {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	return `refs/pi-review/${provider}/${id}/${suffix}`;
}

function execError(command: string, args: string[], stdout: string, stderr: string, code: number): string {
	return `${command} ${args.join(" ")} 失败（exit ${code}）：${stderr.trim() || stdout.trim() || "无输出"}`;
}

export type CreateMrWorktreeOptions = {
	pi: ExtensionAPI;
	target: ReviewTarget & { type: "mergeRequest" };
	onInfo: (msg: string) => void;
	onError: (msg: string) => void;
};

/**
 * 为 MR/PR 创建临时 git worktree。不会切换当前仓库分支。
 */
export async function createMrWorktree(opts: CreateMrWorktreeOptions): Promise<ReviewWorktree | null> {
	const { pi, target } = opts;
	const kind = target.provider === "glab" ? "MR" : "PR";
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-review-"));
	const worktreePath = path.join(tempRoot, "worktree");
	const localRef = worktreeLocalRef(target.provider, target.id);
	const remoteRef = worktreeRemoteRef(target.provider, target.id);

	opts.onInfo(`正在为 ${kind} #${target.id} 创建临时 worktree...`);

	let fetchedLocalRef = false;
	let addedWorktree = false;
	let success = false;
	try {
		const fetchMrArgs = ["fetch", "origin", `+${remoteRef}:${localRef}`];
		const fetchMr = await pi.exec("git", fetchMrArgs);
		if (fetchMr.code !== 0) {
			opts.onError(execError("git", fetchMrArgs, fetchMr.stdout, fetchMr.stderr, fetchMr.code));
			return null;
		}
		fetchedLocalRef = true;

		const fetchBaseArgs = ["fetch", "origin", `+refs/heads/${target.baseBranch}:refs/remotes/origin/${target.baseBranch}`];
		const fetchBase = await pi.exec("git", fetchBaseArgs);
		if (fetchBase.code !== 0) {
			opts.onError(execError("git", fetchBaseArgs, fetchBase.stdout, fetchBase.stderr, fetchBase.code));
			return null;
		}

		const addArgs = ["worktree", "add", "--detach", worktreePath, localRef];
		const add = await pi.exec("git", addArgs);
		if (add.code !== 0) {
			opts.onError(execError("git", addArgs, add.stdout, add.stderr, add.code));
			return null;
		}
		addedWorktree = true;

		success = true;
		opts.onInfo(`已创建 ${kind} #${target.id} 临时 worktree：${worktreePath}`);
		return { path: worktreePath, ref: localRef };
	} finally {
		if (!success) {
			if (addedWorktree) {
				await pi.exec("git", ["worktree", "remove", "--force", worktreePath]);
			}
			if (fetchedLocalRef) {
				await pi.exec("git", ["update-ref", "-d", localRef]);
			}
			await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export async function cleanupMrWorktree(pi: ExtensionAPI, worktree: ReviewWorktree): Promise<string[]> {
	const errors: string[] = [];
	const removeArgs = ["worktree", "remove", "--force", worktree.path];
	const remove = await pi.exec("git", removeArgs);
	if (remove.code !== 0) {
		errors.push(execError("git", removeArgs, remove.stdout, remove.stderr, remove.code));
	}
	await fs.rm(path.dirname(worktree.path), { recursive: true, force: true }).catch(() => undefined);
	const deleteRefArgs = ["update-ref", "-d", worktree.ref];
	const deleteRef = await pi.exec("git", deleteRefArgs);
	if (deleteRef.code !== 0) {
		errors.push(execError("git", deleteRefArgs, deleteRef.stdout, deleteRef.stderr, deleteRef.code));
	}
	return errors;
}

export type ResolveMrTargetOptions = {
	pi: ExtensionAPI;
	ref: string;
	providerOverride?: MrProvider;
	onInfo: (msg: string) => void;
	onError: (msg: string) => void;
};

/**
 * 准备 MR 审查目标：只读。解析引用 → 推断服务商 → 抓取 MR 元数据。
 * **不切分支**。调用者在用户确认后再调用 `createMrWorktree`。
 *
 * 拆分原因：避免用户在 `/review pr 123` 后取消模型选择时，已经创建
 * 临时 worktree。
 */
export async function prepareMrTarget(opts: ResolveMrTargetOptions): Promise<ReviewTarget | null> {
	const parsed = parseMrReference(opts.ref);
	if (!parsed) {
		opts.onError("MR/PR 引用无效。请只输入当前仓库中的数字编号，不支持完整 URL。");
		return null;
	}

	const resolvedProvider = opts.providerOverride ?? (await inferMrProvider(opts.pi));
	if (!resolvedProvider) {
		opts.onError("未检测到 glab 或 gh CLI。请先运行 \`glab auth login\` 或 \`gh auth login\`。");
		return null;
	}
	const provider: MrProvider = resolvedProvider;

	const kind = provider === "glab" ? "MR" : "PR";
	opts.onInfo(`正在获取 ${kind} #${parsed.id} 信息...`);
	// 边界 catch：JSON 解析 / 字段不匹配由 fetch* 抛错，这里透传原因。
	let fetchResult: FetchMrResult;
	try {
		fetchResult = await fetchMrInfo(opts.pi, provider, parsed.id);
	} catch (error) {
		opts.onError(`解析 ${provider} 输出失败：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	if (!fetchResult.ok) {
		opts.onError(`找不到 ${kind} #${parsed.id}，确认 ${provider} 已认证且 ${kind} 存在。`);
		return null;
	}
	const info = fetchResult.info;
	opts.onInfo(`${kind} #${info.id}：${info.sourceBranch} → ${info.baseBranch}`);

	return {
		type: "mergeRequest",
		provider: info.provider,
		id: info.id,
		baseBranch: info.baseBranch,
		sourceBranch: info.sourceBranch,
		title: info.title,
	};
}

