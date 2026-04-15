import assert from "node:assert/strict";
import test from "node:test";

import {
	claimReviewWidgetRuntime,
	resetReviewWidgetRuntimeForTest,
} from "./widget-runtime.ts";

test("claimReviewWidgetRuntime invalidates and clears the previous reload timer", () => {
	resetReviewWidgetRuntimeForTest();
	const first = claimReviewWidgetRuntime();
	const firstTimer = setInterval(() => {}, 10_000);
	first.setTimer(firstTimer);
	assert.equal(first.getTimer(), firstTimer);
	assert.equal(first.isCurrent(), true);

	const second = claimReviewWidgetRuntime();

	assert.equal(first.isCurrent(), false);
	assert.equal(first.getTimer(), undefined);
	assert.equal(second.isCurrent(), true);
	assert.equal(second.getTimer(), undefined);
	second.clearTimer();
});

test("stale widget runtime handles cannot install a new timer", () => {
	resetReviewWidgetRuntimeForTest();
	const first = claimReviewWidgetRuntime();
	const second = claimReviewWidgetRuntime();
	const staleTimer = setInterval(() => {}, 10_000);

	first.setTimer(staleTimer);

	assert.equal(first.getTimer(), undefined);
	assert.equal(second.getTimer(), undefined);
	second.clearTimer();
});
