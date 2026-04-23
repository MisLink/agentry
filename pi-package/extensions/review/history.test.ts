import assert from "node:assert/strict";
import test from "node:test";

import {
	buildReviewTargetKey,
	buildRereviewPromptSection,
	compactReviewSummary,
	extractReviewFindings,
	findPreviousReviewMemory,
	applyFindingFeedback,
	extractFindingFeedback,
	mergeReviewMemory,
	pruneReviewMemory,
	type ReviewMemory,
} from "./history.ts";

const memories: ReviewMemory[] = [
	{ targetKey: "git:baseBranch:main", summary: "older", createdAtMs: 1, findings: [] },
	{ targetKey: "git:baseBranch:main", summary: "latest", createdAtMs: 2, findings: [] },
	{ targetKey: "git:commit:abc", summary: "other", createdAtMs: 3, findings: [] },
];

test("buildReviewTargetKey is stable across target types", () => {
	assert.equal(buildReviewTargetKey("git", { type: "baseBranch", branch: "main" }), "git:baseBranch:main");
	assert.equal(buildReviewTargetKey("jj", { type: "commit", sha: "kk123", title: "ignored" }), "jj:commit:kk123");
	assert.equal(buildReviewTargetKey("git", { type: "uncommitted" }), "git:uncommitted");
});

test("compactReviewSummary normalizes whitespace and truncates long text", () => {
	assert.equal(compactReviewSummary("  [P1] auth bug\n\nNeeds fix.  "), "[P1] auth bug Needs fix.");
	assert.equal(compactReviewSummary("x".repeat(605)).length, 500);
});

test("findPreviousReviewMemory returns latest matching entry", () => {
	assert.deepEqual(findPreviousReviewMemory(memories, "git:baseBranch:main"), memories[1]);
	assert.equal(findPreviousReviewMemory(memories, "git:baseBranch:missing"), null);
});

test("extractReviewFindings parses priority findings from review output", () => {
	assert.deepEqual(
		extractReviewFindings(`## Findings\n- [P1][F-auth-expiry][thread:T-auth-expiry] src/auth.ts: token expiry check can bypass logout\nSome detail\n[P2] src/cache.ts: queue can grow without bound\n## 人工审查提示`),
		[
			{
				id: "F-auth-expiry",
				threadId: "T-auth-expiry",
				key: "src/auth.ts::token expiry check can bypass logout",
				priority: "P1",
				location: "src/auth.ts",
				headline: "token expiry check can bypass logout",
				status: "open",
			},
			{
				key: "src/cache.ts::queue can grow without bound",
				priority: "P2",
				location: "src/cache.ts",
				headline: "queue can grow without bound",
				status: "open",
			},
		],
	);
});

test("mergeReviewMemory keeps repeated findings open and resolves disappeared ones", () => {
	const previous: ReviewMemory = {
		targetKey: "git:baseBranch:main",
		summary: "older",
		createdAtMs: 1,
		findings: [
			{
				threadId: "T-auth-expiry",
				key: "src/auth.ts::token expiry check can bypass logout",
				priority: "P1",
				location: "src/auth.ts",
				headline: "token expiry check can bypass logout",
				status: "open",
				firstSeenAtMs: 1,
				lastSeenAtMs: 1,
			},
			{
				key: "src/cache.ts::queue can grow without bound",
				priority: "P2",
				location: "src/cache.ts",
				headline: "queue can grow without bound",
				status: "open",
				firstSeenAtMs: 1,
				lastSeenAtMs: 1,
			},
		],
	};

	const merged = mergeReviewMemory(previous, {
		targetKey: "git:baseBranch:main",
		summary: "new",
		createdAtMs: 10,
		reviewText: "[P1] src/auth.ts: token expiry check can bypass logout\n[P3] src/ui.ts: button label is misleading",
	});

	assert.deepEqual(merged.findings, [
		{
			threadId: "T-auth-expiry",
			key: "src/auth.ts::token expiry check can bypass logout",
			priority: "P1",
			location: "src/auth.ts",
			headline: "token expiry check can bypass logout",
			status: "open",
			firstSeenAtMs: 1,
			lastSeenAtMs: 10,
		},
		{
			key: "src/ui.ts::button label is misleading",
			priority: "P3",
			location: "src/ui.ts",
			headline: "button label is misleading",
			status: "open",
			firstSeenAtMs: 10,
			lastSeenAtMs: 10,
		},
		{
			key: "src/cache.ts::queue can grow without bound",
			priority: "P2",
			location: "src/cache.ts",
			headline: "queue can grow without bound",
			status: "resolved",
			firstSeenAtMs: 1,
			lastSeenAtMs: 1,
			resolvedAtMs: 10,
		},
	]);
});

test("extractFindingFeedback parses acknowledgement, dispute, finding IDs, and thread IDs", () => {
	assert.deepEqual(
		extractFindingFeedback("acknowledged [P1][F-auth-expiry][thread:T-auth-expiry] src/auth.ts: token expiry check can bypass logout\nI disagree F-cache-growth\nwon't fix thread:T-ui-copy"),
		[
			{ key: "src/auth.ts::token expiry check can bypass logout", id: "F-auth-expiry", threadId: "T-auth-expiry", disposition: "acknowledged" },
			{ id: "F-cache-growth", disposition: "disputed" },
			{ threadId: "T-ui-copy", disposition: "acknowledged" },
		],
	);
});

