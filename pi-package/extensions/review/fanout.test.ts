import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewPlan } from "./strategy.ts";
import {
	buildHiddenReviewSessionSpecs,
	runHiddenReviewFanout,
	type HiddenReviewSessionSpec,
} from "./fanout.ts";

function samplePlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
	return {
		tier: "full",
		focuses: ["code-quality", "security", "performance"],
		includedEntries: [{ path: "src/auth/session.ts", added: 12, removed: 3 }],
		excludedEntries: [],
		totalLines: 15,
		hasSecuritySensitiveFiles: true,
		agentsMateriality: null,
		...overrides,
	};
}

test("buildHiddenReviewSessionSpecs skips trivial reviews and builds focused hidden specs", () => {
	assert.deepEqual(
		buildHiddenReviewSessionSpecs(samplePlan({ tier: "trivial", focuses: ["code-quality"] }), {
			targetLabel: "当前未提交改动",
			basePrompt: "审查当前代码改动。",
		}).map((spec) => spec.specialist),
		[],
	);

	const specs = buildHiddenReviewSessionSpecs(samplePlan(), {
		targetLabel: "当前未提交改动",
		basePrompt: "审查当前代码改动。",
	});

	assert.deepEqual(specs.map((spec) => spec.specialist), ["code-quality", "security", "performance"]);
	assert.match(specs[0]?.label ?? "", /hidden|specialist|code-quality/i);
	assert.match(specs[1]?.prompt ?? "", /Security|specialist|当前未提交改动/i);
	assert.match(specs[1]?.prompt ?? "", /hidden_review_context|review context|read-only/i);
	assert.match(specs[1]?.prompt ?? "", /list-files|file-diff|diff hunks|changed files/i);
	assert.match(specs[1]?.prompt ?? "", /file-excerpt|metadata|deleted|binary|unreadable/i);
	assert.match(specs[1]?.prompt ?? "", /search|matching line|query/i);
	assert.match(specs[1]?.prompt ?? "", /list-hunks|hunk-excerpt|hunk/i);
});

test("runHiddenReviewFanout executes hidden sessions and builds coordinator merge prompt", async () => {
	const specs = buildHiddenReviewSessionSpecs(samplePlan(), {
		targetLabel: "当前未提交改动",
		basePrompt: "审查当前代码改动。",
	});
	const records: Array<{ spec: HiddenReviewSessionSpec; prompts: string[]; disposed: boolean }> = [];

	const result = await runHiddenReviewFanout({
		specs,
		targetLabel: "当前未提交改动",
		createRunner: async (spec) => {
			const record = { spec, prompts: [] as string[], disposed: false };
			records.push(record);
			return {
				run: async (prompt) => {
					record.prompts.push(prompt);
					return `[P2] ${spec.specialist}.ts: ${spec.specialist} output`;
				},
				dispose: async () => {
					record.disposed = true;
				},
			};
		},
	});

	assert.deepEqual(records.map((record) => record.spec.specialist), ["code-quality", "security", "performance"]);
	assert.equal(records.every((record) => record.prompts.length === 1), true);
	assert.equal(records.every((record) => record.disposed), true);
	assert.equal(result.specialistOutputs.length, 3);
	assert.match(result.coordinatorPrompt, /Coordinator Merge Pass/);
	assert.match(result.coordinatorPrompt, /security output/);
	assert.match(result.coordinatorPrompt, /performance output/);
});

test("runHiddenReviewFanout disposes created sessions on failure", async () => {
	const specs = buildHiddenReviewSessionSpecs(samplePlan({ focuses: ["code-quality", "security"] }), {
		targetLabel: "当前未提交改动",
		basePrompt: "审查当前代码改动。",
	});
	const records: Array<{ specialist: string; disposed: boolean }> = [];

	await assert.rejects(
		runHiddenReviewFanout({
			specs,
			targetLabel: "当前未提交改动",
			createRunner: async (spec) => {
				const record = { specialist: spec.specialist, disposed: false };
				records.push(record);
				return {
					run: async () => {
						if (spec.specialist === "security") throw new Error("security pass failed");
						return `[P2] ${spec.specialist}.ts: ok`;
					},
					dispose: async () => {
						record.disposed = true;
					},
				};
			},
		}),
		/security pass failed/,
	);

	assert.deepEqual(records.map((record) => record.specialist), ["code-quality", "security"]);
	assert.equal(records.every((record) => record.disposed), true);
});
