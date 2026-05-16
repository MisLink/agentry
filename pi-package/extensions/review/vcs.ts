/**
 * 审查扩展用的 VCS 适配层：把 git / jj 操作统一在一组函数下，避免命令拼装
 * 处到处都是 vcs × target 的 switch。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeRefName, sanitizePromptInput } from "./sanitize.ts";

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type ReviewVcs = "git" | "jj";

export type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| {
		type: "mergeRequest";
		provider: "glab" | "gh";
		id: number;
		baseBranch: string;
		sourceBranch: string;
		title: string;
		worktreePath?: string;
		worktreeRef?: string;
	}
	| { type: "files"; paths: string[] };

export type SmartDefault = "uncommitted" | "baseBranch" | "commit";

export async function detectVCS(pi: ExtensionAPI): Promise<ReviewVcs> {
	const { code } = await pi.exec("jj", ["--ignore-working-copy", "root"]);
	return code === 0 ? "jj" : "git";
}

// ─── git 辅助 ────────────────────────────────────────────────────────────────

async function gitMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
		"rev-parse", "--abbrev-ref", `${branch}@{upstream}`,
	]);
	if (upstreamCode === 0 && upstream.trim()) {
		const { stdout, code } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()]);
		if (code === 0 && stdout.trim()) return stdout.trim();
	}
	const { stdout, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function gitLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout.trim().split("\n").filter((branch) => branch.trim());
}

async function gitCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function gitDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) return stdout.trim().replace(/^origin\//, "");
	const branches = await gitLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";
	return "main";
}

async function gitRecentCommits(pi: ExtensionAPI, limit: number): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", "--oneline", "-n", `${limit}`]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split(" ");
			return { sha: sha ?? "", title: rest.join(" ") };
		});
}

export async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

// ─── jj 辅助 ─────────────────────────────────────────────────────────────────

async function jjBookmarks(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "bookmark", "list", "--template", 'name ++ "\\n"',
	]);
	if (code !== 0) return [];
	return [...new Set(stdout.trim().split("\n").filter((b) => b.trim()))];
}

export async function jjCurrentBookmarks(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "bookmark", "list", "-r", "@", "--template", 'name ++ "\\n"',
	]);
	if (code !== 0) return [];
	return [...new Set(stdout.trim().split("\n").filter((b) => b.trim()))];
}

async function jjRecentChanges(pi: ExtensionAPI, limit: number): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "log", "--no-graph", "-n", `${limit}`,
		"--template", 'change_id.shortest() ++ "  " ++ description.first_line() ++ "\\n"',
	]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split("  ");
			return { sha: sha ?? "", title: rest.join("  ").trim() };
		});
}

// ─── 统一 API ────────────────────────────────────────────────────────────────

export async function getMergeBase(pi: ExtensionAPI, vcs: ReviewVcs, branch: string): Promise<string | null> {
	if (vcs === "jj") return branch; // jj 直接用 revset 引用
	return gitMergeBase(pi, branch);
}

export async function getLocalBranches(pi: ExtensionAPI, vcs: ReviewVcs): Promise<string[]> {
	return vcs === "jj" ? jjBookmarks(pi) : gitLocalBranches(pi);
}

export async function getCurrentBranch(pi: ExtensionAPI, vcs: ReviewVcs): Promise<string | null> {
	return vcs === "jj" ? null : gitCurrentBranch(pi);
}

export async function getRecentCommits(
	pi: ExtensionAPI,
	vcs: ReviewVcs,
	limit = 15,
): Promise<Array<{ sha: string; title: string }>> {
	return vcs === "jj" ? jjRecentChanges(pi, limit) : gitRecentCommits(pi, limit);
}

/**
 * 根据 git 工作树状态给审查预设选择器一个智能默认值。仅对 git 有意义；
 * jj 用户永远拿到 "uncommitted"，因为 jj 没有 git 那种"功能分支"概念。
 */
export async function getSmartDefault(pi: ExtensionAPI, vcs: ReviewVcs): Promise<SmartDefault> {
	if (vcs === "jj") return "uncommitted";
	if (await hasUncommittedChanges(pi)) return "uncommitted";
	const [current, def] = await Promise.all([gitCurrentBranch(pi), gitDefaultBranch(pi)]);
	if (current && current !== def) return "baseBranch";
	return "commit";
}

/**
 * 产出针对当前目标的提示文案：告诉审查模型该跑哪些命令查 diff。
 * 模型会用自带的 bash / read 工具去跑，所以只是提示文本。
 *
 * 重要：所有会拼进 shell 命令片段的 ref 名称（分支 / bookmark / SHA）
 * 都要走 sanitizeRefName 清洗，防止 单引号 / 反引号 / `;` / `$` 等 shell
 * 元字符打破引号块。
 */
