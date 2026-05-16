/**
 * 代码审查扩展
 *
 * 为代码改动提供 AI 驱动的只读审查。设计参考：
 *   - mitsuhiko/agent-stuff 的 `/review` + `/end-review`：会话内分叉 +
 *     navigateTree 总结 + 仅返回 / 返回并总结 / 返回并修复三选项
 *   - Cloudflare AI code review 博文：审查准则里“什么不该指出”的写法、
 *     噪声过滤、boundary tag 清洗防提示词注入
 *
 * 特性：
 * - git 与 jj (Jujutsu) 双 VCS 支持
 * - 审查未提交改动 / 相对分支差异 / 单个提交 / Merge Request（glab）/
 *   Pull Request（gh）
 * - `/review --extra "..."` 即兴附加指令
 * - `/end-review` 三选项收尾：自动 navigateTree 总结产出结构化修复清单
 *   注入主会话
 *
 * 用法：
 *   /review                  交互式选择
 *   /review uncommitted      未提交改动
 *   /review branch <名称>     相对某分支 / bookmark
 *   /review commit <提交ID>   某个提交 / jj change
 *   /review <路径 ...>        审查指定文件 / 目录（可用 @ 选择文件）
 *   /review mr <编号>         当前仓库的 GitLab MR（glab 取信息 + 临时 worktree）
 *   /review pr <编号>         当前仓库的 GitHub PR（gh 取信息 + 临时 worktree）
 *   /review status           查看当前审查状态
 *   /end-review              结束审查，三选项
 *
 * 项目级审查规范：在 .pi 目录所在的项目根放 REVIEW_GUIDELINES.md，内容会
 * 自动追加到审查提示词（boundary tag 自动剥离）。
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { notifyBeforePrompt } from "../notify/index.js";
import { selectModelForExtension } from "../../lib/model-selector.js";
import {
	buildReviewPrompt,
	REVIEW_FIX_FINDINGS_PROMPT,
	REVIEW_SUMMARY_PROMPT,
} from "./prompts.ts";
import {
	type ReviewTarget,
	type ReviewVcs,
	detectVCS,
	getCurrentBranch,
	getLocalBranches,
	getMergeBase,
	getRecentCommits,
	getSmartDefault,
	getTargetLabel,
	jjCurrentBookmarks,
} from "./vcs.ts";
import {
	cleanupMrWorktree,
	createMrWorktree,
	type MrProvider,
	type ReviewWorktree,
	prepareMrTarget,
} from "./pr.ts";
import { sanitizePromptBlock } from "./sanitize.ts";

// ─── 状态 ────────────────────────────────────────────────────────────────────

type ReviewSession = {
	originId: string | undefined;
	targetLabel: string;
	startedAtMs: number;
	completedTotalMs: number | undefined;
	preReviewModel: Model<Api> | null | undefined;
	// undefined = 未切换；null = 从“无模型”切换过来（还原时无需 setModel）
	worktree: ReviewWorktree | undefined;
};

let currentSession: ReviewSession | undefined;

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_COMMAND_DESCRIPTION =
	"审查代码改动。用法：/review [uncommitted | branch <名称> | commit <提交 ID> | mr <编号> | pr <编号> | status | <路径 ...>] [--extra \"...\"]";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
	targetLabel?: string;
	startedAtMs?: number;
	completedTotalMs?: number;
	worktreePath?: string;
	worktreeRef?: string;
};

// ─── 项目级审查规范 ──────────────────────────────────────────────────────────

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);
	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (!guidelineStats?.isFile()) return null;
			const content = await fs.readFile(guidelinesPath, "utf8").catch((err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") return null;
				throw err;
			});
			if (content === null) return null;
			return content.trim() || null;
		}
		const parent = path.dirname(currentDir);
		if (parent === currentDir) return null;
		currentDir = parent;
	}
}

// ─── 命令参数解析 ────────────────────────────────────────────────────────────

/** 按 shell 风格切分参数，保留单双引号内空格（让 --extra "..." 可用）。 */
type TokenizeResult = { ok: true; tokens: string[] } | { ok: false; error: string };

