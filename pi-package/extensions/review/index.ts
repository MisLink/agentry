/**
 * Review Extension
 *
 * 为代码改动提供 AI 驱动的只读代码审查。
 *
 * 特性：
 * - 在当前 session 内运行 review，不创建后台 job
 * - 支持 git 和 jj (Jujutsu) 版本控制
 * - 支持审查未提交改动、分支 diff、特定 commit
 * - 按风险分层、文件类型和项目规则构建高信号 review prompt
 * - 提供只读 review_context 工具，按需读取 diff、文件、hunk 和摘录
 *
 * 用法：
 *   /review               — 交互式选择审查目标
 *   /review uncommitted   — 审查未提交改动
 *   /review branch <name> — 审查相对某分支/bookmark 的 diff
 *   /review commit <rev>  — 审查某个 commit/change
 *   /review status        — 查看当前 review 状态
 *   /review off           — 结束 review 并返回主 session
 *
 * 项目级审查规范：在 .pi 目录所在的项目根放 REVIEW_GUIDELINES.md，
 * 内容会自动追加到 rubric 末尾。
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { notifyBeforePrompt } from "../notify/index.js";
import {
	assessReviewPlan,
	buildReviewStrategyPrompt,
	sanitizePromptInput,
	type ReviewEntry,
} from "./strategy.js";
import {
	buildReviewCollectionPlan,
	mergeReviewEntries,
	parseReviewCollectionOutput,
} from "./diff.js";
import {
	buildReviewContext,
	createReviewContextTool,
	type ReviewContext,
} from "./review-context.js";
import { REVIEW_RUBRIC } from "./rubric.js";
import {
	applyFindingFeedback,
	buildReviewTargetKey,
	buildRereviewPromptSection,
	compactReviewSummary,
	extractReviewFindings,
	findPreviousReviewMemory,
	mergeReviewMemory,
	type ReviewMemory,
} from "./history.js";
import { buildReviewLanguageInstructionFromUserTexts } from "./language.js";
import { selectModelForExtension } from "../../lib/model-selector.js";
import { extractLastAssistantText, extractLastUserText } from "./session-result.js";
import { buildReviewWidgetLine } from "./status.js";
import { claimReviewWidgetRuntime } from "./widget-runtime.js";

// ─── VCS Detection ───────────────────────────────────────────────────────────

async function detectVCS(pi: ExtensionAPI): Promise<"git" | "jj"> {
	const { code: jjCode } = await pi.exec("jj", ["--ignore-working-copy", "root"]);
	if (jjCode === 0) return "jj";
	return "git";
}

// ─── State ───────────────────────────────────────────────────────────────────

let reviewOriginId: string | undefined = undefined;
let preReviewModelRef: string | undefined = undefined;
let reviewTargetLabel: string | undefined = undefined;
let reviewStartedAtMs: number | undefined = undefined;
let reviewCompletedTotalMs: number | undefined = undefined;
let currentReviewTargetKey: string | undefined = undefined;
let currentReviewContext: ReviewContext | undefined = undefined;
let latestReviewCommandCtx: ExtensionCommandContext | undefined = undefined;

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_RESULT_TYPE = "review-result";
const REVIEW_CONTEXT_TOOL_NAME = "review_context";
const REVIEW_COMMAND_DESCRIPTION =
	"审查代码改动。用法：/review [uncommitted | branch <name> | commit <rev> | status | off]";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
	targetLabel?: string;
	startedAtMs?: number;
	completedTotalMs?: number;
	targetKey?: string;
};

type ReviewResultState = ReviewMemory & {
	targetLabel?: string;
};

type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

// ─── Git helpers ─────────────────────────────────────────────────────────────

async function gitMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
		const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
			"rev-parse", "--abbrev-ref", `${branch}@{upstream}`,
		]);
		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()]);
			if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		}
		const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
		if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		return null;
	} catch {
		return null;
	}
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

async function gitRecentCommits(
	pi: ExtensionAPI,
	limit = 15,
): Promise<Array<{ sha: string; title: string }>> {
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

// ─── JJ helpers ──────────────────────────────────────────────────────────────

async function jjCurrentBookmarks(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "bookmark", "list", "-r", "@", "--template", 'name ++ "\\n"',
	]);
	if (code !== 0) return [];
	return [...new Set(stdout.trim().split("\n").filter((bookmark) => bookmark.trim()))];
}

async function jjBookmarks(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "bookmark", "list", "--template", 'name ++ "\\n"',
	]);
	if (code !== 0) return [];
	return [...new Set(stdout.trim().split("\n").filter((bookmark) => bookmark.trim()))];
}

async function jjRecentChanges(
	pi: ExtensionAPI,
	limit = 15,
): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "log", "--no-graph", "-n", `${limit}`,
		"--template",
		`change_id.shortest() ++ "  " ++ description.first_line() ++ "\\n"`,
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

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	const vcs = await detectVCS(pi);
	if (vcs === "jj") return branch;
	return gitMergeBase(pi, branch);
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const vcs = await detectVCS(pi);
	if (vcs === "jj") return jjBookmarks(pi);
	return gitLocalBranches(pi);
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const vcs = await detectVCS(pi);
	if (vcs === "jj") return null;
	return gitCurrentBranch(pi);
}

async function getRecentCommits(
	pi: ExtensionAPI,
	limit = 15,
): Promise<Array<{ sha: string; title: string }>> {
	const vcs = await detectVCS(pi);
	if (vcs === "jj") return jjRecentChanges(pi, limit);
	return gitRecentCommits(pi, limit);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function extractUserTextsFromEntries(entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }>): string[] {
	return entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map((entry) => extractLastUserText([entry.message!]))
		.filter((text): text is string => Boolean(text));
}

function getPreviousReviewMemory(entries: Array<{ type?: string; customType?: string; data?: unknown }>, targetKey: string): ReviewMemory | null {
	const memories = entries
		.filter((entry) => entry.type === "custom" && entry.customType === REVIEW_RESULT_TYPE)
		.map((entry) => entry.data as ReviewResultState);
	return findPreviousReviewMemory(memories, targetKey);
}

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);
	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (!guidelineStats?.isFile()) return null;
			const content = await fs.readFile(guidelinesPath, "utf8");
			return content.trim() || null;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

async function buildReviewRubricText(cwd: string): Promise<string> {
	const guidelines = await loadProjectReviewGuidelines(cwd);
	const rubricSections = [
		REVIEW_RUBRIC,
		guidelines ? `## Project-Specific Review Guidelines\n\n${sanitizePromptInput(guidelines)}` : "",
	].filter((section) => section);
	return rubricSections.join("\n\n---\n\n");
}

async function collectReviewEntries(pi: ExtensionAPI, target: ReviewTarget, vcs: "git" | "jj"): Promise<ReviewEntry[]> {
	const mergeBase = target.type === "baseBranch" && vcs === "git"
		? await getMergeBase(pi, target.branch)
		: undefined;
	const plan = buildReviewCollectionPlan({ vcs, target, mergeBase });
	const outputs = await Promise.all(plan.commands.map((command) => pi.exec(vcs, command.args)));
	return mergeReviewEntries(outputs.flatMap((output, index) => {
		if (output.code !== 0) return [];
		const command = plan.commands[index];
		if (!command) return [];
		return parseReviewCollectionOutput(command, output.stdout);
	}));
}

const MAX_REVIEW_SNAPSHOT_CHARS = 40_000;
const MAX_REVIEW_FILE_CHARS = 20_000;
const MAX_REVIEW_FILE_DIFF_CHARS = 20_000;

function withReviewContextToolParameters<T extends ReturnType<typeof createReviewContextTool>>(tool: T) {
	return {
		...tool,
		parameters: Type.Object({
			kind: Type.Union([
				Type.Literal("diff"),
				Type.Literal("file"),
				Type.Literal("list-files"),
				Type.Literal("file-diff"),
				Type.Literal("file-meta"),
				Type.Literal("file-excerpt"),
				Type.Literal("search"),
				Type.Literal("list-hunks"),
				Type.Literal("hunk-excerpt"),
			]),
			path: Type.Optional(Type.String({ description: "Changed file path when querying file, file-diff, file-meta, file-excerpt, list-hunks, or hunk-excerpt" })),
			startLine: Type.Optional(Type.Number({ description: "1-based start line for file-excerpt" })),
			endLine: Type.Optional(Type.Number({ description: "1-based end line for file-excerpt" })),
			query: Type.Optional(Type.String({ description: "Search query for search mode" })),
			maxResults: Type.Optional(Type.Number({ description: "Maximum number of search matches to return" })),
			hunkId: Type.Optional(Type.String({ description: "Hunk ID for hunk-excerpt" })),
		}),
	};
}

function makeReviewContextCustomTool(contextProvider: () => ReviewContext | undefined) {
	return withReviewContextToolParameters(createReviewContextTool(contextProvider, {
		name: REVIEW_CONTEXT_TOOL_NAME,
		label: "Review Context",
		description: "Read-only shared review context for the active /review session.",
		promptSnippet: "Use review_context to inspect the active review's shared diff snapshot, changed files, per-file diffs, hunks, metadata, and excerpts on demand.",
		promptGuidelines: [
			"When a /review session is active, prefer review_context over requesting or duplicating the full diff in prompts.",
			"Start with review_context({ kind: 'list-files' }) or review_context({ kind: 'diff' }), then fetch file-diff, list-hunks, hunk-excerpt, file-meta, search, or file-excerpt for targeted inspection.",
			"review_context is read-only. Do not use it for edits.",
		],
	}));
}

function makeVisibleReviewContextTool() {
	return makeReviewContextCustomTool(() => currentReviewContext);
}

function clipReviewSnapshot(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_REVIEW_SNAPSHOT_CHARS) return normalized;
	return `${normalized.slice(0, MAX_REVIEW_SNAPSHOT_CHARS)}\n\n[truncated review snapshot]`;
}

function clipReviewFileContent(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_REVIEW_FILE_CHARS) return normalized;
	return `${normalized.slice(0, MAX_REVIEW_FILE_CHARS)}\n\n[truncated review file]`;
}

function clipReviewFileDiff(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_REVIEW_FILE_DIFF_CHARS) return normalized;
	return `${normalized.slice(0, MAX_REVIEW_FILE_DIFF_CHARS)}\n\n[truncated review diff]`;
}

function formatReviewSnapshotSection(command: string, output: { code: number; stdout: string; stderr: string }): string {
	const body = output.stdout.trim() || output.stderr.trim() || "(empty)";
	return `### \`${command}\`\n(exit ${output.code})\n${body}`;
}

async function collectReviewSnapshot(
	pi: ExtensionAPI,
	target: ReviewTarget,
	vcs: "git" | "jj",
): Promise<string> {
	const commands: Array<{ binary: "git" | "jj"; args: string[] }> = [];
	if (vcs === "jj") {
		switch (target.type) {
			case "uncommitted":
				commands.push(
					{ binary: "jj", args: ["status"] },
					{ binary: "jj", args: ["diff"] },
				);
				break;
			case "baseBranch": {
				const mergeBaseRevset = `heads(::@ & ::${target.branch})`;
				commands.push(
					{ binary: "jj", args: ["log", "-r", mergeBaseRevset, "--no-graph"] },
					{ binary: "jj", args: ["diff", "--from", mergeBaseRevset, "--to", "@"] },
				);
				break;
			}
			case "commit":
				commands.push({ binary: "jj", args: ["--ignore-working-copy", "diff", "-r", target.sha] });
				break;
		}
	} else {
		switch (target.type) {
			case "uncommitted":
				commands.push(
					{ binary: "git", args: ["status", "--porcelain"] },
					{ binary: "git", args: ["diff"] },
					{ binary: "git", args: ["diff", "--staged"] },
				);
				break;
			case "baseBranch": {
				const mergeBase = await getMergeBase(pi, target.branch);
				commands.push({ binary: "git", args: ["diff", mergeBase ?? `${target.branch}...HEAD`] });
				break;
			}
			case "commit":
				commands.push({ binary: "git", args: ["show", target.sha] });
				break;
		}
	}
	const outputs = await Promise.all(commands.map((command) => pi.exec(command.binary, command.args)));
	const sections = outputs.map((output, index) => {
		const command = commands[index];
		if (!command) return "";
		return formatReviewSnapshotSection(`${command.binary} ${command.args.join(" ")}`, output);
	}).filter(Boolean);
	return clipReviewSnapshot(sections.join("\n\n"));
}

async function collectReviewFileArtifacts(
	ctx: ExtensionContext,
	plan: ReturnType<typeof assessReviewPlan>,
): Promise<{
	files: Array<{ path: string; content: string }>;
	fileMetadata: Array<{ path: string; state: "available" | "deleted" | "binary" | "unreadable"; lineCount?: number; reason?: string }>;
}> {
	const results = await Promise.all(plan.includedEntries.map(async (entry) => {
		const absolutePath = path.join(ctx.cwd, entry.path);
		try {
			const buffer = await fs.readFile(absolutePath);
			if (buffer.includes(0)) return { path: entry.path, state: "binary" as const };
			const content = buffer.toString("utf8");
			return {
				path: entry.path,
				state: "available" as const,
				content: clipReviewFileContent(content),
				lineCount: content.split(/\r?\n/).length,
			};
		} catch (error) {
			const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
			if (code === "ENOENT") return { path: entry.path, state: "deleted" as const };
			return {
				path: entry.path,
				state: "unreadable" as const,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}));
	return {
		files: results
			.filter((item): item is { path: string; state: "available"; content: string; lineCount: number } => item.state === "available")
			.map((item) => ({ path: item.path, content: item.content })),
		fileMetadata: results.map((item) => ({
			path: item.path,
			state: item.state,
			...(item.state === "available" && "lineCount" in item ? { lineCount: item.lineCount } : {}),
			...(item.state === "unreadable" && "reason" in item ? { reason: item.reason } : {}),
		})),
	};
}

async function collectReviewFileDiffs(
	pi: ExtensionAPI,
	target: ReviewTarget,
	vcs: "git" | "jj",
	plan: ReturnType<typeof assessReviewPlan>,
): Promise<Array<{ path: string; diff: string }>> {
	const gitMergeBase = vcs === "git" && target.type === "baseBranch"
		? await getMergeBase(pi, target.branch)
		: null;
	const jjMergeBaseRevset = vcs === "jj" && target.type === "baseBranch"
		? `heads(::@ & ::${target.branch})`
		: null;
	const results = await Promise.all(plan.includedEntries.map(async (entry) => {
		const commands: Array<{ binary: "git" | "jj"; args: string[] }> = [];
		if (vcs === "jj") {
			switch (target.type) {
				case "uncommitted":
					commands.push({ binary: "jj", args: ["diff", "--git", "--", entry.path] });
					break;
				case "baseBranch":
					commands.push({ binary: "jj", args: ["diff", "--git", "--from", jjMergeBaseRevset ?? target.branch, "--to", "@", "--", entry.path] });
					break;
				case "commit":
					commands.push({ binary: "jj", args: ["--ignore-working-copy", "diff", "--git", "-r", target.sha, "--", entry.path] });
					break;
			}
		} else {
			switch (target.type) {
				case "uncommitted":
					commands.push(
						{ binary: "git", args: ["diff", "--", entry.path] },
						{ binary: "git", args: ["diff", "--staged", "--", entry.path] },
					);
					break;
				case "baseBranch":
					commands.push({ binary: "git", args: ["diff", gitMergeBase ?? `${target.branch}...HEAD`, "--", entry.path] });
					break;
				case "commit":
					commands.push({ binary: "git", args: ["show", target.sha, "--", entry.path] });
					break;
			}
		}
		const outputs = await Promise.all(commands.map((command) => pi.exec(command.binary, command.args)));
		const diff = outputs
			.map((output) => (output.code === 0 ? (output.stdout.trim() || output.stderr.trim()) : ""))
			.filter((text) => text)
			.join("\n\n");
		if (!diff) return null;
		return { path: entry.path, diff: clipReviewFileDiff(diff) };
	}));
	return results.filter((item): item is { path: string; diff: string } => Boolean(item));
}

async function buildSharedReviewContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: ReviewTarget,
	vcs: "git" | "jj",
	plan: ReturnType<typeof assessReviewPlan>,
): Promise<ReviewContext | null> {
	const snapshot = await collectReviewSnapshot(pi, target, vcs);
	if (!snapshot) return null;
	const fileArtifacts = await collectReviewFileArtifacts(ctx, plan);
	return buildReviewContext({
		diffSnapshot: snapshot,
		files: fileArtifacts.files,
		fileDiffs: await collectReviewFileDiffs(pi, target, vcs, plan),
		fileMetadata: fileArtifacts.fileMetadata,
	});
}

function appendReviewSections(
	basePrompt: string,
	strategyPrompt: string,
	rereviewPrompt: string,
): string {
	return `${basePrompt}\n\n${strategyPrompt}${rereviewPrompt ? `\n\n${rereviewPrompt}` : ""}`;
}

async function buildReviewPrompt(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: ReviewTarget,
	previousReviewMemory: ReviewMemory | null = null,
): Promise<string> {
	const vcs = await detectVCS(pi);
	const targetLabel = getTargetLabel(target, vcs);
	const plan = assessReviewPlan(await collectReviewEntries(pi, target, vcs));
	const sharedReviewContext = await buildSharedReviewContext(pi, ctx, target, vcs, plan).catch((error) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`共享 review context 构建失败：${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return null;
	});
	currentReviewContext = sharedReviewContext ?? undefined;
	const strategyPrompt = buildReviewStrategyPrompt({ plan, targetLabel, vcs });
	const rereviewPrompt = buildRereviewPromptSection(previousReviewMemory);
	const languagePrompt = buildReviewLanguageInstructionFromUserTexts(extractUserTextsFromEntries(ctx.sessionManager.getBranch()));
	const contextPrompt = sharedReviewContext
		? `## Shared review context\nThe Pi review plugin has prepared shared diff context. Use the read-only \`${REVIEW_CONTEXT_TOOL_NAME}\` tool to inspect changed files, per-file diffs, hunks, metadata, searches, and excerpts on demand instead of asking for the whole diff in the prompt. Start with \`${REVIEW_CONTEXT_TOOL_NAME}({ kind: "list-files" })\` and fetch only the files/hunks needed for each finding.`
		: "";

	if (vcs === "jj") {
		switch (target.type) {
			case "uncommitted":
				return appendReviewSections(
					["Review the current code changes. Use `jj status` and `jj diff` to inspect the diff, then provide prioritized findings.", languagePrompt, contextPrompt].filter(Boolean).join("\n\n"),
					strategyPrompt,
					rereviewPrompt,
				);
			case "baseBranch": {
				const ref = sanitizePromptInput(target.branch);
				const mergeBaseRevset = `heads(::@ & ::${target.branch})`;
				return appendReviewSections(
					[`Review the code changes relative to '${ref}'. First run \`jj log -r '${mergeBaseRevset}' --no-graph\` to confirm the common ancestor, then run \`jj diff --from '${mergeBaseRevset}' --to @\` to inspect changes relative to that ancestor. Provide prioritized actionable findings.`, languagePrompt, contextPrompt].filter(Boolean).join("\n\n"),
					strategyPrompt,
					rereviewPrompt,
				);
			}
			case "commit": {
				const short = target.sha.slice(0, 8);
				const title = target.title ? ` ("${sanitizePromptInput(target.title)}")` : "";
				return appendReviewSections(
					[`Review the code changes introduced by change ${short}${title}. Run \`jj --ignore-working-copy diff -r ${target.sha}\` to inspect the diff, then provide prioritized actionable findings.`, languagePrompt, contextPrompt].filter(Boolean).join("\n\n"),
					strategyPrompt,
					rereviewPrompt,
				);
			}
		}
	}

	switch (target.type) {
		case "uncommitted":
			return appendReviewSections(
				["Review the current code changes, including staged, unstaged, and untracked files. Use `git status --porcelain`, `git diff`, and `git diff --staged` to inspect the diff, then provide prioritized findings.", languagePrompt, contextPrompt].filter(Boolean).join("\n\n"),
				strategyPrompt,
				rereviewPrompt,
			);
		case "baseBranch": {
			const branch = sanitizePromptInput(target.branch);
			const mergeBase = await getMergeBase(pi, target.branch);
			const basePrompt = mergeBase
				? `Review the code changes relative to base branch '${branch}'. The merge-base commit for this comparison is ${mergeBase}. Run \`git diff ${mergeBase}\` to inspect changes relative to ${branch}, then provide prioritized actionable findings.`
				: `Review the code changes relative to base branch '${branch}'. First run \`git merge-base HEAD ${branch}\` to find the merge base, then run \`git diff <merge-base>\` to inspect the diff. Provide prioritized actionable findings.`;
			return appendReviewSections(
				[basePrompt, languagePrompt, contextPrompt].filter(Boolean).join("\n\n"),
				strategyPrompt,
				rereviewPrompt,
			);
		}
		case "commit": {
			const short = target.sha.slice(0, 8);
			const title = target.title ? ` ("${sanitizePromptInput(target.title)}")` : "";
			return appendReviewSections(
				[`Review the code changes introduced by commit ${short}${title}. Run \`git show ${target.sha}\` to inspect the diff, then provide prioritized actionable findings.`, languagePrompt, contextPrompt].filter(Boolean).join("\n\n"),
				strategyPrompt,
				rereviewPrompt,
			);
		}
	}
}

function getTargetLabel(target: ReviewTarget, vcs: "git" | "jj"): string {
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
	}
}

function formatElapsed(startedAtMs: number, nowMs = Date.now()): string {
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
	const minutes = Math.floor(elapsedSeconds / 60);
	const seconds = elapsedSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export default function reviewExtension(pi: ExtensionAPI): void {
	pi.registerTool(makeVisibleReviewContextTool());
	let latestReviewWidgetCtx: ExtensionContext | undefined;
	const reviewWidgetRuntime = claimReviewWidgetRuntime();

	function stopReviewWidgetTimer(): void {
		reviewWidgetRuntime.clearTimer();
	}

	function renderReviewWidget(ctx: ExtensionContext): boolean {
		if (!reviewWidgetRuntime.isCurrent() || !ctx.hasUI) return false;
		latestReviewWidgetCtx = ctx;
		if (!reviewOriginId) {
			ctx.ui.setWidget("review", undefined);
			return false;
		}
		const isComplete = reviewCompletedTotalMs !== undefined;
		const nowMs = Date.now();
		const msg = buildReviewWidgetLine({
			targetLabel: reviewTargetLabel,
			startedAtMs: reviewStartedAtMs ?? nowMs,
			nowMs: isComplete ? (reviewStartedAtMs ?? 0) + reviewCompletedTotalMs! : nowMs,
			isComplete,
		});
		ctx.ui.setWidget("review", (_tui, theme) => ({
			render: (width: number) => [theme.fg("warning", msg).slice(0, width)],
			invalidate: () => {},
		}));
		return true;
	}

	function refreshReviewWidget(ctx?: ExtensionContext): void {
		if (!reviewWidgetRuntime.isCurrent()) return;
		const targetCtx = ctx ?? latestReviewWidgetCtx;
		if (!targetCtx?.hasUI) return;
		const hasWidget = renderReviewWidget(targetCtx);
		if (!hasWidget) {
			stopReviewWidgetTimer();
			return;
		}
		if (reviewWidgetRuntime.getTimer()) return;
		reviewWidgetRuntime.setTimer(setInterval(() => {
			if (!reviewWidgetRuntime.isCurrent() || !latestReviewWidgetCtx || !renderReviewWidget(latestReviewWidgetCtx)) {
				stopReviewWidgetTimer();
			}
		}, 1000));
	}

	function clearReviewWidget(ctx: ExtensionContext): void {
		if (!reviewWidgetRuntime.isCurrent()) return;
		stopReviewWidgetTimer();
		if (ctx.hasUI) ctx.ui.setWidget("review", undefined);
	}

	async function selectReviewModel(ctx: ExtensionCommandContext): Promise<Model<Api> | null> {
		return notifyBeforePrompt("选择 review 模型：", () => (
			selectModelForExtension(ctx, {
				title: "选择 review 模型",
				noModelsMessage: "当前没有可用模型，请先配置可用模型。",
			})
		));
	}

	async function chooseReviewModel(ctx: ExtensionCommandContext): Promise<boolean> {
		const selectedModel = await selectReviewModel(ctx);
		if (!selectedModel) return false;
		if (ctx.model && selectedModel.provider === ctx.model.provider && selectedModel.id === ctx.model.id) return true;
		preReviewModelRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const success = await pi.setModel(selectedModel);
		if (!success) {
			ctx.ui.notify(`无法切换到 ${selectedModel.provider}/${selectedModel.id}：模型未配置可用凭据`, "error");
			preReviewModelRef = undefined;
			return false;
		}
		return true;
	}

	function canNavigateTree(ctx: ExtensionContext): ctx is ExtensionCommandContext {
		return typeof (ctx as { navigateTree?: unknown }).navigateTree === "function";
	}

	function formatReviewStatus(): string {
		if (!reviewOriginId) return "当前没有进行中的 review";
		const target = reviewTargetLabel ?? "未知目标";
		if (reviewCompletedTotalMs !== undefined) {
			return `review 已完成：${target}，耗时 ${formatElapsed(0, reviewCompletedTotalMs)}`;
		}
		return `review 进行中：${target}，已运行 ${formatElapsed(reviewStartedAtMs ?? Date.now())}`;
	}

	async function finishReviewSession(ctx: ExtensionContext): Promise<void> {
		if (!reviewOriginId) {
			ctx.ui.notify("当前没有进行中的审查", "info");
			return;
		}
		const originId = reviewOriginId;
		const navigationCtx = canNavigateTree(ctx) ? ctx : latestReviewCommandCtx;
		reviewOriginId = undefined;
		reviewTargetLabel = undefined;
		reviewStartedAtMs = undefined;
		reviewCompletedTotalMs = undefined;
		currentReviewTargetKey = undefined;
		currentReviewContext = undefined;
		latestReviewCommandCtx = undefined;
		pi.appendEntry(REVIEW_STATE_TYPE, { active: false } satisfies ReviewSessionState);
		clearReviewWidget(ctx);

		if (preReviewModelRef) {
			const [provider, modelId] = preReviewModelRef.split("/");
			const original = ctx.modelRegistry.find(provider, modelId);
			if (original) await pi.setModel(original);
			preReviewModelRef = undefined;
		}

		if (navigationCtx && canNavigateTree(navigationCtx)) {
			await navigationCtx.navigateTree(originId);
		} else {
			ctx.ui.notify("审查状态已结束。当前上下文不能自动跳转，请用 session tree 返回主 session。", "info");
		}
	}

	async function resolveTarget(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<ReviewTarget | null> {
		const trimmed = args.trim();

		if (trimmed === "uncommitted") return { type: "uncommitted" };

		if (trimmed.startsWith("branch ")) {
			const branch = trimmed.slice(7).trim();
			if (!branch) {
				ctx.ui.notify("用法：/review branch <分支名/bookmark>", "error");
				return null;
			}
			return { type: "baseBranch", branch };
		}

		if (trimmed.startsWith("commit ")) {
			const sha = trimmed.slice(7).trim();
			if (!sha) {
				ctx.ui.notify("用法：/review commit <rev>", "error");
				return null;
			}
			return { type: "commit", sha };
		}

		if (trimmed) {
			ctx.ui.notify("用法：/review [uncommitted | branch <name> | commit <rev>]", "error");
			return null;
		}

		const choice = await notifyBeforePrompt(
			"选择审查内容：",
			() => ctx.ui.select("选择审查内容：", [
				"当前未提交改动",
				"相对某个分支的改动",
				"某个 commit",
			]),
		);
		if (!choice) return null;

		if (choice === "当前未提交改动") return { type: "uncommitted" };

		if (choice === "相对某个分支的改动") {
			const vcs = await detectVCS(pi);
			if (vcs === "jj") {
				const [allRefs, currentBookmarks] = await Promise.all([
					getLocalBranches(pi),
					jjCurrentBookmarks(pi),
				]);
				const excluded = new Set(currentBookmarks);
				const others = allRefs.filter((branch) => !excluded.has(branch));
				if (others.length === 0) {
					ctx.ui.notify("没有其他可用分支/bookmark", "error");
					return null;
				}
				const branch = await notifyBeforePrompt("选择基础分支：", () => ctx.ui.select("选择基础分支：", others));
				if (!branch) return null;
				return { type: "baseBranch", branch };
			}

			const [allRefs, currentRef] = await Promise.all([
				getLocalBranches(pi),
				getCurrentBranch(pi),
			]);
			const others = allRefs.filter((branch) => branch !== currentRef);
			if (others.length === 0) {
				ctx.ui.notify("没有其他可用分支/bookmark", "error");
				return null;
			}
			const branch = await notifyBeforePrompt("选择基础分支：", () => ctx.ui.select("选择基础分支：", others));
			if (!branch) return null;
			return { type: "baseBranch", branch };
		}

		if (choice === "某个 commit") {
			const commits = await getRecentCommits(pi);
			if (commits.length === 0) {
				ctx.ui.notify("没有找到记录", "error");
				return null;
			}
			const commitChoice = await notifyBeforePrompt(
				"选择：",
				() => ctx.ui.select(
					"选择：",
					commits.map((commit) => `${commit.sha.slice(0, 7)}  ${commit.title}`),
				),
			);
			if (!commitChoice) return null;
			const sha = commitChoice.trim().split(/\s+/)[0] ?? "";
			const commit = commits.find((item) => item.sha.startsWith(sha));
			return { type: "commit", sha: commit?.sha ?? sha, title: commit?.title };
		}

		return null;
	}

	async function startReviewSession(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
	): Promise<void> {
		if (reviewOriginId) {
			ctx.ui.notify("已有 review 进行中。用 /review status 查看进度，或用 /review off 结束当前审查。", "warning");
			return;
		}
		latestReviewCommandCtx = ctx;
		const entries = ctx.sessionManager.getBranch();
		const modelSelected = await chooseReviewModel(ctx);
		if (!modelSelected) {
			latestReviewCommandCtx = undefined;
			return;
		}

		reviewOriginId = entries.length > 0 ? entries[entries.length - 1].id : undefined;
		const vcs = await detectVCS(pi);
		const label = getTargetLabel(target, vcs);
		const targetKey = buildReviewTargetKey(vcs, target);
		const previousReviewMemory = getPreviousReviewMemory(entries, targetKey);
		reviewTargetLabel = label;
		reviewStartedAtMs = Date.now();
		currentReviewTargetKey = targetKey;

		pi.appendEntry(REVIEW_STATE_TYPE, {
			active: true,
			originId: reviewOriginId,
			targetLabel: reviewTargetLabel,
			startedAtMs: reviewStartedAtMs,
			completedTotalMs: undefined,
			targetKey: currentReviewTargetKey,
		} satisfies ReviewSessionState);

		refreshReviewWidget(ctx);

		const prompt = await buildReviewPrompt(pi, ctx, target, previousReviewMemory);
		pi.sendMessage(
			{
				customType: "review-start",
				content: `开始审查：${label}\n\n${prompt}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	pi.registerCommand("review", {
		description: REVIEW_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const trimmedArgs = (args ?? "").trim();
			if (/^off$/i.test(trimmedArgs)) {
				await finishReviewSession(ctx);
				return;
			}
			if (/^status$/i.test(trimmedArgs)) {
				ctx.ui.notify(formatReviewStatus(), reviewOriginId ? "info" : "warning");
				return;
			}

			const target = await resolveTarget(trimmedArgs, ctx);
			if (!target) return;
			await startReviewSession(ctx, target);
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearReviewWidget(ctx);
		currentReviewContext = undefined;
		latestReviewCommandCtx = undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!reviewOriginId) return;
		let rubricText: string;
		try {
			rubricText = await buildReviewRubricText(ctx.cwd);
		} catch (error) {
			throw error;
		}

		return {
			message: {
				customType: "review-rubric",
				content: rubricText,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!reviewOriginId || !ctx.hasUI) return;

		const messages = (event.messages ?? []) as Array<{ role?: string; content?: unknown }>;
		const lastText = extractLastAssistantText(messages);
		const lastUserText = extractLastUserText(messages);
		const summary = lastText ? compactReviewSummary(lastText) : null;
		if (summary && currentReviewTargetKey && lastText) {
			const now = Date.now();
			const previousReviewMemory = getPreviousReviewMemory(ctx.sessionManager.getBranch(), currentReviewTargetKey);
			const extractedFindings = extractReviewFindings(lastText);
			const nextMemory = extractedFindings.length === 0 && previousReviewMemory
				? {
					...previousReviewMemory,
					summary: previousReviewMemory.summary,
					createdAtMs: now,
				}
				: mergeReviewMemory(previousReviewMemory, {
					targetKey: currentReviewTargetKey,
					summary,
					createdAtMs: now,
					reviewText: lastText,
				});
			const updatedMemory = lastUserText
				? applyFindingFeedback(nextMemory, lastUserText, now)
				: nextMemory;
			pi.appendEntry(REVIEW_RESULT_TYPE, {
				...updatedMemory,
				targetLabel: reviewTargetLabel,
			} satisfies ReviewResultState);
		}

		// Review complete — stay in fork thread. User types instructions to fix,
		// or uses /review off to exit.

		// Halt timer — only count LLM duration, not post-review idle
		if (reviewCompletedTotalMs === undefined) {
			reviewCompletedTotalMs = Date.now() - (reviewStartedAtMs ?? Date.now());
			stopReviewWidgetTimer();
			renderReviewWidget(ctx);
			pi.appendEntry(REVIEW_STATE_TYPE, {
				active: true,
				originId: reviewOriginId,
				targetLabel: reviewTargetLabel,
				startedAtMs: reviewStartedAtMs,
				completedTotalMs: reviewCompletedTotalMs,
				targetKey: currentReviewTargetKey,
			} satisfies ReviewSessionState);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		let lastState: ReviewSessionState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
				lastState = entry.data as ReviewSessionState;
			}
		}

		if (lastState?.active && lastState.originId) {
			reviewOriginId = lastState.originId;
			reviewTargetLabel = lastState.targetLabel;
			reviewStartedAtMs = lastState.startedAtMs ?? Date.now();
			reviewCompletedTotalMs = lastState.completedTotalMs;
			currentReviewTargetKey = lastState.targetKey;
			currentReviewContext = undefined;
			latestReviewCommandCtx = undefined;
			refreshReviewWidget(ctx);
		} else {
			reviewOriginId = undefined;
			reviewTargetLabel = undefined;
			reviewStartedAtMs = undefined;
			reviewCompletedTotalMs = undefined;
			currentReviewTargetKey = undefined;
			currentReviewContext = undefined;
			latestReviewCommandCtx = undefined;
			clearReviewWidget(ctx);
		}
	});
}
