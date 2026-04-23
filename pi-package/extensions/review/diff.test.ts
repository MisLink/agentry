import assert from "node:assert/strict";
import test from "node:test";

import {
	buildReviewCollectionPlan,
	mergeReviewEntries,
	parseGitNumstat,
	parseNameOnly,
	type ReviewCollectionCommand,
} from "./diff.ts";

function args(command: ReviewCollectionCommand): string {
	return command.args.join(" ");
}

test("parseGitNumstat handles regular and binary entries", () => {
	assert.deepEqual(
		parseGitNumstat("12\t4\tsrc/auth.ts\n-\t-\tassets/logo.png\n"),
		[
			{ path: "src/auth.ts", added: 12, removed: 4 },
			{ path: "assets/logo.png", added: 0, removed: 0 },
		],
	);
});

test("parseNameOnly trims empty lines", () => {
	assert.deepEqual(parseNameOnly("src/a.ts\n\n src/b.ts \n"), [
		{ path: "src/a.ts", added: 0, removed: 0 },
		{ path: "src/b.ts", added: 0, removed: 0 },
	]);
});

test("mergeReviewEntries aggregates counts and preserves generated flag", () => {
	assert.deepEqual(
		mergeReviewEntries([
			{ path: "src/review.ts", added: 2, removed: 1 },
			{ path: "src/review.ts", added: 3, removed: 4, generated: true },
			{ path: "src/other.ts", added: 1, removed: 0 },
		]),
		[
			{ path: "src/review.ts", added: 5, removed: 5, generated: true },
			{ path: "src/other.ts", added: 1, removed: 0 },
		],
	);
});

test("buildReviewCollectionPlan returns expected git commands", () => {
	const uncommitted = buildReviewCollectionPlan({ vcs: "git", target: { type: "uncommitted" } });
	assert.deepEqual(uncommitted.commands.map(args), [
		"diff --numstat",
		"diff --staged --numstat",
		"ls-files --others --exclude-standard",
	]);

	const baseBranch = buildReviewCollectionPlan({
		vcs: "git",
		target: { type: "baseBranch", branch: "main" },
		mergeBase: "abc123",
	});
	assert.deepEqual(baseBranch.commands.map(args), ["diff --numstat abc123"]);

	const commit = buildReviewCollectionPlan({ vcs: "git", target: { type: "commit", sha: "deadbeef" } });
	assert.deepEqual(commit.commands.map(args), ["show --numstat --format= deadbeef"]);
});

test("buildReviewCollectionPlan returns expected jj commands", () => {
	const uncommitted = buildReviewCollectionPlan({ vcs: "jj", target: { type: "uncommitted" } });
	assert.deepEqual(uncommitted.commands.map(args), ["diff --name-only"]);

	const baseBranch = buildReviewCollectionPlan({
		vcs: "jj",
		target: { type: "baseBranch", branch: "main" },
	});
	assert.deepEqual(baseBranch.commands.map(args), ["diff --from heads(::@ & ::main) --to @ --name-only"]);

	const commit = buildReviewCollectionPlan({ vcs: "jj", target: { type: "commit", sha: "kk123" } });
	assert.deepEqual(commit.commands.map(args), ["--ignore-working-copy diff -r kk123 --name-only"]);
});
