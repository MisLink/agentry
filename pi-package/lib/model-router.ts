/**
 * Model Router — automatic model selection for extension sub-tasks.
 *
 * Rules:
 *   - "utility" slot: prefer fast/cheap models (haiku, codex-mini, gpt-4.1-mini)
 *   - "btw" / "review" slot: cross-model — if main is Opus → GPT 5.4,
 *     otherwise → Opus. Ensures a different perspective.
 *
 * No manual switching. All routing is automatic based on the current main model.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Slot types ─────────────────────────────────────────────────────────────

export type ModelSlot = "utility" | "btw" | "review";

// ── Fast model candidates (for utility slot) ──────────────────────────────

const FAST_MODELS: Array<[string, string]> = [
	["github-copilot", "claude-haiku-4.5"],
	["github-copilot", "gpt-5.4-mini"],
	["anthropic", "claude-haiku-4-5"],
	["openai-codex", "gpt-5.1-codex-mini"],
	["openai", "gpt-4.1-mini"],
	["google", "gemini-2.5-flash"],
];

// ── Cross-model candidates (for btw/review slots) ─────────────────────────

/** When main model is Opus-class → use one of these */
const CROSS_FROM_OPUS: Array<[string, string]> = [
	["github-copilot", "gpt-5.4"],
	["openai", "gpt-5.4"],
	["openai-codex", "gpt-5.4"],
];

/** When main model is NOT Opus-class → use one of these */
const CROSS_TO_OPUS: Array<[string, string]> = [
	["github-copilot", "claude-opus-4.6"],
	["anthropic", "claude-opus-4-6"],
	["github-copilot", "claude-opus-4"],
	["anthropic", "claude-opus-4"],
];

function isOpusClass(model: Model<Api>): boolean {
	return /opus/i.test(model.id);
}

// ── Resolution ─────────────────────────────────────────────────────────────

async function findFirstAvailable(
	candidates: Array<[string, string]>,
	ctx: ExtensionContext,
): Promise<Model<Api> | null> {
	for (const [provider, modelId] of candidates) {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return model;
	}
	return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the model for a given slot based on automatic rules.
 *
 * - "utility": cheapest available fast model
 * - "btw" / "review": cross-model (Opus ↔ GPT 5.4)
 *
 * Returns null only if no suitable model is found (caller should fall back to ctx.model).
 */
export async function getModelForSlot(
	slot: ModelSlot,
	ctx: ExtensionContext,
): Promise<Model<Api> | null> {
	if (slot === "utility") {
		return findFirstAvailable(FAST_MODELS, ctx);
	}

	// btw / review: cross-model
	const main = ctx.model;
	if (!main) return null;

	if (isOpusClass(main)) {
		return findFirstAvailable(CROSS_FROM_OPUS, ctx);
	}
	return findFirstAvailable(CROSS_TO_OPUS, ctx);
}
