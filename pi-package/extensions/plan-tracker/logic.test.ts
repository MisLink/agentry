import assert from "node:assert/strict";
import test from "node:test";

import {
	filterPlanTrackerContextMessages,
	insertPlanStepsAfterCurrent,
	parsePlanCommand,
	replaceRemainingSteps,
	shouldAutoPlan,
	shouldQueueNextStepAfterCompletion,
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

test("allows colloquial explicit plan request used in real sessions", () => {
	const result = decide({
		prompt: "先别急着改代码，先想想这个插件怎么做更合适，给我一个一步步的方案",
		steps: [draft("Inspect current plugin"), draft("Propose approach")],
	});

	assert.equal(result.allow, true);
	assert.equal(result.reason, "explicit-request");
});

test("treats first-think-then-do wording as explicit planning request", () => {
	const result = decide({
		prompt: "先别急着改代码，先想想这个插件怎么做更合适，我们一步步来",
		steps: [draft("Inspect current plugin"), draft("Propose approach")],
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

test("allows auto-plan when wording sounds small but task is clearly complex", () => {
	const result = decide({
		prompt: "顺手重构登录流程，拆分认证模块和中间件，补测试并验证兼容性",
		steps: [
			draft("Inspect auth flow", "Trace current login flow across middleware, service, and UI entrypoints."),
			draft("Refactor auth module", "Split token validation and session refresh into separate modules and update callers."),
			draft("Update middleware", "Adjust middleware integration points and request lifecycle handling."),
			draft("Add coverage", "Update tests and run validation for login, refresh, and logout paths."),
		],
	});

	assert.equal(result.allow, true);
	assert.equal(result.reason, "complex-task");
});

test("allows complex plugin work even when prompt mentions config", () => {
	const result = decide({
		prompt: "能不能帮我把插件命令和配置整理一下，调整执行方式，再补测试验证",
		steps: [
			draft("Inspect plugin flow", "Trace current plugin command flow and identify where execution state is tracked."),
			draft("Refine config handling", "Reshape config and command wiring so execution can stay natural without a special mode."),
			draft("Update tests", "Add regression tests and validate the new execution path."),
		],
	});

	assert.equal(result.allow, true);
	assert.equal(result.reason, "complex-task");
});

test("insertPlanStepsAfterCurrent keeps current step and inserts before remaining tail", () => {
	const merged = insertPlanStepsAfterCurrent(
		[
			{ step: 1, text: "Inspect", detail: "Inspect", completed: true, summary: "done" },
			{ step: 2, text: "Implement", detail: "Implement", completed: false },
			{ step: 3, text: "Verify", detail: "Verify", completed: false },
			{ step: 4, text: "Document", detail: "Document", completed: false },
		],
		[draft("Refine edge cases"), draft("Retest critical flow")],
	);

	assert.deepEqual(
		merged.map((step) => ({ step: step.step, text: step.text, completed: step.completed, summary: step.summary })),
		[
			{ step: 1, text: "Inspect", completed: true, summary: "done" },
			{ step: 2, text: "Implement", completed: false, summary: undefined },
			{ step: 3, text: "Refine edge cases", completed: false, summary: undefined },
			{ step: 4, text: "Retest critical flow", completed: false, summary: undefined },
			{ step: 5, text: "Verify", completed: false, summary: undefined },
			{ step: 6, text: "Document", completed: false, summary: undefined },
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

test("parsePlanCommand separates draft, track, and run intents", () => {
	assert.deepEqual(parsePlanCommand(""), { action: "draft" });
	assert.deepEqual(parsePlanCommand("重构登录流程"), { action: "draft", prompt: "重构登录流程" });
	assert.deepEqual(parsePlanCommand("track"), { action: "track" });
	assert.deepEqual(parsePlanCommand("run"), { action: "run" });
	assert.deepEqual(parsePlanCommand("run 重构登录流程"), { action: "run", prompt: "重构登录流程" });
	assert.deepEqual(parsePlanCommand("refine 第二步再拆细一点"), { action: "refine", feedback: "第二步再拆细一点" });
	assert.deepEqual(parsePlanCommand("done 2"), { action: "done", step: 2 });
	assert.deepEqual(parsePlanCommand("clear"), { action: "clear" });
	assert.deepEqual(parsePlanCommand("status"), { action: "status" });
});

test("completed tracked steps do not auto-queue unless plan is running", () => {
	assert.equal(shouldQueueNextStepAfterCompletion("tracked"), false);
	assert.equal(shouldQueueNextStepAfterCompletion("running"), true);
});

test("filterPlanTrackerContextMessages keeps only latest plan context when active", () => {
	const messages = [
		{ id: "a", customType: "plan-tracker-context" },
		{ id: "b", customType: "other" },
		{ id: "c", customType: "plan-tracker-context" },
	];

	assert.deepEqual(
		filterPlanTrackerContextMessages(messages, true).map((message) => message.id),
		["b", "c"],
	);
	assert.deepEqual(
		filterPlanTrackerContextMessages(messages, false).map((message) => message.id),
		["b"],
	);
});
