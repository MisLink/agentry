/**
 * Review Extension
 *
 * 为代码改动提供 AI 驱动的代码审查。
 *
 * 特性：
 * - Session fork：review 在独立 branch 中进行，不污染主 session 的上下文
 * - 支持 git 和 jj (Jujutsu) 版本控制
 * - 支持审查未提交改动、分支 diff、特定 commit
 * - 注入详细的中文 review rubric（P0-P3 优先级）
 * - 支持项目级 REVIEW_GUIDELINES.md 追加自定义规则
 * - review 结束后可选择修复问题或返回主 session
 *
 * 用法：
 *   /review               — 交互式选择审查目标
 *   /review uncommitted   — 审查未提交改动
 *   /review branch <name> — 审查相对某分支/bookmark 的 diff
 *   /review commit <rev>  — 审查某个 commit/change
 *   /end-review           — 返回主 session（丢弃 review branch）
 *
 * 项目级审查规范：在 .pi 目录所在的项目根放 REVIEW_GUIDELINES.md，
 * 内容会自动追加到 rubric 末尾。
 */

import {
	buildSessionContext,
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { getModelForSlot } from "../../lib/model-router.js";
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
import { buildOrchestrationSection } from "./orchestrator.js";
import { buildHiddenReviewSessionSpecs, runHiddenReviewFanout } from "./fanout.js";
import { buildHiddenReviewContext, createHiddenReviewContextTool } from "./hidden-context.js";
import { loadPortableAlignmentSection } from "./portable-source.js";
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
import { buildReviewWidgetLine } from "./status.js";

// ─── VCS Detection ───────────────────────────────────────────────────────────

async function detectVCS(pi: ExtensionAPI): Promise<"git" | "jj"> {
	// Check jj first; in colocated repos prefer jj for local operations.
	const { code: jjCode } = await pi.exec("jj", ["--ignore-working-copy", "root"]);
	if (jjCode === 0) return "jj";
	return "git";
}

// ─── State ────────────────────────────────────────────────────────────────────

/** Entry ID before review started — used by /end-review to navigate back. */
let reviewOriginId: string | undefined = undefined;
/** Model that was active before review started — restored on /end-review. */
let preReviewModelRef: string | undefined = undefined;
let reviewTargetLabel: string | undefined = undefined;
let reviewStartedAtMs: number | undefined = undefined;
let currentReviewTargetKey: string | undefined = undefined;
let reviewWidgetTimer: ReturnType<typeof setInterval> | undefined = undefined;

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_RESULT_TYPE = "review-result";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
	targetLabel?: string;
	startedAtMs?: number;
	targetKey?: string;
};

type ReviewResultState = ReviewMemory & {
	targetLabel?: string;
};

// ─── Review targets ───────────────────────────────────────────────────────────

type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

// ─── VCS-specific Helpers ─────────────────────────────────────────────────────

// --- Git helpers ---

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
	return stdout.trim().split("\n").filter((b) => b.trim());
}

async function gitCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function gitRecentCommits(
	pi: ExtensionAPI,
	limit = 15,
): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", "--oneline", `-n`, `${limit}`]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((l) => l.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split(" ");
			return { sha: sha ?? "", title: rest.join(" ") };
		});
}

// --- JJ helpers ---

async function jjCurrentBookmarks(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "bookmark", "list", "-r", "@", "--template", 'name ++ "\\n"',
	]);
	if (code !== 0) return [];
	return [...new Set(stdout.trim().split("\n").filter((b) => b.trim()))];
}

async function jjBookmarks(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "bookmark", "list", "--template", 'name ++ "\\n"',
	]);
	if (code !== 0) return [];
	return [...new Set(stdout.trim().split("\n").filter((b) => b.trim()))];
}

async function jjRecentChanges(
	pi: ExtensionAPI,
	limit = 15,
): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("jj", [
		"--ignore-working-copy", "log", "--no-graph", `-n`, `${limit}`,
		"--template",
		`change_id.shortest() ++ "  " ++ description.first_line() ++ "\\n"`,
	]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((l) => l.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split("  ");
			return { sha: sha ?? "", title: rest.join("  ").trim() };
		});
}

// --- Unified wrappers ---

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	const vcs = await detectVCS(pi);
	if (vcs === "jj") {
		// jj: just return the bookmark name — the diff prompt will use `jj diff --from <ref> --to @`
		return branch;
	}
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

