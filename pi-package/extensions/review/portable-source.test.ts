import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { buildPortableAlignmentSection } from "./portable-source.ts";

const skillPath = new URL("../../../skills/review-workflow/SKILL.md", import.meta.url);
const referencePath = new URL("../../../skills/review-workflow/reference.md", import.meta.url);

function read(path: URL): string {
	return readFileSync(path, "utf8");
}

test("portable review reference file exists with shared semantics", () => {
	const reference = read(referencePath);
	assert.match(reference, /Shared Review Semantics|共享审查语义/);
	assert.match(reference, /approved_with_comments|minor_issues|significant_concerns/);
	assert.match(reference, /acknowledged|won't fix|I disagree|争议|确认不修复/i);
	assert.match(reference, /thread:|comment thread|reply-to-finding|评论线程|线程 ID/i);
});

test("portable review skill links to shared reference", () => {
	const skill = read(skillPath);
	assert.match(skill, /reference\.md/);
	assert.match(skill, /Shared Review Semantics|共享审查语义/);
});

test("buildPortableAlignmentSection reuses shared reference in extension-safe form", () => {
	const reference = read(referencePath);
	const section = buildPortableAlignmentSection(reference);
	assert.match(section, /共享审查语义|Shared Review Semantics/);
	assert.match(section, /approved_with_comments/);
	assert.match(section, /争议|disputed/i);
	assert.match(section, /thread:|comment thread|reply-to-finding|评论线程|线程 ID/i);
});
