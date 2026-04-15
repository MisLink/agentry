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
	/执行计划/u,
	/先分析/u,
	/先规划/u,
	/规划一下/u,
	/给.*方案/u,
	/制定.*计划/u,
];

const STRAIGHTFORWARD_PATTERNS = [
	/\bsmall\b/i,
	/\bminor\b/i,
	/\bquick\b/i,
	/\btrivial\b/i,
	/\btypo\b/i,
	/单文件/u,
	/小\s*bug/u,
	/小修/u,
	/小改/u,
	/改一下/u,
	/顺手/u,
	/文案/u,
	/配置/u,
	/if 判断/u,
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

const CROSS_SCOPE_PATTERNS = [
	/\bmodule\b/i,
	/\bservice\b/i,
	/\bmiddleware\b/i,
	/\bapi\b/i,
	/\bui\b/i,
	/\btest\b/i,
	/模块/u,
	/服务/u,
	/中间件/u,
	/接口/u,
	/前端/u,
	/后端/u,
	/测试/u,
	/数据库/u,
];

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

	if (matchesAny(prompt, STRAIGHTFORWARD_PATTERNS)) {
		return { allow: false, reason: "straightforward-task", score: 0, signals: ["straightforward-task"] };
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

	const phases = collectPhases(prompt, input.steps);
	if (phases.size >= 3) {
		score += 1;
		signals.push("multi-phase");
	}

	const combined = `${prompt}\n${input.steps.map((step) => `${step.text}\n${step.detail}`).join("\n")}`;
	if (matchesAny(combined, CROSS_SCOPE_PATTERNS)) {
		score += 1;
		signals.push("cross-scope");
	}

	if (score >= 2) {
		return { allow: true, reason: "complex-task", score, signals };
	}

	return { allow: false, reason: "not-complex-enough", score, signals };
}

export function getTrackingExecutionOptions(_isRefine: boolean): string[] {
	return ["逐步执行（每步暂停确认）", "一次性运行全部", "忽略"];
}

export function appendPlanSteps(existingSteps: readonly PlanStep[], newSteps: readonly PlanStepDraft[]): PlanStep[] {
	const merged = existingSteps.map((step, index) => cloneStep(step, index + 1));
	for (const draft of newSteps) {
		merged.push(materializeDraft(draft, merged.length + 1));
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