// ─── Rubric ───────────────────────────────────────────────────────────────────

const REVIEW_RUBRIC = `# 代码审查指南

你是一名代码审查员，正在审查另一位工程师提交的代码改动。

以下是默认的审查标准。如果在开发者消息、用户消息、文件或项目审查指南（见末尾）中遇到更具体的规定，以那些规定为准。

## 需要标记的问题

标记满足以下全部条件的问题：

1. 对代码的正确性、性能、安全性或可维护性有实质影响
2. 具体且可操作（不是泛泛的问题，也不是多个问题的混合）
3. 与代码库其他部分的严格程度一致
4. 是本次改动引入的（不是预先存在的 bug）
5. 作者如果知道这个问题，很可能会去修复
6. 不依赖对代码库或作者意图的未声明假设
7. 对其他代码有可证明的影响——仅推测可能有影响是不够的，必须明确指出受影响的具体位置
8. 明显不是作者有意为之的改动
9. 对不受信任的用户输入要特别谨慎
10. 将静默的本地错误恢复（尤其是解析/IO/网络回退）视为高优先级审查候选，除非有明确的边界层级说明

## 不受信任的用户输入

1. 警惕开放重定向，必须验证只能跳转到可信域名（?next_page=...）
2. 始终标记未参数化的 SQL
3. 在有用户提供 URL 的系统中，HTTP 请求必须防范对本地资源的访问（拦截 DNS 解析器！）
4. 优先使用转义而不是清理（如 HTML 转义）

## 评论规范

1. 清楚说明为什么这是个问题
2. 适度表达严重性，不要夸大
3. 简洁——最多 1 段
4. 代码片段不超过 3 行，用行内代码或代码块包裹
5. 用 \`\`\`suggestion 块仅提供具体的替换代码（最少行数，块内不加评论），保留被替换行的原始缩进
6. 明确说明问题在哪种场景/环境下出现
7. 语气客观——像有帮助的助手，不要带指责意味
8. 写作目标是不用仔细阅读也能快速理解
9. 避免过度夸奖或"做得不错……"之类无用的话

## 审查优先级

1. 在末尾列出关键的非阻塞人工提示（数据迁移、依赖变更、权限/认证、兼容性、破坏性操作）
2. 优先简单直接的解决方案，避免没有明确价值的抽象包装
3. 把背压处理视为系统稳定性的关键
4. 进行系统层面的思考，标记会增加运维风险的改动
5. 确保错误处理使用错误码或稳定标识符，而不是错误消息字符串

## 快速失败的错误处理（严格）

审查新增或修改的错误处理时，默认要求快速失败行为：

1. 评估每个新的或修改的 \`try/catch\`：明确什么会失败，以及为何在这一层本地处理是正确的
2. 优先向上传播而不是本地恢复。如果当前层无法在保持正确性的前提下完全恢复，应重新抛出（可选附加上下文），而不是返回回退值
3. 标记会隐藏失败信号的 catch 块（如返回 \`null\`/\`[]\`/\`false\`、吞掉 JSON 解析失败、记录日志后继续、或"尽力而为"的静默恢复）
4. JSON 解析/解码默认应该大声失败。静默回退解析只有在有明确兼容性要求和清晰测试行为时才可接受
5. 边界处理器（HTTP 路由、CLI 入口、supervisor）可以转换错误，但不能假装成功或静默降级
6. 如果 catch 块只是为了满足 lint/风格要求而没有真正的处理逻辑，视为 bug
7. 不确定时，优先快速崩溃而不是静默降级

## 必填的人工提示（非阻塞，放在最后）

在 findings/verdict 之后，必须追加以下部分：

## 人工审查提示（非阻塞）

仅包含适用的提示（不要写是/否判断）：

- **此改动包含数据库迁移：** <文件/详情>
- **此改动引入了新依赖：** <包名/详情>
- **此改动修改了依赖（或 lockfile）：** <文件/包名/详情>
- **此改动修改了认证/权限逻辑：** <改动内容及位置>
- **此改动引入了向后不兼容的 schema/API/合约变更：** <改动内容及位置>
- **此改动包含不可逆或破坏性操作：** <操作及范围>

此部分的规则：

1. 这些是给人工审查员的信息提示，不是需要修复的问题
2. 除非有独立的 bug，否则不要将它们列入 Findings
3. 仅有这些提示不应改变 verdict
4. 只包含适用于本次审查改动的提示
5. 每条提示的加粗格式完全保持原样
6. 如果没有适用的，写"- （无）"

## 优先级级别

在标题中用优先级标签标记每个 finding：

- [P0] - 立即停下修复。阻塞发布/运营。仅用于不依赖输入假设的普遍性问题
- [P1] - 紧急。应在下一个周期内处理
- [P2] - 普通。最终需要修复
- [P3] - 低优先级。有的话更好

## 输出格式

以清晰、结构化的格式提供 findings：

1. 每个 finding 包含优先级标签、文件位置和说明
2. Findings 必须引用与实际 diff 重叠的位置——不要标记预先存在的代码
3. 行引用尽量简短（避免超过 5-10 行的范围；选取最合适的子范围）
4. 给出总体 verdict："correct"（无阻塞性问题）或"needs attention"（有阻塞性问题）
5. 忽略不影响理解或未违反文档规范的琐碎风格问题
6. 不要生成完整的修复 PR——只标记问题，可选提供简短的 suggestion 块
7. 以必填的"人工审查提示（非阻塞）"部分结尾

输出作者知道后会修复的所有 findings。如果没有符合条件的问题，明确说明代码看起来没有问题。不要在第一个 finding 处停下——列出所有符合条件的问题。然后追加必填的非阻塞提示部分。`;