function tokenizeArgs(value: string): TokenizeResult {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < value.length; i++) {
		const char = value[i] ?? "";
		if (quote) {
			if (char === "\\" && i + 1 < value.length) {
				current += value[i + 1];
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) {
		return { ok: false, error: `未闭合的引号 (${quote})` };
	}
	if (current) tokens.push(current);
	return { ok: true, tokens };
}

type ParsedArgs = {
	/** 原始位置参数；文件 / 目录模式需要保留路径大小写。 */
	positional: string[];
	/** 小写后的首个位置参数；仅用于识别保留子命令。 */
	subcommand: string | null;
	rest: string[];
	extra: string | null;
	error: string | null;
};

function parseArgs(args: string | undefined): ParsedArgs {
	const trimmed = args?.trim() ?? "";
	if (!trimmed) return { positional: [], subcommand: null, rest: [], extra: null, error: null };
	const tokenizeResult = tokenizeArgs(trimmed);
	if (!tokenizeResult.ok) {
		return { positional: [], subcommand: null, rest: [], extra: null, error: tokenizeResult.error };
	}
	const tokens = tokenizeResult.tokens;
	const positional: string[] = [];
	let extra: string | null = null;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "--extra") {
			const next = tokens[i + 1];
			if (!next) return { positional: [], subcommand: null, rest: [], extra: null, error: "--extra 缺少参数" };
			extra = next;
			i += 1;
			continue;
		}
		if (token.startsWith("--extra=")) {
			extra = token.slice("--extra=".length);
			continue;
		}
		positional.push(token);
	}
	const [subcommand, ...rest] = positional;
	return { positional, subcommand: subcommand?.toLowerCase() ?? null, rest, extra, error: null };
}

const REVIEW_SUBCOMMANDS = new Set(["uncommitted", "branch", "commit", "mr", "pr", "status"]);

function isDirectFileTarget(parsed: ParsedArgs): boolean {
	return parsed.subcommand !== null && !REVIEW_SUBCOMMANDS.has(parsed.subcommand);
}

// ─── 审查目标解析 ────────────────────────────────────────────────────────────

async function resolveTargetFromArgs(
	pi: ExtensionAPI,
	parsed: ParsedArgs,
	ctx: ExtensionCommandContext,
): Promise<ReviewTarget | null> {
	const sub = parsed.subcommand;
	if (!sub) return resolveTargetInteractive(pi, ctx);

	switch (sub) {
		case "uncommitted":
			return { type: "uncommitted" };

		case "branch": {
			const branch = parsed.rest.join(" ").trim();
			if (!branch) {
				ctx.ui.notify("用法：/review branch <分支名称 或 jj bookmark>", "error");
				return null;
			}
			return { type: "baseBranch", branch };
		}

		case "commit": {
			const sha = parsed.rest[0]?.trim();
			if (!sha) {
				ctx.ui.notify("用法：/review commit <提交 ID>", "error");
				return null;
			}
			const title = parsed.rest.slice(1).join(" ").trim() || undefined;
			return { type: "commit", sha, title };
		}

		case "mr":
		case "pr": {
			const ref = parsed.rest[0]?.trim();
			if (!ref) {
				ctx.ui.notify(`用法：/review ${sub} <编号>`, "error");
				return null;
			}
			const providerOverride: MrProvider = sub === "mr" ? "glab" : "gh";
			return prepareMrTarget({
				pi,
				ref,
				providerOverride,
				onInfo: (msg) => ctx.ui.notify(msg, "info"),
				onError: (msg) => ctx.ui.notify(msg, "error"),
			});
		}

		default: {
			const paths = parsed.positional.map((p) => p.trim()).filter(Boolean);
			if (paths.length === 0) return null;
			return { type: "files", paths };
		}
	}
}

const PRESET_LABELS = {
	uncommitted: "当前未提交改动",
	baseBranch: "相对某个分支的改动",
	commit: "某个提交",
	mergeRequest: "Merge Request / Pull Request",
} as const;

type PresetKey = keyof typeof PRESET_LABELS;

