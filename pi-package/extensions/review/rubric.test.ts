import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_RUBRIC } from "./rubric.ts";

test("REVIEW_RUBRIC keeps Chinese user-facing final output labels", () => {
	assert.match(REVIEW_RUBRIC, /Code Review Guidelines/);
	assert.match(REVIEW_RUBRIC, /Output Format/);
	assert.match(REVIEW_RUBRIC, /## 非阻塞人工审查提示/);
	assert.match(REVIEW_RUBRIC, /通过，有备注/);
	assert.match(REVIEW_RUBRIC, /小问题/);
	assert.match(REVIEW_RUBRIC, /重大疑虑/);
	assert.doesNotMatch(REVIEW_RUBRIC, /## Non-Blocking Human Review Notes/);
	assert.doesNotMatch(REVIEW_RUBRIC, /minor_issues/);
});
