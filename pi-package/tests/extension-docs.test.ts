import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const agentsDoc = readFileSync("AGENTS.md", "utf8");
const staticCheckSource = readFileSync("pi-package/extensions/static-check/index.ts", "utf8");
const staticCheckStateSource = readFileSync("pi-package/extensions/static-check/state.ts", "utf8");
const staticCheckTypesSource = readFileSync("pi-package/extensions/static-check/types.ts", "utf8");
const webSearchSource = readFileSync("pi-package/extensions/web-search/index.ts", "utf8");

function includes(text: string, expected: string): boolean {
	return text.includes(expected);
}

test("AGENTS documents every shipped extension surfaced to users", () => {
	assert.equal(includes(agentsDoc, "├── notify/"), true, "AGENTS tree should list notify extension");
	assert.equal(includes(agentsDoc, "| **review** | `/review`、`/end-review` |"), true, "AGENTS table should list /end-review");
	assert.equal(
		includes(agentsDoc, "| **web-search** | `web_search` + `web_fetch` + `get_search_content` tools |"),
		true,
		"AGENTS table should list get_search_content tool",
	);
});

test("static-check docs and command surface use /staticcheck consistently", () => {
	assert.equal(
		includes(agentsDoc, "| **static-check** | `/staticcheck` |"),
		true,
		"AGENTS should list /staticcheck as the user-facing command",
	);
	assert.equal(
		includes(staticCheckSource, "/staticcheck          — run checks now (manual trigger)"),
		true,
		"static-check header should document /staticcheck",
	);
	assert.equal(
		includes(staticCheckSource, 'pi.registerCommand("staticcheck", {'),
		true,
		"static-check extension should register /staticcheck",
	);
	assert.equal(
		includes(staticCheckSource, 'pi.registerFlag("no-staticcheck", {'),
		true,
		"static-check extension should expose --no-staticcheck",
	);
	assert.equal(
		includes(staticCheckSource, "golangci-lint with go vet fallback"),
		true,
		"static-check header should mention golangci-lint with go vet fallback",
	);
	assert.equal(
		includes(staticCheckStateSource, "mutated by /staticcheck commands"),
		true,
		"state docs should reference /staticcheck commands",
	);
	assert.equal(
		includes(staticCheckTypesSource, "Mutable at runtime via /staticcheck commands."),
		true,
		"types docs should reference /staticcheck commands",
	);
});

test("web-search header documents all exported tools", () => {
	assert.equal(
		includes(webSearchSource, "Registers `web_search` for lightweight DuckDuckGo search, `web_fetch`"),
		true,
		"web-search header should describe search and fetch tools together",
	);
	assert.equal(
		includes(webSearchSource, "`get_search_content`"),
		true,
		"web-search header should mention get_search_content",
	);
	assert.equal(
		includes(webSearchSource, "retrieving stored full content from earlier search/fetch results"),
		true,
		"web-search header should explain what get_search_content does",
	);
});
