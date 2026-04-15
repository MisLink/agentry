import type { PlanStep } from "./utils.ts";

export interface PlanStepDraft {
	text: string;
	detail: string;
}

export interface AutoPlanDecisionInput {
	prompt: string;
	steps: readonly PlanStepDraft[];
	hasActivePlan: boolean;
}

export interface AutoPlanDecision {
	allow: boolean;
	reason: "explicit-request" | "complex-task" | "straightforward-task" | "not-complex-enough";
	score: number;
	signals: string[];
}

const EXPLICIT_PLAN_PATTERNS = [
	/\bplan\b/i,
	/step by step/i,
	/roadmap/i,
	/分步骤/u,
	/一步步/u,
	/按步骤/u,
	/执行计划/u,
	/先分析/u,
	/先规划/u,
	/规划一下/u,
	/先别.*改代码/u,
	/先别.*写代码/u,
	/先不.*改代码/u,
	/先不.*写代码/u,
	/先想想.*怎么/u,
	/给.*方案/u,
	/制定.*计划/u,
];

const PLANNING_HINT_PATTERNS = [
	/方案/u,
	/思路/u,
	/怎么做/u,
	/怎么改/u,
	/怎么推进/u,
	/怎么更合适/u,
	/怎么比较合适/u,
	/先.*再/u,
	/拆成.*步/u,
	/分成.*步/u,
];

const STRONG_STRAIGHTFORWARD_PATTERNS = [
	/\bsmall\b/i,
	/\bminor\b/i,
	/\bquick\b/i,
	/\btrivial\b/i,
	/\btypo\b/i,
	/单文件/u,
	/小\s*bug/u,
	/文案/u,
	/if 判断/u,
];

const WEAK_STRAIGHTFORWARD_PATTERNS = [
	/改一下/u,
	/顺手/u,
	/处理一下/u,
	/修一下/u,
	/调一下/u,
	/调整/u,
	/改改/u,
	/顺便/u,
];

const COMPLEXITY_PATTERNS = [
	/\brefactor\b/i,
	/\bmigration\b/i,
	/\brestructure\b/i,
	/\bworkflow\b/i,
	/\bcompat/i,
	/重构/u,
	/迁移/u,
	/架构/u,
	/拆分/u,
	/模块/u,
	/兼容/u,
	/排查/u,
	/链路/u,
];

const SCOPE_PATTERNS = {
	tooling: [/\bplugin\b/i, /\bextension\b/i, /\bcommand\b/i, /\bsession\b/i, /\bskill\b/i, /插件/u, /扩展/u, /命令/u, /session/u, /skill/u],
	code: [/\bmodule\b/i, /\bservice\b/i, /\bmiddleware\b/i, /\bapi\b/i, /模块/u, /服务/u, /中间件/u, /接口/u, /流程/u],
	ui: [/\bui\b/i, /\bfrontend\b/i, /前端/u],
	backend: [/\bbackend\b/i, /后端/u, /数据库/u],
	config: [/\bconfig\b/i, /配置/u],
	tests: [/\btest\b/i, /\bverify\b/i, /\bvalidate\b/i, /测试/u, /验证/u, /回归/u],
	docs: [/\bdoc/i, /\breadme\b/i, /文档/u, /说明/u],
	files: [/\bfile\b/i, /\bproject\b/i, /文件/u, /项目/u],
} as const;

const ANALYSIS_PATTERNS = [/\binspect\b/i, /\bread\b/i, /\banaly[sz]e\b/i, /检查/u, /分析/u, /定位/u, /排查/u, /阅读/u];
const IMPLEMENT_PATTERNS = [/\bedit\b/i, /\bchange\b/i, /\bimplement\b/i, /\brefactor\b/i, /修改/u, /实现/u, /重构/u, /拆分/u, /更新/u];
const VERIFY_PATTERNS = [/\btest\b/i, /\bverify\b/i, /\bvalidate\b/i, /\bcheck\b/i, /测试/u, /验证/u, /回归/u, /确认/u];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function collectPhases(prompt: string, steps: readonly PlanStepDraft[]): Set<string> {
	const phases = new Set<string>();
	const texts = [prompt, ...steps.map((step) => `${step.text}\n${step.detail}`)];
	for (const text of texts) {
		if (matchesAny(text, ANALYSIS_PATTERNS)) phases.add("analysis");
		if (matchesAny(text, IMPLEMENT_PATTERNS)) phases.add("implement");
		if (matchesAny(text, VERIFY_PATTERNS)) phases.add("verify");
	}
	return phases;
}