// ─── Utilities ────────────────────────────────────────────────────────────────

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(
		part
			&& typeof part === "object"
			&& "type" in part
			&& (part as Record<string, unknown>).type === "text"
			&& "text" in part,
	);

function extractLastMessageText(messages: Array<{ role?: string; content?: unknown }>, role: "assistant" | "user"): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== role) continue;
		const { content } = message;
		if (typeof content === "string") return content.trim() || null;
		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}
		return null;
	}
	return null;
}

function extractLastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string | null {
	return extractLastMessageText(messages, "assistant");
}

function extractLastUserText(messages: Array<{ role?: string; content?: unknown }>): string | null {
	return extractLastMessageText(messages, "user");
}

function getPreviousReviewMemory(entries: Array<{ type?: string; customType?: string; data?: unknown }>, targetKey: string): ReviewMemory | null {
	const memories = entries
		.filter((entry) => entry.type === "custom" && entry.customType === REVIEW_RESULT_TYPE)
		.map((entry) => entry.data as ReviewResultState);
	return findPreviousReviewMemory(memories, targetKey);
}

/** Walk up from cwd looking for .pi directory, then check for REVIEW_GUIDELINES.md alongside it. */
async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);
	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (guidelineStats?.isFile()) {
				try {
					const content = await fs.readFile(guidelinesPath, "utf8");
					const trimmed = content.trim();
					return trimmed || null;
				} catch {
					return null;
				}
			}
			return null;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

async function collectReviewEntries(pi: ExtensionAPI, target: ReviewTarget, vcs: "git" | "jj"): Promise<ReviewEntry[]> {
	const mergeBase = target.type === "baseBranch" && vcs === "git"
		? await getMergeBase(pi, target.branch)
		: undefined;
	const plan = buildReviewCollectionPlan({ vcs, target, mergeBase });
	const binary = vcs;
	const outputs = await Promise.all(plan.commands.map((command) => pi.exec(binary, command.args)));
	return mergeReviewEntries(outputs.flatMap((output, index) => {
		if (output.code !== 0) return [];
		const command = plan.commands[index];
		if (!command) return [];
		return parseReviewCollectionOutput(command, output.stdout);
	}));
}

const HIDDEN_REVIEW_SYSTEM_PROMPT = [
	"You are hidden review specialist session running inside pi extension.",
	"You must not assume extra tools or extra context beyond provided prompt.",
	"Output concise specialist findings only.",
].join(" ");

const MAX_HIDDEN_REVIEW_SNAPSHOT_CHARS = 40_000;
const MAX_HIDDEN_REVIEW_FILE_CHARS = 20_000;
const MAX_HIDDEN_REVIEW_FILE_DIFF_CHARS = 20_000;

function stripSystemPromptFooter(prompt: string): string {
	return prompt
		.replace(/(?:\n(?:Current (?:date(?: and time)?|working directory):[^\n]*))+$/u, "")
		.trim();
}

function clipHiddenReviewSnapshot(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_HIDDEN_REVIEW_SNAPSHOT_CHARS) return normalized;
	return `${normalized.slice(0, MAX_HIDDEN_REVIEW_SNAPSHOT_CHARS)}\n\n[truncated hidden review snapshot]`;
}

