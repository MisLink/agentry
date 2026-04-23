import {
	buildCoordinatorPrompt,
	buildSpecialistExecutionPlan,
	buildSpecialistPrompt,
	type ReviewSpecialist,
	type SpecialistOutput,
} from "./orchestrator.ts";
import { HIDDEN_REVIEW_CONTEXT_TOOL_NAME } from "./hidden-context.ts";
import type { ReviewPlan } from "./strategy.ts";

export type HiddenReviewSessionSpec = {
	specialist: ReviewSpecialist;
	label: string;
	prompt: string;
};

export type HiddenReviewRunner = {
	run(prompt: string): Promise<string>;
	dispose(): Promise<void> | void;
};

export type BuildHiddenReviewSessionSpecsInput = {
	targetLabel: string;
	basePrompt: string;
};

export type RunHiddenReviewFanoutInput = {
	specs: HiddenReviewSessionSpec[];
	targetLabel: string;
	createRunner(spec: HiddenReviewSessionSpec): Promise<HiddenReviewRunner>;
};

export type HiddenReviewFanoutResult = {
	specialistOutputs: SpecialistOutput[];
	coordinatorPrompt: string;
};

export function buildHiddenReviewSessionSpecs(
	plan: ReviewPlan,
	input: BuildHiddenReviewSessionSpecsInput,
): HiddenReviewSessionSpec[] {
	return buildSpecialistExecutionPlan(plan).map((specialist) => ({
		specialist,
		label: `review:hidden-specialist:${specialist}`,
		prompt: `${buildSpecialistPrompt(specialist, input)}\nUse read-only tool \`${HIDDEN_REVIEW_CONTEXT_TOOL_NAME}\` / review context for extra diff or changed-file lookup. Start with \`list-files\` when path set is unclear, use \`search\` when you need matching lines before picking a file, use \`file-meta\` for deleted/binary/unreadable metadata, and use \`file\`, \`file-diff\`, \`list-hunks\`, \`hunk-excerpt\`, or \`file-excerpt\` for allowed changed files / diff hunks / hunk navigation / line ranges. Do not request edits or writes.`,
	}));
}

async function safeDispose(runner: HiddenReviewRunner): Promise<void> {
	try {
		await runner.dispose();
	} catch {
		/* best effort cleanup */
	}
}

export async function runHiddenReviewFanout(input: RunHiddenReviewFanoutInput): Promise<HiddenReviewFanoutResult> {
	const runners: HiddenReviewRunner[] = [];
	const specialistOutputs: SpecialistOutput[] = [];
	try {
		for (const spec of input.specs) {
			const runner = await input.createRunner(spec);
			runners.push(runner);
			const summary = await runner.run(spec.prompt);
			specialistOutputs.push({ specialist: spec.specialist, summary });
		}
		return {
			specialistOutputs,
			coordinatorPrompt: buildCoordinatorPrompt({
				targetLabel: input.targetLabel,
				specialistOutputs,
			}),
		};
	} finally {
		await Promise.all(runners.map((runner) => safeDispose(runner)));
	}
}
