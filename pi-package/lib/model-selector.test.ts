import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@mariozechner/pi-ai";
import {
	buildModelSelectorItems,
	buildModelSelectorWindow,
	filterModelSelectorItems,
	formatModelSelectorLabel,
	findModelSelectorItemByLabel,
	MODEL_SELECTOR_VISIBLE_ITEMS,
} from "./model-selector.ts";

function model(provider: string, id: string, name = id): Model<Api> {
	return {
		provider,
		id,
		name,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	} as Model<Api>;
}

test("buildModelSelectorItems sorts current model first and removes duplicates", () => {
	const current = model("anthropic", "claude-opus", "Claude Opus");
	const duplicate = model("openai", "gpt-5.4", "GPT 5.4");
	const items = buildModelSelectorItems([
		model("openai", "gpt-5.4-mini", "GPT 5.4 Mini"),
		duplicate,
		current,
		duplicate,
	], current);

	assert.deepEqual(
		items.map((item) => `${item.model.provider}/${item.model.id}`),
		[
			"anthropic/claude-opus",
			"openai/gpt-5.4",
			"openai/gpt-5.4-mini",
		],
	);
	assert.equal(items[0]?.isCurrent, true);
});

test("formatModelSelectorLabel mirrors the built-in model selector shape", () => {
	assert.equal(
		formatModelSelectorLabel(buildModelSelectorItems([
			model("openai", "gpt-5.4", "GPT 5.4"),
		], model("openai", "gpt-5.4", "GPT 5.4"))[0]!),
		"gpt-5.4 [openai] ✓",
	);
});

test("filterModelSelectorItems fuzzy-matches provider, id, provider/id, and name", () => {
	const items = buildModelSelectorItems([
		model("openai", "gpt-5.4", "GPT 5.4"),
		model("anthropic", "claude-opus", "Claude Opus"),
	], undefined);

	assert.deepEqual(
		filterModelSelectorItems(items, "anth opus").map((item) => item.model.id),
		["claude-opus"],
	);
	assert.deepEqual(
		filterModelSelectorItems(items, "openai/gpt").map((item) => item.model.id),
		["gpt-5.4"],
	);
});

test("findModelSelectorItemByLabel resolves real model labels and has no pagination controls", () => {
	const items = buildModelSelectorItems(
		Array.from({ length: 25 }, (_, index) => model("openai", `gpt-test-${index}`)),
		undefined,
	);
	const labels = items.map(formatModelSelectorLabel);

	assert.equal(labels.length, 25);
	assert.equal(labels.includes("下一页"), false);
	assert.equal(labels.includes("上一页"), false);
	assert.equal(findModelSelectorItemByLabel(items, "gpt-test-24 [openai]")?.model.id, "gpt-test-24");
	assert.equal(findModelSelectorItemByLabel(items, "missing"), null);
});

test("buildModelSelectorWindow limits visible models and uses a scroll indicator", () => {
	const items = buildModelSelectorItems(
		Array.from({ length: 25 }, (_, index) => model("openai", `gpt-test-${index}`)),
		undefined,
	);
	const window = buildModelSelectorWindow(items, 14);

	assert.equal(window.items.length, MODEL_SELECTOR_VISIBLE_ITEMS);
	assert.equal(window.startIndex, 9);
	assert.equal(window.endIndex, 19);
	assert.equal(window.selectedIndex, 14);
	assert.equal(window.hasScrollIndicator, true);
});