async function resolveTargetInteractive(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<ReviewTarget | null> {
	const vcs = await detectVCS(pi);
	const smartDefault = await getSmartDefault(pi, vcs);
	const orderedKeys: PresetKey[] = (() => {
		const all: PresetKey[] = ["uncommitted", "baseBranch", "commit", "mergeRequest"];
		const fallback: Record<PresetKey, PresetKey> = {
			uncommitted: "uncommitted",
			baseBranch: "baseBranch",
			commit: "commit",
			mergeRequest: "mergeRequest",
		};
		const def = fallback[smartDefault as PresetKey] ?? "uncommitted";
		return [def, ...all.filter((k) => k !== def)];
	})();

	const choice = await notifyBeforePrompt("选择审查内容：", () =>
		ctx.ui.select("选择审查内容：", orderedKeys.map((k) => PRESET_LABELS[k])),
	);
	if (!choice) return null;

	const key = orderedKeys.find((k) => PRESET_LABELS[k] === choice) ?? "uncommitted";
	if (key === "uncommitted") return { type: "uncommitted" };
	if (key === "baseBranch") return resolveBaseBranchInteractive(pi, ctx, vcs);
	if (key === "commit") return resolveCommitInteractive(pi, ctx, vcs);
	return resolveMrInteractive(pi, ctx);
}

async function resolveBaseBranchInteractive(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	vcs: ReviewVcs,
): Promise<ReviewTarget | null> {
	if (vcs === "jj") {
		const [allRefs, currentBookmarks] = await Promise.all([
			getLocalBranches(pi, vcs),
			jjCurrentBookmarks(pi),
		]);
		const excluded = new Set(currentBookmarks);
		const others = allRefs.filter((b) => !excluded.has(b));
		if (others.length === 0) {
			ctx.ui.notify("没有其他可用 bookmark", "error");
			return null;
		}
		const branch = await notifyBeforePrompt("选择基础 bookmark：", () =>
			ctx.ui.select("选择基础 bookmark：", others),
		);
		if (!branch) return null;
		return { type: "baseBranch", branch };
	}
	const [allRefs, current] = await Promise.all([
		getLocalBranches(pi, vcs),
		getCurrentBranch(pi, vcs),
	]);
	const others = allRefs.filter((b) => b !== current);
	if (others.length === 0) {
		ctx.ui.notify("没有其他可用分支", "error");
		return null;
	}
	const branch = await notifyBeforePrompt("选择基础分支：", () =>
		ctx.ui.select("选择基础分支：", others),
	);
	if (!branch) return null;
	return { type: "baseBranch", branch };
}

async function resolveCommitInteractive(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	vcs: ReviewVcs,
): Promise<ReviewTarget | null> {
	const commits = await getRecentCommits(pi, vcs);
	if (commits.length === 0) {
		ctx.ui.notify("没有找到记录", "error");
		return null;
	}
	const labels = commits.map((c) => `${c.sha.slice(0, 7)}  ${c.title}`);
	const pick = await notifyBeforePrompt("选择提交 / jj change：", () =>
		ctx.ui.select("选择提交 / jj change：", labels),
	);
	if (!pick) return null;
	const shortSha = pick.trim().split(/\s+/)[0] ?? "";
	const commit = commits.find((c) => c.sha.startsWith(shortSha));
	return { type: "commit", sha: commit?.sha ?? shortSha, title: commit?.title };
}

async function resolveMrInteractive(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<ReviewTarget | null> {
	const ref = await notifyBeforePrompt(
		"输入 MR/PR 编号：",
		() => ctx.ui.editor("输入当前仓库中的 MR/PR 数字编号（例如 123）：", ""),
	);
	if (!ref?.trim()) return null;
	return prepareMrTarget({
		pi,
		ref: ref.trim(),
		onInfo: (msg) => ctx.ui.notify(msg, "info"),
		onError: (msg) => ctx.ui.notify(msg, "error"),
	});
}

// ─── 状态栏 ──────────────────────────────────────────────────────────────────

function setReviewWidget(ctx: ExtensionContext, label: string | undefined, isComplete: boolean): void {
	if (!ctx.hasUI) return;
	if (!label) {
		ctx.ui.setWidget("review", undefined);
		return;
	}
	const status = isComplete ? "📋 审查完成" : "📋 审查进行中";
	const message = `${status} · ${label}`;
	ctx.ui.setWidget("review", (_tui, theme) => ({
		render: (width: number) => [theme.fg("warning", message).slice(0, width)],
		invalidate: () => {},
	}));
}

function setReviewProgress(ctx: ExtensionContext, label: string, message: string): void {
	if (!ctx.hasUI) return;
	const text = `📋 ${message} · ${label}`;
	ctx.ui.setStatus("review", message);
	ctx.ui.setWidget("review", (_tui, theme) => ({
		render: (width: number) => [theme.fg("accent", text).slice(0, width)],
		invalidate: () => {},
	}));
}

function clearReviewProgress(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("review", undefined);
}

function clearReviewWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("review", undefined);
	clearReviewProgress(ctx);
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

function formatElapsed(startedAtMs: number, nowMs = Date.now()): string {
	const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatReviewStatus(): string {
	if (!currentSession) return "当前没有进行中的 review";
	const target = currentSession.targetLabel;
	if (currentSession.completedTotalMs !== undefined) {
		return `review 已完成：${target}，耗时 ${formatElapsed(0, currentSession.completedTotalMs)}`;
	}
	return `review 进行中：${target}，已运行 ${formatElapsed(currentSession.startedAtMs)}`;
}

// ─── 扩展入口 ────────────────────────────────────────────────────────────────

export default function reviewExtension(pi: ExtensionAPI): void {
	async function selectReviewModel(ctx: ExtensionCommandContext): Promise<Model<Api> | null> {
		return notifyBeforePrompt("选择审查模型：", () =>
			selectModelForExtension(ctx, {
				title: "选择审查模型",
				noModelsMessage: "当前没有可用模型，请先配置可用模型。",
			}),
		);
	}

	/**
	 * 仅实际执行模型切换（在调用者确信要启动审查之后用）。
	 * 返回跳转前的模型以供 /end-review 还原：
	 *   - undefined：选中的与当前一致，未产生切换，有还原
	 *   - null：原本无模型，已切过来（还原时 setModel(null) 会被跳过）
	 *   - Model：原模型，/end-review 时调 setModel 还原
	 * 返回中的 ok=false 表示切换本身失败。
	 */
	async function applyReviewModel(
		ctx: ExtensionCommandContext,
		selected: Model<Api>,
	): Promise<{ ok: true; preReviewModel: Model<Api> | null | undefined } | { ok: false }> {
		if (ctx.model && selected.provider === ctx.model.provider && selected.id === ctx.model.id) {
			return { ok: true, preReviewModel: undefined };
		}
		const pre: Model<Api> | null = ctx.model ?? null;
		const success = await pi.setModel(selected);
		if (!success) {
			ctx.ui.notify(`无法切换到 ${selected.provider}/${selected.id}：模型未配置可用凭据`, "error");
			return { ok: false };
		}
		return { ok: true, preReviewModel: pre };
	}

	function persistState(snapshot: ReviewSessionState): void {
		pi.appendEntry(REVIEW_STATE_TYPE, snapshot);
	}

	async function cleanupReviewWorktree(ctx: ExtensionContext, worktree: ReviewWorktree | undefined): Promise<void> {
		if (!worktree) return;
		const errors = await cleanupMrWorktree(pi, worktree);
		if (errors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`临时 worktree 清理失败：${errors[0]}`, "warning");
		}
	}

	async function navigateBackAfterFailedStart(ctx: ExtensionCommandContext, originId: string | undefined): Promise<void> {
		if (!originId) return;
		try {
			await ctx.navigateTree(originId, { summarize: false });
		} catch (error) {
			ctx.ui.notify(
				`审查启动失败，且自动返回原会话位置失败：${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	async function startReviewSession(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		extraInstruction: string | null,
	): Promise<void> {
		if (currentSession) {
			ctx.ui.notify(
				"已有 review 进行中。用 /review status 查看进度，或用 /end-review 结束当前审查。",
				"warning",
			);
			return;
		}

		// 用 getBranch() 而非 getEntries()：前者是当前活动分支的线性路径（不含其它并存分支），
		// 后者是整棵会话树的所有节点，可能返回别的分支上的陈旧用户消息。
		const branchEntries = ctx.sessionManager.getBranch();

		// 可取消 且 无副作用：选择模型（仅选择，不 setModel）。
		const selectedModel = await selectReviewModel(ctx);
		if (!selectedModel) return;

		const vcs = target.type === "files" ? "git" : await detectVCS(pi);
		// gh/glab 信息获取配合 git worktree；MR/PR 的 diff 提示强制走 git，
		// 避免 jj 仓库里生成错误的 `jj diff` 命令。
		const promptVcs: ReviewVcs = target.type === "mergeRequest" ? "git" : vcs;
		const targetLabel = getTargetLabel(target, vcs);
		const startedAtMs = Date.now();
		let reviewTarget = target;
		let reviewWorktree: ReviewWorktree | undefined;

		// 记录返回点：当前叶节点。分叉后会从首条用户消息处创建兄弟分支，
		// /end-review 时 navigateTree 回原叶节点，把审查分支总结成一条提示
		// 插入主分支。
		const originId = ctx.sessionManager.getLeafId() ?? undefined;

		// 副作用 1 / 3：若为 MR 目标，创建临时 worktree。不会切换当前仓库分支。
		// 顺序上放在模型选择后：避免用户选模型时取消，却已创建临时目录。
		if (target.type === "mergeRequest") {
			const worktree = await createMrWorktree({
				pi,
				target,
				onInfo: (msg) => ctx.ui.notify(msg, "info"),
				onError: (msg) => ctx.ui.notify(msg, "error"),
			});
			if (!worktree) return;
			reviewWorktree = worktree;
			reviewTarget = { ...target, worktreePath: worktree.path, worktreeRef: worktree.ref };
		}

		// 副作用 2 / 3：查找首条用户消息作为分叉错位点。Mitsuhiko 式“全新分叉”：
		// navigateTree 到首条用户消息后，叶节点进到其父节点（null 或 system
		// 消息之后），下一条 sendUserMessage 作为首条用户消息的兄弟产生，
		// 形成与主对话并列的干净审查分支。
		//
		// 取消 / 报错都在创建临时 worktree 之后发生；这里显式清理临时资源。
		const firstUserMessage = branchEntries.find(
			(e) => e.type === "message" && e.message.role === "user",
		);
		if (firstUserMessage) {
			try {
				const result = await ctx.navigateTree(firstUserMessage.id, {
					summarize: false,
					label: "code-review",
				});
				if (result.cancelled) {
					await cleanupReviewWorktree(ctx, reviewWorktree);
					ctx.ui.notify("审查启动取消。", "info");
					return;
				}
			} catch (error) {
				await cleanupReviewWorktree(ctx, reviewWorktree);
				ctx.ui.notify(
					`创建审查分支失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			// navigateTree 到用户消息后，输入框会被回填该消息文本，
			// 这里清掉避免干扰接下来的 sendUserMessage。
			if (ctx.hasUI) ctx.ui.setEditorText("");
		}
		// 若会话尚无用户消息（刚创建），不 navigateTree，直接把当前分支当作
		// 审查分支使用。

		// 副作用 3 / 3：切换到审查模型。放在最后一步：任何上面的取消 / 失败
		// 都不会遗留 “模型已切但审查未启动” 的孤儿状态。
		const applyResult = await applyReviewModel(ctx, selectedModel);
		if (!applyResult.ok) {
			await cleanupReviewWorktree(ctx, reviewWorktree);
			await navigateBackAfterFailedStart(ctx, originId);
			return;
		}

		currentSession = {
			originId,
			targetLabel,
			startedAtMs,
			completedTotalMs: undefined,
			preReviewModel: applyResult.preReviewModel,
			worktree: reviewWorktree,
		};

		persistState({
			active: true,
			originId,
			targetLabel,
			startedAtMs,
			worktreePath: reviewWorktree?.path,
			worktreeRef: reviewWorktree?.ref,
		});

		setReviewWidget(ctx, targetLabel, false);

		try {
			const mergeBase = reviewTarget.type === "baseBranch"
				? await getMergeBase(pi, promptVcs, reviewTarget.branch)
				: null;

			const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

			const prompt = buildReviewPrompt({
				target: reviewTarget,
				vcs: promptVcs,
				mergeBase,
				projectGuidelines,
				extraInstruction,
			});

			ctx.ui.notify(`开始审查：${targetLabel}`, "info");
			pi.sendUserMessage(prompt);
		} catch (error) {
			// session 已进入进行中状态（currentSession 已赋値、worktree 已创建、模型已切换），
			// 任何后续失败（如 loadProjectReviewGuidelines EACCES）必须回滚全部副作用，
			// 否则 session 永远卡在“进行中”且无法通过 /end-review 恢复。
			ctx.ui.notify(
				`审查启动失败：${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			await finalizeReviewState(ctx);
		}
	}

	// ─── /end-review 结束审查 ────────────────────────────────────────────

	type EndReviewAction = "returnOnly" | "returnAndSummarize" | "returnAndFix";

	async function navigateBack(
		ctx: ExtensionCommandContext,
		originId: string,
		summarize: boolean,
	): Promise<{ ok: boolean; cancelled: boolean }> {
		try {
			const result = await ctx.navigateTree(originId, summarize ? {
				summarize: true,
				customInstructions: REVIEW_SUMMARY_PROMPT,
				replaceInstructions: true,
				label: "code-review",
			} : { summarize: false });
			return { ok: !result.cancelled, cancelled: result.cancelled };
		} catch (error) {
			ctx.ui.notify(
				`返回失败：${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { ok: false, cancelled: false };
		}
	}

	async function executeEndReview(
		ctx: ExtensionCommandContext,
		action: EndReviewAction,
	): Promise<void> {
		if (!currentSession) {
			ctx.ui.notify("当前没有进行中的审查", "info");
			return;
		}
		if (!currentSession.originId) {
			// 没有返回点，仅清理状态
			await finalizeReviewState(ctx);
			ctx.ui.notify("审查状态已清理（没有可返回的位置）。", "info");
			return;
		}

		const session = currentSession;
		const originId = session.originId!;
		const summarize = action !== "returnOnly";
		const progressMessage = action === "returnOnly"
			? "正在返回主会话"
			: action === "returnAndSummarize"
				? "正在总结审查分支并返回主会话"
				: "正在总结审查分支，随后自动触发修复";
		ctx.ui.notify(`${progressMessage}，请稍候...`, "info");
		setReviewProgress(ctx, session.targetLabel, progressMessage);

		const result = await navigateBack(ctx, originId, summarize);
		if (!result.ok) {
			clearReviewProgress(ctx);
			if (session) {
				setReviewWidget(ctx, session.targetLabel, session.completedTotalMs !== undefined);
			}
			if (result.cancelled) {
				ctx.ui.notify("已取消。再次运行 /end-review 可重试。", "info");
			} else {
				ctx.ui.notify("返回失败，可再次运行 /end-review 重试。", "warning");
			}
			return;
		}

		await finalizeReviewState(ctx);

		switch (action) {
			case "returnOnly":
				ctx.ui.notify("审查结束，已返回主会话（未保留审查内容）。", "info");
				return;
			case "returnAndSummarize":
				ctx.ui.notify("审查结束，已返回并注入结构化交接。", "info");
				return;
			case "returnAndFix":
				pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
				ctx.ui.notify("审查结束，已返回并自动触发修复。", "info");
				return;
		}
	}

	async function finalizeReviewState(ctx: ExtensionContext): Promise<void> {
		const session = currentSession;
		currentSession = undefined;
		clearReviewWidget(ctx);
		persistState({ active: false });
		await cleanupReviewWorktree(ctx, session?.worktree);
		if (session?.preReviewModel) {
			const restored = await pi.setModel(session.preReviewModel);
			if (!restored && ctx.hasUI) {
				ctx.ui.notify("审查模型还原失败，请手动切换回之前的模型。", "warning");
			}
		}
	}

	async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
		if (!currentSession) {
			ctx.ui.notify("当前没有进行中的审查", "info");
			return;
		}
		if (!ctx.hasUI) {
			// 非交互模式：默认仅返回
			await executeEndReview(ctx, "returnOnly");
			return;
		}
		const choice = await notifyBeforePrompt("结束审查：", () =>
			ctx.ui.select("结束审查：", [
				"仅返回",
				"返回并总结",
				"返回并修复",
			]),
		);
		if (!choice) {
			ctx.ui.notify("已取消。再次运行 /end-review 可重试。", "info");
			return;
		}
		const action: EndReviewAction = choice === "返回并修复"
			? "returnAndFix"
			: choice === "返回并总结"
				? "returnAndSummarize"
				: "returnOnly";
		await executeEndReview(ctx, action);
	}

	// ─── 命令注册 ──────────────────────────────────────────────────────

	pi.registerCommand("review", {
		description: REVIEW_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			if (parsed.subcommand === "status") {
				ctx.ui.notify(formatReviewStatus(), currentSession ? "info" : "warning");
				return;
			}

			// 直接传路径时不依赖 VCS，跳过仓库检查；交互式 / VCS 目标仍需在仓库中运行。
			if (!isDirectFileTarget(parsed)) {
				// 仓库前置检查：git 与 jj 都不在就不要启动昂贵的审查模型
				const [gitCheck, jjCheck] = await Promise.all([
					pi.exec("git", ["rev-parse", "--git-dir"]),
					pi.exec("jj", ["--ignore-working-copy", "root"]),
				]);
				if (gitCheck.code !== 0 && jjCheck.code !== 0) {
					ctx.ui.notify("当前目录不是 git / jj 仓库，无法运行审查。", "error");
					return;
				}
			}

			const target = await resolveTargetFromArgs(pi, parsed, ctx);
			if (!target) return;

			const sanitizedExtra = parsed.extra ? sanitizePromptBlock(parsed.extra) || null : null;
			await startReviewSession(ctx, target, sanitizedExtra);
		},
	});

	pi.registerCommand("end-review", {
		description: "结束代码审查并返回主会话。三选项：仅返回 / 返回并总结 / 返回并修复",
		handler: async (_args, ctx) => {
			await runEndReview(ctx);
		},
	});

	// ─── 生命周期钩子 ────────────────────────────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		await finalizeReviewState(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!currentSession || !ctx.hasUI) return;
		// 模型跑完时记入总耗时，仅给状态栏用
		if (currentSession.completedTotalMs === undefined) {
			currentSession.completedTotalMs = Date.now() - currentSession.startedAtMs;
			persistState({
				active: true,
				originId: currentSession.originId,
				targetLabel: currentSession.targetLabel,
				startedAtMs: currentSession.startedAtMs,
				completedTotalMs: currentSession.completedTotalMs,
				worktreePath: currentSession.worktree?.path,
				worktreeRef: currentSession.worktree?.ref,
			});
			setReviewWidget(ctx, currentSession.targetLabel, true);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		let lastState: ReviewSessionState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
				lastState = entry.data as ReviewSessionState;
			}
		}
		// 仅在 originId 仍能在当前会话树中找到时才复活。
		// 避免崩溃 / 退出后状态留下但 originId 已无效，导致 navigateTree 抛错。
		const originStillExists = lastState?.originId
			? Boolean(ctx.sessionManager.getEntry(lastState.originId))
			: false;
		const worktreeStillExists = lastState?.worktreePath
			? Boolean(await fs.stat(lastState.worktreePath).catch(() => null))
			: true;
		if (lastState?.active && lastState.originId && originStillExists && worktreeStillExists) {
			currentSession = {
				originId: lastState.originId,
				targetLabel: lastState.targetLabel ?? "未知目标",
				startedAtMs: lastState.startedAtMs ?? Date.now(),
				completedTotalMs: lastState.completedTotalMs,
				preReviewModel: undefined,
				worktree: lastState.worktreePath && lastState.worktreeRef
					? { path: lastState.worktreePath, ref: lastState.worktreeRef }
					: undefined,
			};
			setReviewWidget(ctx, currentSession.targetLabel, currentSession.completedTotalMs !== undefined);
		} else {
			currentSession = undefined;
			clearReviewWidget(ctx);
			if (lastState?.active) {
				// 孤立资源清理：worktree 已不存在或 origin 失效，best-effort 全幹掉临时资源
				if (lastState.worktreeRef) {
					await pi.exec("git", ["update-ref", "-d", lastState.worktreeRef]).catch(() => undefined);
				}
				if (lastState.worktreePath) {
					await pi.exec("git", ["worktree", "remove", "--force", lastState.worktreePath]).catch(() => undefined);
					await fs.rm(path.dirname(lastState.worktreePath), { recursive: true, force: true }).catch(() => undefined);
				}
				// 顺手写一条 inactive 状态，避免下次启动反复检查
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false } satisfies ReviewSessionState);
			}
		}
	});
}