function makeHiddenReviewResourceLoader(ctx: ExtensionContext): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripSystemPromptFooter(ctx.getSystemPrompt());
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [HIDDEN_REVIEW_SYSTEM_PROMPT],
		extendResources: () => {},
		reload: async () => {},
	};
}

function makeHiddenReviewContextCustomTool(context: ReturnType<typeof buildHiddenReviewContext>) {
	const tool = createHiddenReviewContextTool(context);
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

function formatHiddenReviewSnapshotSection(command: string, output: { code: number; stdout: string; stderr: string }): string {
	const body = output.stdout.trim() || output.stderr.trim() || "(empty)";
	return `### \`${command}\`\n(exit ${output.code})\n${body}`;
}

function clipHiddenReviewFileContent(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_HIDDEN_REVIEW_FILE_CHARS) return normalized;
	return `${normalized.slice(0, MAX_HIDDEN_REVIEW_FILE_CHARS)}\n\n[truncated hidden review file]`;
}

function clipHiddenReviewFileDiff(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_HIDDEN_REVIEW_FILE_DIFF_CHARS) return normalized;
	return `${normalized.slice(0, MAX_HIDDEN_REVIEW_FILE_DIFF_CHARS)}\n\n[truncated hidden review diff]`;
}

async function collectHiddenReviewSnapshot(
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
	if (commands.length === 0) return "";
	const outputs = await Promise.all(commands.map((command) => pi.exec(command.binary, command.args)));
	const sections = outputs.map((output, index) => {
		const command = commands[index];
		if (!command) return "";
		return formatHiddenReviewSnapshotSection(`${command.binary} ${command.args.join(" ")}`, output);
	}).filter(Boolean);
	return clipHiddenReviewSnapshot(sections.join("\n\n"));
}

async function collectHiddenReviewFileArtifacts(
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
			if (buffer.includes(0)) {
				return { path: entry.path, state: "binary" as const };
			}
			const content = buffer.toString("utf8");
			return {
				path: entry.path,
				state: "available" as const,
				content: clipHiddenReviewFileContent(content),
				lineCount: content.split(/\r?\n/).length,
			};
		} catch (error) {
			const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
			if (code === "ENOENT") {
				return { path: entry.path, state: "deleted" as const };
			}
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

async function collectHiddenReviewFileDiffs(
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
		return { path: entry.path, diff: clipHiddenReviewFileDiff(diff) };
	}));
	return results.filter((item): item is { path: string; diff: string } => Boolean(item));
}

function extractHiddenAssistantText(session: AgentSession): string {
	const text = extractLastAssistantText(session.state.messages as Array<{ role?: string; content?: unknown }>);
	return text || "(No specialist output)";
}

async function buildHiddenReviewFanoutSection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: ReviewTarget,
	plan: ReturnType<typeof assessReviewPlan>,
	targetLabel: string,
	basePrompt: string,
): Promise<string> {
	if (plan.tier !== "full" || !ctx.model) return "";
	const specs = buildHiddenReviewSessionSpecs(plan, { targetLabel, basePrompt });
	if (specs.length === 0) return "";
	const vcs = await detectVCS(pi);
	const snapshot = await collectHiddenReviewSnapshot(pi, target, vcs);
	if (!snapshot) return "";
	const fileArtifacts = await collectHiddenReviewFileArtifacts(ctx, plan);
	const hiddenContext = buildHiddenReviewContext({
		diffSnapshot: snapshot,
		files: fileArtifacts.files,
		fileDiffs: await collectHiddenReviewFileDiffs(pi, target, vcs, plan),
		fileMetadata: fileArtifacts.fileMetadata,
	});
	try {
		const result = await runHiddenReviewFanout({
			specs,
			targetLabel,
			createRunner: async () => {
				const { session } = await createAgentSession({
					sessionManager: SessionManager.inMemory(ctx.cwd),
					model: ctx.model,
					modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
					thinkingLevel: "off",
					tools: [],
					customTools: [makeHiddenReviewContextCustomTool(hiddenContext)],
					resourceLoader: makeHiddenReviewResourceLoader(ctx),
				});
				try {
					const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
					if (messages.length > 0) {
						session.agent.state.messages = messages as typeof session.state.messages;
					}
				} catch {
					/* best effort context seed */
				}
				return {
					run: async (prompt) => {
						await session.prompt(`${prompt}\nUse read-only tool hidden_review_context for diff or changed-file lookup when needed. Start with list-files when path set is unclear, use search for matching lines before picking a file, use file-meta for deleted/binary/unreadable paths, and use file, file-diff, list-hunks, hunk-excerpt, or file-excerpt for allowed changed files / diff hunks / structured hunk navigation / line ranges. Do not request edits or writes. Output only specialist findings from this perspective.`, { source: "extension" });
						return extractHiddenAssistantText(session);
					},
					dispose: async () => {
						await session.abort().catch(() => undefined);
						session.dispose();
					},
				};
			},
		});
		return `## Hidden specialist prepasses\n以下内容来自 extension 管理的 hidden specialist sessions（in-memory，不写入主 review tree）。把它们当作额外信号，但在最终可见审查里仍要重新核对代码与 diff。\n\n${result.coordinatorPrompt}`;
	} catch (error) {
		ctx.ui.notify(`审查 specialist hidden session 失败：${error instanceof Error ? error.message : String(error)}`, "warning");
		return "";
	}
}

