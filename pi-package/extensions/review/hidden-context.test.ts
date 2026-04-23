import assert from "node:assert/strict";
import test from "node:test";

import {
	buildHiddenReviewContext,
	createHiddenReviewContextTool,
} from "./hidden-context.ts";

test("buildHiddenReviewContext keeps diff snapshot, changed files, per-file diffs, metadata, and hunks", () => {
	const context = buildHiddenReviewContext({
		diffSnapshot: "diff --git a/src/auth.ts b/src/auth.ts",
		files: [
			{ path: "src/auth.ts", content: "export const auth = true;" },
			{ path: "README.md", content: "docs" },
			{ path: "src/auth.ts", content: "export const auth = true;" },
		],
		fileDiffs: [
			{ path: "src/auth.ts", diff: "@@ -1 +1 @@\n-export const auth = false;\n+export const auth = true;" },
			{ path: "README.md", diff: "@@ -1 +1 @@\n-old\n+docs" },
		],
		fileMetadata: [
			{ path: "src/auth.ts", state: "available", lineCount: 4 },
			{ path: "src/old.ts", state: "deleted" },
			{ path: "assets/logo.png", state: "binary" },
		],
		fileHunks: [
			{ path: "src/auth.ts", id: "H1", header: "@@ -1 +1 @@", startLine: 1, endLine: 1, excerpt: "-export const auth = false;\n+export const auth = true;" },
		],
	});

	assert.equal(context.diffSnapshot, "diff --git a/src/auth.ts b/src/auth.ts");
	assert.deepEqual(Object.keys(context.files), ["src/auth.ts", "README.md"]);
	assert.equal(context.files["src/auth.ts"], "export const auth = true;");
	assert.deepEqual(Object.keys(context.fileDiffs), ["src/auth.ts", "README.md"]);
	assert.match(context.fileDiffs["src/auth.ts"] ?? "", /@@ -1 \+1 @@/);
	assert.equal(context.fileMetadata["src/auth.ts"]?.state, "available");
	assert.equal(context.fileMetadata["src/auth.ts"]?.lineCount, 4);
	assert.equal(context.fileMetadata["src/old.ts"]?.state, "deleted");
	assert.equal(context.fileMetadata["assets/logo.png"]?.state, "binary");
	assert.equal(context.fileHunks["src/auth.ts"]?.[0]?.id, "H1");
	assert.match(context.fileHunks["src/auth.ts"]?.[0]?.excerpt ?? "", /export const auth = true/);
});

test("hidden review context tool returns diff snapshot, file contents, discovery info, metadata, and excerpts", async () => {
	const tool = createHiddenReviewContextTool(buildHiddenReviewContext({
		diffSnapshot: "diff snapshot",
		files: [
			{ path: "src/auth.ts", content: "line1\nline2\nline3\nline4" },
			{ path: "README.md", content: "docs" },
		],
		fileDiffs: [
			{ path: "src/auth.ts", diff: "@@ -1 +1 @@\n-export const auth = false;\n+export const auth = true;" },
			{ path: "README.md", diff: "@@ -1 +1 @@\n-old\n+docs" },
		],
		fileMetadata: [
			{ path: "src/auth.ts", state: "available", lineCount: 4 },
			{ path: "src/old.ts", state: "deleted" },
			{ path: "assets/logo.png", state: "binary" },
		],
	}));

	const diffResult = await tool.execute("tool-1", { kind: "diff" }, undefined, undefined, undefined as never);
	const fileResult = await tool.execute("tool-2", { kind: "file", path: "src/auth.ts" }, undefined, undefined, undefined as never);
	const listFilesResult = await tool.execute("tool-3", { kind: "list-files" }, undefined, undefined, undefined as never);
	const fileDiffResult = await tool.execute("tool-4", { kind: "file-diff", path: "src/auth.ts" }, undefined, undefined, undefined as never);
	const fileMetaResult = await tool.execute("tool-5", { kind: "file-meta", path: "src/old.ts" }, undefined, undefined, undefined as never);
	const excerptResult = await tool.execute("tool-6", { kind: "file-excerpt", path: "src/auth.ts", startLine: 2, endLine: 3 }, undefined, undefined, undefined as never);

	assert.equal(diffResult.content[0]?.type, "text");
	assert.match(diffResult.content[0]?.text ?? "", /diff snapshot/);
	assert.equal(fileResult.content[0]?.type, "text");
	assert.match(fileResult.content[0]?.text ?? "", /line1/);
	assert.match(listFilesResult.content[0]?.text ?? "", /src\/auth\.ts.*available/i);
	assert.match(listFilesResult.content[0]?.text ?? "", /src\/old\.ts.*deleted/i);
	assert.match(listFilesResult.content[0]?.text ?? "", /assets\/logo\.png.*binary/i);
	assert.match(fileDiffResult.content[0]?.text ?? "", /@@ -1 \+1 @@/);
	assert.match(fileMetaResult.content[0]?.text ?? "", /deleted/i);
	assert.match(excerptResult.content[0]?.text ?? "", /line2/);
	assert.match(excerptResult.content[0]?.text ?? "", /line3/);
	assert.doesNotMatch(excerptResult.content[0]?.text ?? "", /line1/);
});

