import type { ReviewEntry, ReviewVcs } from "./strategy.ts";

export type ReviewTargetSpec =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

export type ReviewCollectionParser = "git-numstat" | "name-only";

export type ReviewCollectionCommand = {
	args: string[];
	parser: ReviewCollectionParser;
};

export type ReviewCollectionPlan = {
	commands: ReviewCollectionCommand[];
};

export type ReviewCollectionPlanInput = {
	vcs: ReviewVcs;
	target: ReviewTargetSpec;
	mergeBase?: string | null;
};

function parseDiffCount(value: string): number {
	return /^\d+$/.test(value) ? Number(value) : 0;
}

export function mergeReviewEntries(entries: ReviewEntry[]): ReviewEntry[] {
	const merged = new Map<string, ReviewEntry>();
	for (const entry of entries) {
		const existing = merged.get(entry.path);
		if (existing) {
			existing.added += entry.added;
			existing.removed += entry.removed;
			existing.generated ||= entry.generated === true;
			continue;
		}
		merged.set(entry.path, { ...entry });
	}
	return [...merged.values()];
}

export function parseGitNumstat(stdout: string): ReviewEntry[] {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [added, removed, ...pathParts] = line.split("\t");
			return {
				path: pathParts.join("\t").trim(),
				added: parseDiffCount(added ?? "0"),
				removed: parseDiffCount(removed ?? "0"),
			};
		})
		.filter((entry) => entry.path);
}

export function parseNameOnly(stdout: string): ReviewEntry[] {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => ({ path: line.trim(), added: 0, removed: 0 }));
}

export function parseReviewCollectionOutput(command: ReviewCollectionCommand, stdout: string): ReviewEntry[] {
	switch (command.parser) {
		case "git-numstat":
			return parseGitNumstat(stdout);
		case "name-only":
			return parseNameOnly(stdout);
	}
}

export function buildReviewCollectionPlan(input: ReviewCollectionPlanInput): ReviewCollectionPlan {
	if (input.vcs === "git") {
		switch (input.target.type) {
			case "uncommitted":
				return {
					commands: [
						{ args: ["diff", "--numstat"], parser: "git-numstat" },
						{ args: ["diff", "--staged", "--numstat"], parser: "git-numstat" },
						{ args: ["ls-files", "--others", "--exclude-standard"], parser: "name-only" },
					],
				};
			case "baseBranch":
				return input.mergeBase
					? { commands: [{ args: ["diff", "--numstat", input.mergeBase], parser: "git-numstat" }] }
					: { commands: [] };
			case "commit":
				return { commands: [{ args: ["show", "--numstat", "--format=", input.target.sha], parser: "git-numstat" }] };
		}
	}

	switch (input.target.type) {
		case "uncommitted":
			return { commands: [{ args: ["diff", "--name-only"], parser: "name-only" }] };
		case "baseBranch": {
			const mergeBaseRevset = `heads(::@ & ::${input.target.branch})`;
			return {
				commands: [{ args: ["diff", "--from", mergeBaseRevset, "--to", "@", "--name-only"], parser: "name-only" }],
			};
		}
		case "commit":
			return {
				commands: [{ args: ["--ignore-working-copy", "diff", "-r", input.target.sha, "--name-only"], parser: "name-only" }],
			};
	}
}
