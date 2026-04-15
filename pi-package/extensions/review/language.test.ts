import assert from "node:assert/strict";
import test from "node:test";

import {
	buildReviewLanguageInstruction,
	buildReviewLanguageInstructionFromUserTexts,
} from "./language.ts";

test("buildReviewLanguageInstruction asks reviews to answer in Chinese for Chinese user text", () => {
	const instruction = buildReviewLanguageInstruction("帮我审一下这个改动");

	assert.match(instruction, /Chinese/);
	assert.match(instruction, /中文/);
	assert.match(instruction, /## 问题/);
	assert.match(instruction, /## 结论/);
	assert.match(instruction, /## 非阻塞人工审查提示/);
	assert.match(instruction, /小问题/);
	assert.doesNotMatch(instruction, /## Findings/);
	assert.doesNotMatch(instruction, /minor_issues/);
});

test("buildReviewLanguageInstruction can infer English in auto mode", () => {
	const instruction = buildReviewLanguageInstruction("please review this change", "auto");

	assert.match(instruction, /English/);
});

test("buildReviewLanguageInstruction preserves language matching when user language is unclear", () => {
	const instruction = buildReviewLanguageInstruction("", "auto");

	assert.match(instruction, /same language/i);
});

test("buildReviewLanguageInstructionFromUserTexts ignores slash commands when inferring conversation language", () => {
	const instruction = buildReviewLanguageInstructionFromUserTexts([
		"我想审一下现在的改动",
		"/review uncommitted",
	]);

	assert.match(instruction, /Chinese/);
	assert.match(instruction, /中文/);
});

test("buildReviewLanguageInstructionFromUserTexts defaults to Chinese even for English user text", () => {
	const instruction = buildReviewLanguageInstructionFromUserTexts(["please review this change"]);

	assert.match(instruction, /Chinese/);
	assert.match(instruction, /中文/);
});
