import assert from "node:assert/strict";
import test from "node:test";

import {
	appendPlanSteps,
	getTrackingExecutionOptions,
	replaceRemainingSteps,
	shouldAutoPlan,
	type AutoPlanDecisionInput,
	type PlanStepDraft,
} from "./logic.ts";

function decide(input: Partial<AutoPlanDecisionInput>) {
	return shouldAutoPlan({
		prompt: "",
		steps: [],
		hasActivePlan: false,
		...input,
	});
}

function draft(text: string, detail = text): PlanStepDraft {
	return { text, detail };
}

test("allows explicit plan request even for short plan", () => {
	const result = decide({
		prompt: "先给我一个执行计划，再动手改代码",
		steps: [draft("Inspect"), draft("Implement")],
	});

	assert.equal(result.allow, true);
	assert.equal(result.reason, "explicit-request");
});

test("blocks auto-plan for straightforward small task", () => {
	const result = decide({
		prompt: "改一下这个 if 判断，顺手修个小 bug",
		steps: [draft("Read file"), draft("Edit condition"), draft("Verify result")],
	});

	assert.equal(result.allow, false);
	assert.equal(result.reason, "straightforward-task");
});

test("allows auto-plan for clearly complex refactor", () => {
	const result = decide({
		prompt: "重构登录流程，拆分认证模块，补测试并验证兼容性",
		steps: [
			draft("Inspect auth flow", "Trace current login flow across middleware, service, and UI entrypoints."),
			draft("Refactor auth module", "Split token validation and session refresh into separate modules and update callers."),
			draft("Add coverage", "Update tests and run validation for login, refresh, and logout paths."),
		],
	});

	assert.equal(result.allow, true);
	assert.equal(result.reason, "complex-task");
});

test("appendPlanSteps keeps existing progress and appends renumbered steps", () => {
	const merged = appendPlanSteps(
		[
			{ step: 1, text: "Inspect", detail: "Inspect", completed: true, summary: "done" },
			{ step: 2, text: "Implement", detail: "Implement", completed: false },
		],
		[draft("Verify"), draft("Document")],
	);

	assert.deepEqual(
		merged.map((step) => ({ step: step.step, text: step.text, completed: step.completed, summary: step.summary })),
		[
			{ step: 1, text: "Inspect", completed: true, summary: "done" },
			{ step: 2, text: "Implement", completed: false, summary: undefined },
			{ step: 3, text: "Verify", completed: false, summary: undefined },
			{ step: 4, text: "Document", completed: false, summary: undefined },
		],
	);
});

test("replaceRemainingSteps keeps completed prefix and swaps unfinished tail", () => {
	const merged = replaceRemainingSteps(
		[
			{ step: 1, text: "Inspect", detail: "Inspect", completed: true, summary: "done" },
			{ step: 2, text: "Implement", detail: "Implement", completed: false },
			{ step: 3, text: "Verify", detail: "Verify", completed: false },
		],
		[draft("Rewrite remaining impl"), draft("Retest critical flows")],
	);

	assert.deepEqual(
		merged.map((step) => ({ step: step.step, text: step.text, completed: step.completed, summary: step.summary })),
		[
			{ step: 1, text: "Inspect", completed: true, summary: "done" },
			{ step: 2, text: "Rewrite remaining impl", completed: false, summary: undefined },
			{ step: 3, text: "Retest critical flows", completed: false, summary: undefined },
		],
	);
});

test("tracking execution options no longer include track-only mode", () => {
	assert.deepEqual(getTrackingExecutionOptions(false), ["逐步执行（每步暂停确认）", "一次性运行全部", "忽略"]);
	assert.deepEqual(getTrackingExecutionOptions(true), ["逐步执行（每步暂停确认）", "一次性运行全部", "忽略"]);
});