function appendReviewSections(
	basePrompt: string,
	plan: ReturnType<typeof assessReviewPlan>,
	targetLabel: string,
	strategyPrompt: string,
	rereviewPrompt: string,
): string {
	const orchestrationPrompt = buildOrchestrationSection({ plan, targetLabel, basePrompt });
	const portableAlignmentPrompt = loadPortableAlignmentSection();
	return `${basePrompt}\n\n${strategyPrompt}${rereviewPrompt ? `\n\n${rereviewPrompt}` : ""}${orchestrationPrompt ? `\n\n${orchestrationPrompt}` : ""}${portableAlignmentPrompt ? `\n\n${portableAlignmentPrompt}` : ""}`;
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
	const strategyPrompt = buildReviewStrategyPrompt({ plan, targetLabel, vcs });
	const rereviewPrompt = buildRereviewPromptSection(previousReviewMemory);

	const finalize = async (basePrompt: string): Promise<string> => {
		const visiblePrompt = appendReviewSections(basePrompt, plan, targetLabel, strategyPrompt, rereviewPrompt);
		const hiddenFanoutPrompt = await buildHiddenReviewFanoutSection(pi, ctx, target, plan, targetLabel, basePrompt);
		return hiddenFanoutPrompt ? `${visiblePrompt}\n\n${hiddenFanoutPrompt}` : visiblePrompt;
	};

	if (vcs === "jj") {
		switch (target.type) {
			case "uncommitted":
				return finalize("审查当前代码改动。使用 `jj status` 和 `jj diff` 获取改动内容，提供带优先级的 findings。");

			case "baseBranch": {
				const ref = sanitizePromptInput(target.branch);
				const mergeBaseRevset = `heads(::@ & ::${target.branch})`;
				return finalize(
					`审查相对于 '${ref}' 的代码改动。先用 \`jj log -r '${mergeBaseRevset}' --no-graph\` 确认共同祖先，再运行 \`jj diff --from '${mergeBaseRevset}' --to @\` 查看相对于共同祖先的改动，提供带优先级的可操作 findings。`,
				);
			}

			case "commit": {
				const short = target.sha.slice(0, 8);
				if (target.title) {
					return finalize(
						`审查 change ${short}（"${sanitizePromptInput(target.title)}"）引入的代码改动。运行 \`jj --ignore-working-copy diff -r ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`,
					);
				}
				return finalize(
					`审查 change ${short} 引入的代码改动。运行 \`jj --ignore-working-copy diff -r ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`,
				);
			}
		}
	}

	switch (target.type) {
		case "uncommitted":
			return finalize("审查当前代码改动（已暂存、未暂存和未追踪的文件）。使用 `git status --porcelain`、`git diff`、`git diff --staged` 获取改动内容，提供带优先级的 findings。");

		case "baseBranch": {
			const branch = sanitizePromptInput(target.branch);
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				return finalize(
					`审查相对于基础分支 '${branch}' 的代码改动。本次比较的 merge base commit 为 ${mergeBase}。运行 \`git diff ${mergeBase}\` 查看相对于 ${branch} 的改动，提供带优先级的可操作 findings。`,
				);
			}
			return finalize(
				`审查相对于基础分支 '${branch}' 的代码改动。先用 \`git merge-base HEAD ${branch}\` 找到 merge base，再运行 \`git diff <merge-base>\` 查看改动，提供带优先级的可操作 findings。`,
			);
		}

		case "commit": {
			const short = target.sha.slice(0, 8);
			if (target.title) {
				return finalize(
					`审查 commit ${short}（"${sanitizePromptInput(target.title)}"）引入的代码改动。运行 \`git show ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`,
				);
			}
			return finalize(
				`审查 commit ${short} 引入的代码改动。运行 \`git show ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`,
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

// ─── Extension ────────────────────────────────────────────────────────────────

export default function reviewExtension(pi: ExtensionAPI): void {

	function stopReviewWidgetTimer(): void {
		if (reviewWidgetTimer) clearInterval(reviewWidgetTimer);
		reviewWidgetTimer = undefined;
	}

	function renderReviewWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const msg = buildReviewWidgetLine({
			targetLabel: reviewTargetLabel,
			startedAtMs: reviewStartedAtMs ?? Date.now(),
			nowMs: Date.now(),
		});
		ctx.ui.setWidget("review", (_tui, theme) => ({
			render: (width: number) => [theme.fg("warning", msg).slice(0, width)],
			invalidate: () => {},
		}));
	}

	function setReviewWidget(ctx: ExtensionContext, active: boolean): void {
		if (!ctx.hasUI) return;
		if (!active) {
			stopReviewWidgetTimer();
			ctx.ui.setWidget("review", undefined);
			return;
		}
		renderReviewWidget(ctx);
		if (reviewWidgetTimer) return;
		reviewWidgetTimer = setInterval(() => {
			if (!reviewOriginId) {
				stopReviewWidgetTimer();
				return;
			}
			renderReviewWidget(ctx);
		}, 1000);
	}

	/** Parse target from command args, or show interactive selector. */
	async function resolveTarget(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<ReviewTarget | null> {
		const trimmed = args.trim();

		// Direct args: "uncommitted", "branch <name>", "commit <sha>"
		if (trimmed === "uncommitted") return { type: "uncommitted" };

		if (trimmed.startsWith("branch ")) {
			const branch = trimmed.slice(7).trim();
			if (!branch) { ctx.ui.notify("用法：/review branch <分支名/bookmark>", "error"); return null; }
			return { type: "baseBranch", branch };
		}

		if (trimmed.startsWith("commit ")) {
			const sha = trimmed.slice(7).trim();
			if (!sha) { ctx.ui.notify("用法：/review commit <rev>", "error"); return null; }
			return { type: "commit", sha };
		}

		if (trimmed) {
			ctx.ui.notify("用法：/review [uncommitted | branch <name> | commit <rev>]", "error");
			return null;
		}

		// Interactive selector
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
				const others = allRefs.filter((b) => !excluded.has(b));
				if (others.length === 0) { ctx.ui.notify("没有其他可用分支/bookmark", "error"); return null; }
				const branch = await notifyBeforePrompt("选择基础分支：", () => ctx.ui.select("选择基础分支：", others));
				if (!branch) return null;
				return { type: "baseBranch", branch };
			}

			const [allRefs, currentRef] = await Promise.all([
				getLocalBranches(pi),
				getCurrentBranch(pi),
			]);
			const others = allRefs.filter((b) => b !== currentRef);
			if (others.length === 0) { ctx.ui.notify("没有其他可用分支/bookmark", "error"); return null; }
			const branch = await notifyBeforePrompt("选择基础分支：", () => ctx.ui.select("选择基础分支：", others));
			if (!branch) return null;
			return { type: "baseBranch", branch };
		}

		if (choice === "某个 commit") {
			const commits = await getRecentCommits(pi);
			if (commits.length === 0) { ctx.ui.notify("没有找到记录", "error"); return null; }
			const commitChoice = await notifyBeforePrompt(
				"选择：",
				() => ctx.ui.select(
					"选择：",
					commits.map((c) => `${c.sha.slice(0, 7)}  ${c.title}`),
				),
			);
			if (!commitChoice) return null;
			const sha = commitChoice.trim().split(/\s+/)[0] ?? "";
			const commit = commits.find((c) => c.sha.startsWith(sha));
			return { type: "commit", sha: commit?.sha ?? sha, title: commit?.title };
		}

		return null;
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("review", {
		description: "审查代码改动。用法：/review [uncommitted | branch <name> | commit <rev>]",
		handler: async (args, ctx) => {
			if (reviewOriginId) {
				ctx.ui.notify("已有审查进行中。用 /end-review 结束当前审查后再开始新的。", "warning");
				return;
			}

			const target = await resolveTarget(args ?? "", ctx);
			if (!target) return;

			// Record origin for /end-review to navigate back
			const entries = ctx.sessionManager.getBranch();
			reviewOriginId = entries.length > 0 ? entries[entries.length - 1].id : undefined;

			const vcs = await detectVCS(pi);
			const label = getTargetLabel(target, vcs);
			const targetKey = buildReviewTargetKey(vcs, target);
			const previousReviewMemory = getPreviousReviewMemory(entries, targetKey);
			reviewTargetLabel = label;
			reviewStartedAtMs = Date.now();
			currentReviewTargetKey = targetKey;

			// Persist state so it survives session resume
			pi.appendEntry(REVIEW_STATE_TYPE, {
				active: true,
				originId: reviewOriginId,
				targetLabel: reviewTargetLabel,
				startedAtMs: reviewStartedAtMs,
				targetKey: currentReviewTargetKey,
			} satisfies ReviewSessionState);

			setReviewWidget(ctx, true);

			// Switch to cross-model for review
			const reviewModel = await getModelForSlot("review", ctx);
			if (reviewModel && ctx.model && reviewModel.id !== ctx.model.id) {
				preReviewModelRef = `${ctx.model.provider}/${ctx.model.id}`;
				await pi.setModel(reviewModel);
			}

			const prompt = await buildReviewPrompt(pi, ctx, target, previousReviewMemory);
			pi.sendMessage(
				{
					customType: "review-start",
					content: `开始审查：${label}\n\n${prompt}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("end-review", {
		description: "结束当前审查，返回主 session",
		handler: async (_args, ctx) => {
			if (!reviewOriginId) {
				ctx.ui.notify("当前没有进行中的审查", "info");
				return;
			}
			const originId = reviewOriginId;
			reviewOriginId = undefined;
			reviewTargetLabel = undefined;
			reviewStartedAtMs = undefined;
			currentReviewTargetKey = undefined;
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false } satisfies ReviewSessionState);
			setReviewWidget(ctx, false);

			// Restore the model that was active before review
			if (preReviewModelRef) {
				const [provider, modelId] = preReviewModelRef.split("/");
				const original = ctx.modelRegistry.find(provider, modelId);
				if (original) await pi.setModel(original);
				preReviewModelRef = undefined;
			}

			await ctx.navigateTree(originId);
		},
	});

	// ── Event hooks ───────────────────────────────────────────────────────────

	/** Inject rubric before every LLM turn while a review is active. */
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!reviewOriginId) return;

		const guidelines = await loadProjectReviewGuidelines(ctx.cwd);
		const rubricText = guidelines
			? `${REVIEW_RUBRIC}\n\n---\n\n## 项目特定审查规范\n\n${sanitizePromptInput(guidelines)}`
			: REVIEW_RUBRIC;

		return {
			message: {
				customType: "review-rubric",
				content: rubricText,
				display: false,
			},
		};
	});

	/** After review finishes, offer to fix issues or return to main session. */
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

		const choice = await notifyBeforePrompt(
			"审查完成，下一步？",
			() => ctx.ui.select("审查完成，下一步？", [
				"修复所有问题",
				"继续（自由输入）",
				"返回主 session（/end-review）",
			]),
		);

		if (choice === "修复所有问题") {
			pi.sendUserMessage(
				"请修复上述审查中发现的所有 P0、P1、P2 问题。每修复一个问题后简要说明改了什么。",
			);
		} else if (choice === "继续（自由输入）") {
			const input = await notifyBeforePrompt("输入你的指示：", () => ctx.ui.input("输入你的指示："));
			if (input?.trim()) {
				pi.sendUserMessage(input.trim());
			}
		} else {
			ctx.ui.notify("输入 /end-review 返回主 session", "info");
		}
	});

	/** Restore review state when resuming a session. */
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
			currentReviewTargetKey = lastState.targetKey;
			setReviewWidget(ctx, true);
		} else {
			reviewOriginId = undefined;
			reviewTargetLabel = undefined;
			reviewStartedAtMs = undefined;
			currentReviewTargetKey = undefined;
			setReviewWidget(ctx, false);
		}
	});
}