test("applyFindingFeedback updates matching finding states", () => {
	const updated = applyFindingFeedback({
		targetKey: "git:baseBranch:main",
		summary: "latest",
		createdAtMs: 10,
		findings: [
			{ id: "F-auth-expiry", threadId: "T-auth-expiry", key: "src/auth.ts::token expiry check can bypass logout", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
			{ id: "F-cache-growth", threadId: "T-cache-growth", key: "src/cache.ts::queue can grow without bound", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
		],
	}, "acknowledged [P1][F-auth-expiry][thread:T-auth-expiry] src/auth.ts: token expiry check can bypass logout\nI disagree F-cache-growth", 20);

	assert.deepEqual(updated.findings, [
		{ id: "F-cache-growth", threadId: "T-cache-growth", key: "src/cache.ts::queue can grow without bound", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "disputed", firstSeenAtMs: 1, lastSeenAtMs: 10, disputedAtMs: 20 },
		{ id: "F-auth-expiry", threadId: "T-auth-expiry", key: "src/auth.ts::token expiry check can bypass logout", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "acknowledged", firstSeenAtMs: 1, lastSeenAtMs: 10, acknowledgedAtMs: 20 },
	]);
});

test("applyFindingFeedback matches looser natural-language feedback to existing findings", () => {
	const updated = applyFindingFeedback({
		targetKey: "git:baseBranch:main",
		summary: "latest",
		createdAtMs: 10,
		findings: [
			{ key: "src/auth.ts::token expiry check can bypass logout", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
			{ key: "src/cache.ts::queue can grow without bound", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
		],
	}, "Acknowledged auth token expiry issue for now.\nI disagree with the queue growth finding.", 30);

	assert.deepEqual(updated.findings, [
		{ key: "src/cache.ts::queue can grow without bound", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "disputed", firstSeenAtMs: 1, lastSeenAtMs: 10, disputedAtMs: 30 },
		{ key: "src/auth.ts::token expiry check can bypass logout", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "acknowledged", firstSeenAtMs: 1, lastSeenAtMs: 10, acknowledgedAtMs: 30 },
	]);
});

test("applyFindingFeedback matches explicit thread ids before fuzzy text", () => {
	const updated = applyFindingFeedback({
		targetKey: "git:baseBranch:main",
		summary: "latest",
		createdAtMs: 10,
		findings: [
			{ threadId: "T-auth-expiry", key: "src/auth.ts::token expiry check can bypass logout", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
			{ threadId: "T-cache-growth", key: "src/cache.ts::queue can grow without bound", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
		],
	}, "I disagree thread:T-cache-growth", 40);

	assert.deepEqual(updated.findings, [
		{ threadId: "T-cache-growth", key: "src/cache.ts::queue can grow without bound", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "disputed", firstSeenAtMs: 1, lastSeenAtMs: 10, disputedAtMs: 40 },
		{ threadId: "T-auth-expiry", key: "src/auth.ts::token expiry check can bypass logout", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
	]);
});

test("pruneReviewMemory keeps open findings and only newest resolved findings", () => {
	const pruned = pruneReviewMemory({
		targetKey: "git:baseBranch:main",
		summary: "latest",
		createdAtMs: 10,
		findings: [
			{ key: "open", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "open", firstSeenAtMs: 1, lastSeenAtMs: 10 },
			{ key: "r1", priority: "P2", location: "a", headline: "oldest resolved", status: "resolved", firstSeenAtMs: 1, lastSeenAtMs: 1, resolvedAtMs: 2 },
			{ key: "r2", priority: "P2", location: "b", headline: "middle resolved", status: "resolved", firstSeenAtMs: 1, lastSeenAtMs: 1, resolvedAtMs: 3 },
			{ key: "r3", priority: "P2", location: "c", headline: "newest resolved", status: "resolved", firstSeenAtMs: 1, lastSeenAtMs: 1, resolvedAtMs: 4 },
		],
	}, 2);

	assert.deepEqual(pruned.findings?.map((finding) => finding.key), ["open", "r3", "r2"]);
});

test("buildRereviewPromptSection includes only unresolved findings when memory exists", () => {
	const section = buildRereviewPromptSection({
		...memories[1],
		findings: [
			{
				id: "F-open",
				threadId: "T-open",
				key: "open",
				priority: "P1",
				location: "src/auth.ts",
				headline: "token expiry check can bypass logout",
				status: "open",
				firstSeenAtMs: 1,
				lastSeenAtMs: 2,
			},
			{
				key: "resolved",
				priority: "P2",
				location: "src/cache.ts",
				headline: "queue can grow without bound",
				status: "resolved",
				firstSeenAtMs: 1,
				lastSeenAtMs: 1,
				resolvedAtMs: 2,
			},
		],
	});
	assert.match(section, /上次审查摘要/);
	assert.match(section, /token expiry check can bypass logout/);
	assert.match(section, /F-open/);
	assert.match(section, /T-open|thread:T-open/);
	assert.doesNotMatch(section, /queue can grow without bound/);
	assert.match(section, /已修复/);
	assert.equal(buildRereviewPromptSection(null), "");
});

test("buildRereviewPromptSection surfaces disputed findings but suppresses acknowledged ones", () => {
	const section = buildRereviewPromptSection({
		...memories[1],
		findings: [
			{ threadId: "T-cache-growth", key: "disputed", priority: "P2", location: "src/cache.ts", headline: "queue can grow without bound", status: "disputed", firstSeenAtMs: 1, lastSeenAtMs: 1, disputedAtMs: 2 },
			{ key: "ack", priority: "P1", location: "src/auth.ts", headline: "token expiry check can bypass logout", status: "acknowledged", firstSeenAtMs: 1, lastSeenAtMs: 1, acknowledgedAtMs: 2 },
		],
	});
	assert.match(section, /queue can grow without bound/);
	assert.match(section, /T-cache-growth|thread:T-cache-growth/);
	assert.doesNotMatch(section, /token expiry check can bypass logout/);
	assert.match(section, /争议/);
	assert.match(section, /确认不修复|acknowledged/i);
});
