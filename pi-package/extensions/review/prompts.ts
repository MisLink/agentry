/**
 * 审查提示词：每个审查目标的指令、`/end-review` 用的总结提示词、
 * “返回并修复”流程触发的修复提示词。
 *
 * 中文输出约定：
 *   - 评审项使用 [P0]..[P3] 优先级标签
 *   - 结论三选一：通过，有备注 / 小问题 / 重大疑虑
 *   - 末尾必须附 “## 非阻塞人工审查提示”
 */
import type { ReviewTarget, ReviewVcs } from "./vcs.ts";
import { buildDiffPromptHint, getTargetLabel } from "./vcs.ts";
import { sanitizePromptInput, sanitizePromptBlock } from "./sanitize.ts";
import { buildNoiseGuidance } from "./noise.ts";
import { REVIEW_RUBRIC } from "./rubric.ts";

export type BuildReviewPromptInput = {
	target: ReviewTarget;
	vcs: ReviewVcs;
	mergeBase?: string | null;
	projectGuidelines?: string | null;
	extraInstruction?: string | null;
};

const LANGUAGE_INSTRUCTION = [
	"输出语言：中文。所有评审项、结论和提示一律使用中文。",
	"使用以下中文小节标题：",
	"## 问题",
	"## 结论",
	"## 非阻塞人工审查提示",
	"结论必须是下列之一（不要英文）：",
	"- 通过，有备注",
	"- 小问题",
	"- 重大疑虑",
].join("\n");

function buildPerTargetInstruction(target: ReviewTarget, vcs: ReviewVcs, mergeBase: string | null | undefined): string {
	const label = sanitizePromptInput(getTargetLabel(target, vcs));
	const hint = buildDiffPromptHint(target, vcs, mergeBase);

	switch (target.type) {
		case "uncommitted":
		case "baseBranch":
		case "commit":
		case "files":
			return `审查目标：${label}。${hint} 请按优先级列出具体、可执行的评审项。`;
		case "mergeRequest": {
			const kind = target.provider === "glab" ? "Merge Request" : "Pull Request";
			const symbol = target.provider === "glab" ? "!" : "#";
			const sanitizedTitle = sanitizePromptInput(target.title);
			const sanitizedBase = sanitizePromptInput(target.baseBranch);
			const sanitizedSource = sanitizePromptInput(target.sourceBranch);
			const worktreePath = target.worktreePath ? sanitizePromptInput(target.worktreePath) : null;
			const location = worktreePath
				? `已为源分支 '${sanitizedSource}' 准备临时 worktree：${worktreePath}。不要假设当前工作区已经切到该分支；运行命令时使用下方提示中的 \`git -C ...\` 命令，读取文件时读取该目录下的对应路径。`
				: `当前工作区已切到源分支 '${sanitizedSource}'，目标分支为 '${sanitizedBase}'。`;
			return [
				`审查目标：${kind} ${symbol}${target.id}（“${sanitizedTitle}”），目标分支为 '${sanitizedBase}'。`,
				location,
				hint,
				"请按优先级列出具体、可执行的评审项。",
			].join(" ");
		}
	}
}

export function buildReviewPrompt(input: BuildReviewPromptInput): string {
	const sections: string[] = [REVIEW_RUBRIC];

	const projectGuidelines = input.projectGuidelines ? sanitizePromptBlock(input.projectGuidelines) : null;
	if (projectGuidelines) {
		sections.push(`## 项目专属审查规范\n\n${projectGuidelines}`);
	}

	sections.push(buildNoiseGuidance());
	sections.push(LANGUAGE_INSTRUCTION);
	sections.push(buildPerTargetInstruction(input.target, input.vcs, input.mergeBase));

	const extra = input.extraInstruction ? sanitizePromptBlock(input.extraInstruction) : null;
	if (extra) {
		sections.push(`## 本次额外要求\n\n${extra}`);
	}

	return sections.join("\n\n---\n\n");
}

/**
 * 用于 navigateTree({ summarize: true }) 的自定义指令。强制把审查分支
 * 的全部内容压缩成一份结构化交接文档，让主会话拿到后可以直接照着修。
 */
export const REVIEW_SUMMARY_PROMPT = `这是一段代码审查分支的总结任务。我们正要离开审查分支回到主开发分支，请把本分支内的审查结果压缩成一份**结构化交接文档**，保留所有可执行的评审项，便于下一步直接修复。

**严格按下列结构输出**（顺序固定，无内容写"（无）"或"- 无"）：

## 审查范围
- 审查目标（文件、路径、改动范围、提交或 MR 编号等）

## 结论
- 通过，有备注 / 小问题 / 重大疑虑（三选一）

## 问题列表（按优先级排序）
对每条评审项给出：
- 优先级 [P0]..[P3] + 一句话标题
- 文件位置 \`path/to/file.ext:line\`
- 为什么这是问题（一句话）
- 应该如何修改（一句话，可执行）

## 修复清单
1. 按优先级（P0 → P1 → P2 → 可选 P3）的顺序给一份执行清单，便于直接照着修

## 用户偏好与约束
- 审查过程中作者明确提到的偏好、约束或不修决定
- 没有则写"- 无"

## 非阻塞人工审查提示
仅列适用项（不要写"yes/no"判断行）：
- **此改动包含数据库迁移：** <文件 / 细节>
- **此改动引入了新依赖：** <package / 细节>
- **此改动修改了依赖或 lockfile：** <文件 / 细节>
- **此改动修改了认证或授权逻辑：** <改动与位置>
- **此改动引入了不向后兼容的 schema / API / 契约变化：** <改动与位置>
- **此改动包含不可逆或破坏性操作：** <操作与范围>

如全部不适用写"- 无"。

要求：
- 不省略任何评审项，每条都要保留。
- 文件路径、函数名、错误字符串保持原样不要改写。
- 思考过程、引用的代码片段、复述的审查准则全部省略。`;

/**
 * 用户在 /end-review 选择“返回并修复”时，navigateTree summarize 完成后
 * 自动作为 followUp 投递给主会话的修复指令。
 */
export const REVIEW_FIX_FINDINGS_PROMPT = `请按上一条审查交接文档（含问题列表与修复清单）实施修复。

要求：
1. 把修复清单当作执行清单，按 P0 → P1 → P2 顺序修；P3 项简单且安全就顺手修，否则跳过并说明原因。
2. 若某条评审项已不存在 / 已修复 / 当前不适合修，简要说明原因并继续下一条。
3. "非阻塞人工审查提示"仅供参考，不要把它当作修复任务，除非另有独立评审项指向同一处。
4. 错误处理坚持快速失败原则：除非当前作用域本身是明确的边界处理层，否则不要新增本地 try/catch 兜底降级；JSON 解析等失败默认应显式暴露。
5. 修改触及的代码顺手跑相关测试或类型检查。
6. 最后给出三段：已修项 / 跳过或延后项（含原因）/ 验证结果。`;