function collectScopeCategories(text: string): Set<string> {
	const scopes = new Set<string>();
	for (const [name, patterns] of Object.entries(SCOPE_PATTERNS)) {
		if (matchesAny(text, patterns)) scopes.add(name);
	}
	return scopes;
}

function cloneStep(step: PlanStep, stepNumber: number): PlanStep {
	return {
		step: stepNumber,
		text: step.text,
		detail: step.detail,
		completed: step.completed,
		summary: step.summary,
		completedAt: step.completedAt,
	};
}

function materializeDraft(step: PlanStepDraft, stepNumber: number): PlanStep {
	return {
		step: stepNumber,
		text: step.text.slice(0, 60),
		detail: step.detail,
		completed: false,
	};
}

export function shouldAutoPlan(input: AutoPlanDecisionInput): AutoPlanDecision {
	const prompt = input.prompt.trim();
	if (matchesAny(prompt, EXPLICIT_PLAN_PATTERNS)) {
		return { allow: true, reason: "explicit-request", score: 100, signals: ["explicit-request"] };
	}

	const signals: string[] = [];
	let score = 0;

	if (input.steps.length >= 3) {
		score += 1;
		signals.push("three-plus-steps");
	}
	if (input.steps.length >= 4) {
		score += 1;
		signals.push("four-plus-steps");
	}
	if (matchesAny(prompt, COMPLEXITY_PATTERNS)) {
		score += 1;
		signals.push("complex-keywords");
	}
	if (matchesAny(prompt, PLANNING_HINT_PATTERNS)) {
		score += 1;
		signals.push("planning-hints");
	}

	const phases = collectPhases(prompt, input.steps);
	if (phases.size >= 3) {
		score += 1;
		signals.push("multi-phase");
	}

	const combined = `${prompt}\n${input.steps.map((step) => `${step.text}\n${step.detail}`).join("\n")}`;
	const scopes = collectScopeCategories(combined);
	if (scopes.size >= 2) {
		score += 1;
		signals.push("cross-scope");
	}
	if (scopes.size >= 3) {
		score += 1;
		signals.push("multi-scope");
	}

	const hasStrongStraightforward = matchesAny(prompt, STRONG_STRAIGHTFORWARD_PATTERNS);
	const hasWeakStraightforward = matchesAny(prompt, WEAK_STRAIGHTFORWARD_PATTERNS);
	if (hasStrongStraightforward) {
		score -= 2;
		signals.push("strong-straightforward-wording");
	}
	if (hasWeakStraightforward) {
		score -= 1;
		signals.push("weak-straightforward-wording");
	}

	if (score >= 2) {
		return { allow: true, reason: "complex-task", score, signals };
	}

	if (hasStrongStraightforward || (hasWeakStraightforward && score <= 0)) {
		return { allow: false, reason: "straightforward-task", score, signals };
	}

	return { allow: false, reason: "not-complex-enough", score, signals };
}

export function getTrackingExecutionOptions(_isRefine: boolean): string[] {
	return ["逐步执行（每步暂停确认）", "一次性运行全部", "忽略"];
}

export function insertPlanStepsAfterCurrent(existingSteps: readonly PlanStep[], newSteps: readonly PlanStepDraft[]): PlanStep[] {
	const currentIndex = existingSteps.findIndex((step) => !step.completed);
	const keepUntil = currentIndex === -1 ? existingSteps.length : currentIndex + 1;
	const merged: PlanStep[] = existingSteps.slice(0, keepUntil).map((step, index) => cloneStep(step, index + 1));

	for (const draft of newSteps) {
		merged.push(materializeDraft(draft, merged.length + 1));
	}
	for (const step of existingSteps.slice(keepUntil)) {
		merged.push(cloneStep(step, merged.length + 1));
	}
	return merged;
}

export function replaceRemainingSteps(existingSteps: readonly PlanStep[], newSteps: readonly PlanStepDraft[]): PlanStep[] {
	const merged = existingSteps
		.filter((step) => step.completed)
		.map((step, index) => cloneStep(step, index + 1));
	for (const draft of newSteps) {
		merged.push(materializeDraft(draft, merged.length + 1));
	}
	return merged;
}

export function filterPlanTrackerContextMessages<T extends { customType?: string }>(messages: readonly T[], hasActivePlan: boolean): T[] {
	let lastContextIndex = -1;
	if (hasActivePlan) {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i]?.customType === "plan-tracker-context") {
				lastContextIndex = i;
				break;
			}
		}
	}

	return messages.filter((message, index) => {
		if (message.customType !== "plan-tracker-context") return true;
		if (!hasActivePlan) return false;
		return index === lastContextIndex;
	});
}