test("hidden review context tool searches allowed files with matching excerpts", async () => {
	const tool = createHiddenReviewContextTool(buildHiddenReviewContext({
		diffSnapshot: "diff snapshot",
		files: [
			{ path: "src/auth.ts", content: "auth ok\ntoken expiry bug\nlogout path" },
			{ path: "src/cache.ts", content: "queue growth bug\ncache token cleanup" },
		],
		fileMetadata: [
			{ path: "src/auth.ts", state: "available", lineCount: 3 },
			{ path: "src/cache.ts", state: "available", lineCount: 2 },
			{ path: "src/old.ts", state: "deleted" },
		],
	}));

	const searchResult = await tool.execute("tool-11", { kind: "search", query: "token", maxResults: 2 }, undefined, undefined, undefined as never);
	const limitedSearchResult = await tool.execute("tool-12", { kind: "search", query: "bug", maxResults: 1 }, undefined, undefined, undefined as never);

	assert.equal(searchResult.isError, false);
	assert.match(searchResult.content[0]?.text ?? "", /src\/auth\.ts/);
	assert.match(searchResult.content[0]?.text ?? "", /src\/cache\.ts/);
	assert.match(searchResult.content[0]?.text ?? "", /token expiry bug/);
	assert.match(searchResult.content[0]?.text ?? "", /cache token cleanup/);
	assert.equal(limitedSearchResult.isError, false);
	assert.match(limitedSearchResult.content[0]?.text ?? "", /src\/(auth|cache)\.ts/);
	assert.doesNotMatch(limitedSearchResult.content[0]?.text ?? "", /\nsrc\/(auth|cache)\.ts.*\nsrc\/(auth|cache)\.ts/s);
});

test("hidden review context tool lists hunks and returns hunk excerpts", async () => {
	const tool = createHiddenReviewContextTool(buildHiddenReviewContext({
		diffSnapshot: "diff snapshot",
		files: [
			{ path: "src/auth.ts", content: "line1\nline2\nline3" },
		],
		fileDiffs: [
			{ path: "src/auth.ts", diff: "@@ -1 +1 @@\n-export const auth = false;\n+export const auth = true;" },
		],
		fileMetadata: [
			{ path: "src/auth.ts", state: "available", lineCount: 3 },
		],
		fileHunks: [
			{ path: "src/auth.ts", id: "H1", header: "@@ -1 +1 @@", startLine: 1, endLine: 1, excerpt: "-export const auth = false;\n+export const auth = true;" },
			{ path: "src/auth.ts", id: "H2", header: "@@ -3 +3 @@", startLine: 3, endLine: 3, excerpt: "-logout = false\n+logout = true" },
		],
	}));

	const listHunksResult = await tool.execute("tool-14", { kind: "list-hunks", path: "src/auth.ts" }, undefined, undefined, undefined as never);
	const hunkExcerptResult = await tool.execute("tool-15", { kind: "hunk-excerpt", path: "src/auth.ts", hunkId: "H2" }, undefined, undefined, undefined as never);

	assert.equal(listHunksResult.isError, false);
	assert.match(listHunksResult.content[0]?.text ?? "", /H1/);
	assert.match(listHunksResult.content[0]?.text ?? "", /H2/);
	assert.match(hunkExcerptResult.content[0]?.text ?? "", /logout = true/);
	assert.match(hunkExcerptResult.content[0]?.text ?? "", /@@ -3 \+3 @@/);
});

test("hidden review context tool rejects unknown or unsafe paths", async () => {
	const tool = createHiddenReviewContextTool(buildHiddenReviewContext({
		diffSnapshot: "diff snapshot",
		files: [
			{ path: "src/auth.ts", content: "line1\nline2\nline3" },
		],
		fileDiffs: [
			{ path: "src/auth.ts", diff: "@@ -1 +1 @@\n-export const auth = false;\n+export const auth = true;" },
		],
		fileMetadata: [
			{ path: "src/auth.ts", state: "available", lineCount: 3 },
		],
	}));

	const unknown = await tool.execute("tool-7", { kind: "file", path: "src/missing.ts" }, undefined, undefined, undefined as never);
	const unsafe = await tool.execute("tool-8", { kind: "file", path: "../secret.txt" }, undefined, undefined, undefined as never);
	const unsafeDiff = await tool.execute("tool-9", { kind: "file-diff", path: "../secret.txt" }, undefined, undefined, undefined as never);
	const unsafeExcerpt = await tool.execute("tool-10", { kind: "file-excerpt", path: "../secret.txt", startLine: 1, endLine: 2 }, undefined, undefined, undefined as never);
	const emptySearch = await tool.execute("tool-13", { kind: "search", query: "", maxResults: 2 }, undefined, undefined, undefined as never);
	const badHunk = await tool.execute("tool-16", { kind: "hunk-excerpt", path: "src/auth.ts", hunkId: "missing" }, undefined, undefined, undefined as never);

	assert.equal(unknown.isError, true);
	assert.match(unknown.content[0]?.text ?? "", /not available|unknown/i);
	assert.equal(unsafe.isError, true);
	assert.match(unsafe.content[0]?.text ?? "", /not available|unsafe|unknown/i);
	assert.equal(unsafeDiff.isError, true);
	assert.match(unsafeDiff.content[0]?.text ?? "", /not available|unsafe|unknown/i);
	assert.equal(unsafeExcerpt.isError, true);
	assert.match(unsafeExcerpt.content[0]?.text ?? "", /not available|unsafe|unknown/i);
	assert.equal(emptySearch.isError, true);
	assert.match(emptySearch.content[0]?.text ?? "", /invalid|query|search/i);
	assert.equal(badHunk.isError, true);
	assert.match(badHunk.content[0]?.text ?? "", /not available|unknown|hunk/i);
});
