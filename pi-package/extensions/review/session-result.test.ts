import assert from "node:assert/strict";
import test from "node:test";

import { extractRequiredAssistantText } from "./session-result.ts";

test("extractRequiredAssistantText returns final assistant text", () => {
	assert.equal(
		extractRequiredAssistantText([
			{ role: "user", content: [{ type: "text", text: "review this" }] },
			{ role: "assistant", content: [{ type: "text", text: "looks fine" }], stopReason: "stop" },
		], "Review"),
		"looks fine",
	);
});

test("extractRequiredAssistantText fails on provider error instead of returning empty fallback", () => {
	assert.throws(
		() => extractRequiredAssistantText([
			{ role: "user", content: [{ type: "text", text: "review this" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "error",
				errorMessage: "context window exceeded",
			},
		], "Review"),
		/Review failed: context window exceeded/,
	);
});

test("extractRequiredAssistantText fails when the final assistant message has no text", () => {
	assert.throws(
		() => extractRequiredAssistantText([
			{ role: "user", content: [{ type: "text", text: "review this" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read" }], stopReason: "stop" },
		], "Review"),
		/Review completed without assistant text/,
	);
});
