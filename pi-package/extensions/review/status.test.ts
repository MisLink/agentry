import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewWidgetLine } from "./status.ts";

test("buildReviewWidgetLine shows compact active status before heartbeat threshold", () => {
	assert.equal(
		buildReviewWidgetLine({
			targetLabel: "当前未提交改动",
			startedAtMs: 0,
			nowMs: 12_000,
		}),
		"📋 审查进行中 · 当前未提交改动 · 12s",
	);
});

test("buildReviewWidgetLine switches to thinking heartbeat after 30 seconds", () => {
	assert.equal(
		buildReviewWidgetLine({
			targetLabel: "相对 'main' 的改动",
			startedAtMs: 0,
			nowMs: 31_000,
		}),
		"📋 审查进行中 · 相对 'main' 的改动 · 模型思考中 31s",
	);
});

test("buildReviewWidgetLine clamps negative durations and trims blank labels", () => {
	assert.equal(
		buildReviewWidgetLine({
			targetLabel: "   ",
			startedAtMs: 10_000,
			nowMs: 9_000,
		}),
		"📋 审查进行中 · 0s",
	);
});
