import type { ReviewFocus, ReviewPlan } from "./strategy.ts";

export type ReviewSpecialist = ReviewFocus;

export type SpecialistPromptInput = {
	targetLabel: string;
	basePrompt: string;
};

export type SpecialistOutput = {
	specialist: ReviewSpecialist;
	summary: string;
};

export type CoordinatorPromptInput = {
	targetLabel: string;
	specialistOutputs: SpecialistOutput[];
};

export type OrchestrationSectionInput = {
	plan: ReviewPlan;
	targetLabel: string;
	basePrompt: string;
};

const SPECIALIST_ORDER: ReviewSpecialist[] = ["code-quality", "security", "performance", "release", "docs", "agents"];

function specialistHeading(specialist: ReviewSpecialist): string {
	switch (specialist) {
		case "code-quality": return "Code Quality";
		case "security": return "Security";
		case "performance": return "Performance";
		case "release": return "Release";
		case "docs": return "Docs";
		case "agents": return "AGENTS";
	}
}

function specialistFocusGuidance(specialist: ReviewSpecialist): string {
	switch (specialist) {
		case "code-quality":
			return "What to flag: real correctness bugs, silent failures, broken state transitions. What NOT to flag: style-only suggestions, unchanged legacy issues.";
		case "security":
			return "What to flag: exploitable or concretely dangerous auth/input/secret/injection issues. What NOT to flag: theoretical risks with weak preconditions.";
		case "performance":
			return "What to flag: hot-path regressions, backpressure gaps, unbounded growth, extra IO. What NOT to flag: vague micro-optimization ideas.";
		case "release":
			return "What to flag: migration, dependency, compatibility, deployment, or destructive-release risks. What NOT to flag: ordinary implementation details unrelated to release.";
		case "docs":
			return "What to flag: changed behavior without docs/error-message/user-prompt updates. What NOT to flag: trivial wording bikesheds.";
		case "agents":
			return "What to flag: AI workflow/command/directory changes not reflected in AGENTS.md or REVIEW_GUIDELINES.md. What NOT to flag: normal product changes that do not affect agent workflow.";
	}
}

export function buildSpecialistExecutionPlan(plan: ReviewPlan): ReviewSpecialist[] {
	if (plan.tier === "trivial") return [];
	if (plan.tier === "lite") {
		return SPECIALIST_ORDER.filter((specialist) =>
			plan.focuses.includes(specialist) && ["code-quality", "security", "performance"].includes(specialist),
		);
	}
	return SPECIALIST_ORDER.filter((specialist) => plan.focuses.includes(specialist));
}

export function buildSpecialistPrompt(specialist: ReviewSpecialist, input: SpecialistPromptInput): string {
	return `## Specialist Review Pass · ${specialistHeading(specialist)}\nTarget: ${input.targetLabel}\nBase task: ${input.basePrompt}\nFocus: ${specialistFocusGuidance(specialist)}\nOutput only findings from this specialist perspective.`;
}

export function buildCoordinatorPrompt(input: CoordinatorPromptInput): string {
	const summaries = input.specialistOutputs.length > 0
		? input.specialistOutputs.map((item) => `### ${item.specialist}\n${item.summary}`).join("\n\n")
		: "- （暂无 specialist 输出）";
	return `## Coordinator Merge Pass\nTarget: ${input.targetLabel}\nTasks:\n- dedupe overlapping findings\n- normalize severity / 严重性\n- keep approval bias for low-risk changes\n- use approved_with_comments for non-blocking issues\n\n### Specialist outputs\n${summaries}`;
}

export function buildOrchestrationSection(input: OrchestrationSectionInput): string {
	const specialists = buildSpecialistExecutionPlan(input.plan);
	if (specialists.length === 0) return "";
	const specialistPrompts = specialists
		.map((specialist) => buildSpecialistPrompt(specialist, { targetLabel: input.targetLabel, basePrompt: input.basePrompt }))
		.join("\n\n---\n\n");
	const coordinatorPrompt = buildCoordinatorPrompt({
		targetLabel: input.targetLabel,
		specialistOutputs: specialists.map((specialist) => ({ specialist, summary: `<${specialist} output>` })),
	});
	return `## 本地编排建议\n如果环境允许额外 review session，可先运行以下 specialist passes，再用 coordinator 汇总。\n\n${specialistPrompts}\n\n---\n\n${coordinatorPrompt}`;
}
