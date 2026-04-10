/**
 * LLM-based plan extraction.
 *
 * Uses the model-router "utility" slot to select a fast model for extraction.
 * Falls back to the current session model if no override or fast model is available.
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getModelForSlot } from "../../lib/model-router.js";
import type { PlanStep } from "./utils.js";
import { truncateText } from "./utils.js";

// ── Extraction prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a plan extractor. Given text from a conversation, determine if it contains an actionable execution plan (a series of steps the assistant intends to carry out).

Output a JSON object with this structure:
{
  "is_plan": true,
  "steps": [
    { "step": 1, "text": "Short summary (≤60 chars)", "detail": "Full step description" }
  ]
}

Rules:
- A plan is a numbered list of concrete actions to be executed in order
- A list of options/alternatives for the user to choose from is NOT a plan
- A list of findings/observations is NOT a plan
- Keep "text" short (≤60 chars) for display; put the full description in "detail"
- Preserve the original step numbers from the text
- If no actionable plan is found, return {"is_plan": false, "steps": []}`;

// ── Model selection ────────────────────────────────────────────────────────

async function selectExtractionModel(ctx: ExtensionContext): Promise<Model<Api>> {
	const routed = await getModelForSlot("utility", ctx);
	return routed ?? ctx.model!;
}

// ── Extraction result parsing ──────────────────────────────────────────────

interface RawExtractionResult {
	is_plan: boolean;
	steps: Array<{ step: number; text: string; detail: string }>;
}

function parseResult(text: string): RawExtractionResult | null {
	try {
		let json = text;
		const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (match) json = match[1].trim();
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed.is_plan === "boolean" && Array.isArray(parsed.steps)) {
			return parsed as RawExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract plan steps from assistant text using a small model.
 * Returns null if cancelled, empty array if no plan detected.
 */
export async function extractPlan(
	assistantText: string,
	ctx: ExtensionContext,
	ui: {
		custom: <T>(factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any, options?: any) => Promise<T>;
	},
): Promise<PlanStep[] | null> {
	const model = await selectExtractionModel(ctx);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return null;

	const result = await ui.custom<RawExtractionResult | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Extracting plan via ${model.id}...`);
		loader.onAbort = () => done(null);

		const run = async () => {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: assistantText }],
				timestamp: Date.now(),
			};
			const response = await complete(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);
			if (response.stopReason === "aborted") return null;
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return parseResult(text);
		};

		run().then(done).catch(() => done(null));
		return loader;
	});

	if (!result || !result.is_plan || result.steps.length === 0) return result === null ? null : [];

	return result.steps.map((s) => ({
		step: s.step,
		text: truncateText(s.text, 60),
		detail: s.detail || s.text,
		completed: false,
	}));
}
