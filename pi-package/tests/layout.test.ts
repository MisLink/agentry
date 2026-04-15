import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync } from "node:fs";

const topLevelExtensionFiles = readdirSync("pi-package/extensions", { withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => entry.name);

test("top-level extension directory contains only runtime extensions, not test files", () => {
	const strayTests = topLevelExtensionFiles.filter((name) => /\.(test|spec)\.(ts|mts|cts|js|mjs|cjs)$/.test(name));
	assert.deepEqual(strayTests, []);
});
