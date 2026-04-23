import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const skillPath = new URL("../../../skills/review-workflow/SKILL.md", import.meta.url);

function readSkill(): string {
	return readFileSync(skillPath, "utf8");
}

test("portable review skill exists with trigger-heavy frontmatter", () => {
	const skill = readSkill();
	assert.match(skill, /^---[\s\S]*name:\s*review-workflow/m);
	assert.match(skill, /description:[\s\S]*(code review|pull request|merge request|diff|审查)/mi);
});

test("portable review skill teaches specialist passes and coordinator merge", () => {
	const skill = readSkill();
	assert.match(skill, /multi-pass|多阶段|specialist|coordinator/i);
	assert.match(skill, /approved_with_comments|minor_issues|significant_concerns/);
});

test("portable review skill covers re-review continuity and user feedback", () => {
	const skill = readSkill();
	assert.match(skill, /re-review|复审|增量审查/i);
	assert.match(skill, /acknowledged|won't fix|I disagree|争议|确认不修复/i);
	assert.match(skill, /F-|finding id|稳定 ID|标识符/i);
	assert.match(skill, /thread:|comment thread|reply-to-finding|评论线程|线程 ID/i);
});
