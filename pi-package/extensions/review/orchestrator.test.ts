import assert from "node:assert/strict";
import test from "node:test";

import {
	buildCoordinatorPrompt,
	buildOrchestrationSection,
	buildSpecialistExecutionPlan,
	buildSpecialistPrompt,
} from "./orchestrator.ts";
import type { ReviewPlan } from "./strategy.ts";

function samplePlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
	return {
		tier: "full",
		focuses: ["code-quality", "security", "performance", "release"],
		includedEntries: [{ path: "src/auth/session.ts", added: 8, removed: 3 }],
		excludedEntries: [],
		totalLines: 120,
		hasSecuritySensitiveFiles: true,
		agentsMateriality: null,
		...overrides,
	};
}

test("buildSpecialistExecutionPlan keeps trivial reviews on single-session path", () => {
	assert.deepEqual(buildSpecialistExecutionPlan(samplePlan({ tier: "trivial", focuses: ["code-quality"] })), []);
});

test("buildSpecialistExecutionPlan expands high-risk reviews into specialist passes", () => {
	assert.deepEqual(
		buildSpecialistExecutionPlan(samplePlan({ focuses: ["code-quality", "security", "performance", "release", "docs"] })),
		["code-quality", "security", "performance", "release", "docs"],
	);
});

test("buildSpecialistPrompt narrows focus with what-not-to-flag guidance", () => {
	const prompt = buildSpecialistPrompt("security", {
		targetLabel: "相对 'main' 的改动",
		basePrompt: "审查相对于基础分支 'main' 的代码改动。",
	});

	assert.match(prompt, /Security/);
	assert.match(prompt, /What NOT to flag|不要标记/);
	assert.match(prompt, /相对 'main' 的改动/);
});

test("buildCoordinatorPrompt merges specialist outputs with dedupe and severity guidance", () => {
	const prompt = buildCoordinatorPrompt({
		targetLabel: "当前未提交改动",
		specialistOutputs: [
			{ specialist: "security", summary: "[P1] src/auth.ts: token expiry check can bypass logout" },
			{ specialist: "performance", summary: "[P2] src/cache.ts: queue can grow without bound" },
		],
	});

	assert.match(prompt, /security/i);
	assert.match(prompt, /performance/i);
	assert.match(prompt, /去重|dedupe/i);
	assert.match(prompt, /严重性|severity/i);
	assert.match(prompt, /approved_with_comments/);
});

test("buildOrchestrationSection stays empty for trivial reviews and adds coordinator for full ones", () => {
	assert.equal(
		buildOrchestrationSection({
			plan: samplePlan({ tier: "trivial", focuses: ["code-quality"] }),
			targetLabel: "当前未提交改动",
			basePrompt: "审查当前代码改动。",
		}),
		"",
	);
	const section = buildOrchestrationSection({
		plan: samplePlan({ focuses: ["code-quality", "security", "performance"] }),
		targetLabel: "当前未提交改动",
		basePrompt: "审查当前代码改动。",
	});
	assert.match(section, /specialist passes/i);
	assert.match(section, /Coordinator Merge Pass/);
});
