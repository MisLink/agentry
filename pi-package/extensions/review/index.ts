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

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

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

const REVIEW_STATE_TYPE = "review-session";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
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

async function buildReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
	const vcs = await detectVCS(pi);

	if (vcs === "jj") {
		switch (target.type) {
			case "uncommitted":
				return "审查当前代码改动。使用 `jj status` 和 `jj diff` 获取改动内容，提供带优先级的 findings。";

			case "baseBranch": {
				const ref = target.branch;
				const mergeBaseRevset = `heads(::@ & ::${ref})`;
				return `审查相对于 '${ref}' 的代码改动。先用 \`jj log -r '${mergeBaseRevset}' --no-graph\` 确认共同祖先，再运行 \`jj diff --from '${mergeBaseRevset}' --to @\` 查看相对于共同祖先的改动，提供带优先级的可操作 findings。`;
			}

			case "commit": {
				const short = target.sha.slice(0, 8);
				if (target.title) {
					return `审查 change ${short}（"${target.title}"）引入的代码改动。运行 \`jj --ignore-working-copy diff -r ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`;
				}
				return `审查 change ${short} 引入的代码改动。运行 \`jj --ignore-working-copy diff -r ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`;
			}
		}
	}

	// Git path
	switch (target.type) {
		case "uncommitted":
			return "审查当前代码改动（已暂存、未暂存和未追踪的文件）。使用 `git status --porcelain`、`git diff`、`git diff --staged` 获取改动内容，提供带优先级的 findings。";

		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				return `审查相对于基础分支 '${target.branch}' 的代码改动。本次比较的 merge base commit 为 ${mergeBase}。运行 \`git diff ${mergeBase}\` 查看相对于 ${target.branch} 的改动，提供带优先级的可操作 findings。`;
			}
			return `审查相对于基础分支 '${target.branch}' 的代码改动。先用 \`git merge-base HEAD ${target.branch}\` 找到 merge base，再运行 \`git diff <merge-base>\` 查看改动，提供带优先级的可操作 findings。`;
		}

		case "commit": {
			const short = target.sha.slice(0, 8);
			if (target.title) {
				return `审查 commit ${short}（"${target.title}"）引入的代码改动。运行 \`git show ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`;
			}
			return `审查 commit ${short} 引入的代码改动。运行 \`git show ${target.sha}\` 查看改动内容，提供带优先级的可操作 findings。`;
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

	function setReviewWidget(ctx: ExtensionContext, active: boolean): void {
		if (!ctx.hasUI) return;
		if (!active) {
			ctx.ui.setWidget("review", undefined);
			return;
		}
		ctx.ui.setWidget("review", (_tui, theme) => ({
			render: (width: number) => {
				const msg = theme.fg("warning", "📋 审查进行中  •  /end-review 返回主 session");
				return [msg.slice(0, width)];
			},
			invalidate: () => {},
		}));
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
		const choice = await ctx.ui.select("选择审查内容：", [
			"当前未提交改动",
			"相对某个分支的改动",
			"某个 commit",
		]);
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
				const branch = await ctx.ui.select("选择基础分支：", others);
				if (!branch) return null;
				return { type: "baseBranch", branch };
			}

			const [allRefs, currentRef] = await Promise.all([
				getLocalBranches(pi),
				getCurrentBranch(pi),
			]);
			const others = allRefs.filter((b) => b !== currentRef);
			if (others.length === 0) { ctx.ui.notify("没有其他可用分支/bookmark", "error"); return null; }
			const branch = await ctx.ui.select("选择基础分支：", others);
			if (!branch) return null;
			return { type: "baseBranch", branch };
		}

		if (choice === "某个 commit") {
			const commits = await getRecentCommits(pi);
			if (commits.length === 0) { ctx.ui.notify("没有找到记录", "error"); return null; }
			const commitChoice = await ctx.ui.select(
				"选择：",
				commits.map((c) => `${c.sha.slice(0, 7)}  ${c.title}`),
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

			// Persist state so it survives session resume
			pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: reviewOriginId } satisfies ReviewSessionState);

			const vcs = await detectVCS(pi);
			const label = getTargetLabel(target, vcs);

			setReviewWidget(ctx, true);

			const prompt = await buildReviewPrompt(pi, target);
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
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false } satisfies ReviewSessionState);
			setReviewWidget(ctx, false);
			await ctx.navigateTree(originId);
		},
	});

	// ── Event hooks ───────────────────────────────────────────────────────────

	/** Inject rubric before every LLM turn while a review is active. */
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!reviewOriginId) return;

		const guidelines = await loadProjectReviewGuidelines(ctx.cwd);
		const rubricText = guidelines
			? `${REVIEW_RUBRIC}\n\n---\n\n## 项目特定审查规范\n\n${guidelines}`
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
	pi.on("agent_end", async (_event, ctx) => {
		if (!reviewOriginId || !ctx.hasUI) return;

		const choice = await ctx.ui.select("审查完成，下一步？", [
			"修复问题（继续在当前 branch 操作）",
			"返回主 session（/end-review）",
		]);

		if (choice?.startsWith("修复")) {
			pi.sendUserMessage(
				"请修复上述审查中发现的所有 P0、P1、P2 问题。每修复一个问题后简要说明改了什么。",
			);
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
			setReviewWidget(ctx, true);
		} else {
			reviewOriginId = undefined;
			setReviewWidget(ctx, false);
		}
	});
}
