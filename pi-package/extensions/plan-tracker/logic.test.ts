import assert from "node:assert/strict";
import test from "node:test";

import {
	filterPlanTrackerContextMessages,
	parsePlanCommand,
	shouldQueueNextStepAfterCompletion,
} from "./logic.ts";

test("parsePlanCommand separates draft, track, run, done, clear, and status", () => {
	assert.deepEqual(parsePlanCommand(""), { action: "draft" });
	assert.deepEqual(parsePlanCommand("重构登录流程"), { action: "draft", prompt: "重构登录流程" });
	assert.deepEqual(parsePlanCommand("track"), { action: "track" });
	assert.deepEqual(parsePlanCommand("run"), { action: "run" });
	assert.deepEqual(parsePlanCommand("run 重构登录流程"), { action: "run", prompt: "重构登录流程" });
	assert.deepEqual(parsePlanCommand("done 2"), { action: "done", step: 2 });
	assert.deepEqual(parsePlanCommand("clear"), { action: "clear" });
	assert.deepEqual(parsePlanCommand("discard"), { action: "clear" });
	assert.deepEqual(parsePlanCommand("status"), { action: "status" });
	assert.deepEqual(parsePlanCommand("show"), { action: "status" });
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