export function buildDiffPromptHint(target: ReviewTarget, vcs: ReviewVcs, mergeBase?: string | null): string {
	const safeMergeBase = mergeBase ? sanitizeRefName(mergeBase) : null;
	// MR/PR 通过 git fetch + 临时 worktree 准备，因此即便仓库同时使用 jj，
	// 差异提示也必须走 git 命令，避免 `jj diff` 指向错误 revset。
	const diffVcs: ReviewVcs = target.type === "mergeRequest" ? "git" : vcs;
	if (diffVcs === "jj") {
		switch (target.type) {
			case "uncommitted":
				return "运行 `jj status` 与 `jj diff` 查看未提交改动。";
			case "baseBranch": {
				const safeBranch = sanitizeRefName(target.branch);
				const revset = `heads(::@ & ::${safeBranch})`;
				return `运行 \`jj log -r '${revset}' --no-graph\` 确认共同祖先，再 \`jj diff --from '${revset}' --to @\` 查看差异。`;
			}
			case "commit": {
				const safeSha = sanitizeRefName(target.sha);
				return `运行 \`jj --ignore-working-copy diff -r ${safeSha}\` 查看该变更内容。`;
			}
			// mergeRequest case 不会到达：diffVcs 在 target.type === "mergeRequest" 时
			// 已强制为 "git"（见上方）。TypeScript 需要穷举处理则留着它。
			case "mergeRequest":
				throw new Error(`buildDiffPromptHint: 不应到达的 jj + mergeRequest 路径`);
			// files 不依赖 VCS，在 git 分支处理。
			case "files":
				break;
		}
	}
	switch (target.type) {
		case "uncommitted":
			return [
				"运行 `git status --porcelain` 查看所有变动文件，运行 `git diff` 与 `git diff --staged` 查看已跟踪文件的未暂存 / 已暂存改动。",
				"另外运行 `git ls-files --others --exclude-standard` 列出未跟踪的新文件；diff 不包含这些文件内容，需要用 `read` 工具逐个查看并纳入审查。",
			].join(" ");
		case "baseBranch": {
			const safeBranch = sanitizeRefName(target.branch);
			return safeMergeBase
				? `合并基础提交是 ${safeMergeBase}。运行 \`git diff ${safeMergeBase}\` 查看从 '${safeBranch}' 分支分叉以来的差异。`
				: `先运行 \`git merge-base HEAD ${safeBranch}\` 找出合并基础，再运行 \`git diff <合并基础>\` 查看差异。`;
		}
		case "commit": {
			const safeSha = sanitizeRefName(target.sha);
			return `运行 \`git show ${safeSha}\` 查看该提交内容。`;
		}
		case "mergeRequest": {
			const safeBase = sanitizeRefName(target.baseBranch);
			const safeSource = sanitizeRefName(target.sourceBranch);
			const worktree = target.worktreePath ? quoteShellArg(target.worktreePath) : null;
			const git = worktree ? `git -C ${worktree}` : "git";
			const readHint = worktree
				? `需要查看完整文件时，用 \`read\` 工具读取 ${target.worktreePath}/ 下的对应文件。`
				: "需要查看完整文件时，用 `read` 工具读取当前工作区里的对应文件。";
			const location = worktree
				? `MR/PR 已在临时 worktree 中准备好（源分支 '${safeSource}'）`
				: `当前工作区已切到源分支 '${safeSource}'`;
			return safeMergeBase
				? `${location}。合并基础是 ${safeMergeBase}，运行 \`${git} diff ${safeMergeBase}\` 查看 MR 差异。${readHint}`
				: `${location}。先运行 \`${git} merge-base HEAD origin/${safeBase}\` 找出合并基础，再运行 \`${git} diff <合并基础>\` 查看 MR 差异。${readHint}`;
		}
		case "files": {
			const fileList = target.paths.map((p) => `- ${JSON.stringify(sanitizePromptInput(p))}`).join("\n");
			return [
				`使用 \`read\` 工具逐个读取以下文件进行审查：`,
				fileList,
				"如果路径是目录，先用 `ls` 工具列出目录内容，再逐个读取其中的代码文件。",
			].join("\n");
		}
	}
}

/**
 * 目标的可读标签，用于状态栏文案和通知。
 */
export function getTargetLabel(target: ReviewTarget, vcs: ReviewVcs): string {
	switch (target.type) {
		case "uncommitted":
			return "当前未提交改动";
		case "baseBranch":
			return `相对 '${target.branch}' 的改动`;
		case "commit": {
			const short = target.sha.slice(0, 7);
			const prefix = vcs === "jj" ? "change" : "commit";
			return target.title ? `${prefix} ${short}: ${target.title}` : `${prefix} ${short}`;
		}
		case "mergeRequest": {
			const kind = target.provider === "glab" ? "MR" : "PR";
			const symbol = target.provider === "glab" ? "!" : "#";
			const truncated = target.title.length > 40 ? `${target.title.slice(0, 37)}...` : target.title;
			return `${kind} ${symbol}${target.id}: ${truncated}`;
		}
		case "files": {
			if (target.paths.length === 1) return `文件 ${target.paths[0]}`;
			return `${target.paths.length} 个文件`;
		}
	}
}
