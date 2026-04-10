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

const SYSTEM_PROMPT = `You are a plan extractor. Given text from a conversation, extract the actionable execution plan.

Output a JSON object:
{
  "is_plan": true,
  "steps": [
    { "step": 1, "text": "Short summary (≤60 chars)", "detail": "Full step description" }
  ]
}

Rules:
- A plan is a series of concrete actions to be executed, whether numbered or described in prose
- Look for patterns like: numbered lists, "first...then...finally", "step 1...step 2", or any sequential action description
- A list of options/alternatives for the user to CHOOSE from is NOT a plan
- Keep "text" short (≤60 chars) for widget display; put the full description in "detail"
- Preserve the original step numbers if present; otherwise number sequentially
- If the text contains NO actionable steps at all, return {"is_plan": false, "steps": []}
- When in doubt, extract steps — it's better to extract too many than to miss a plan`;

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

function parseResult(text: string): { result: RawExtractionResult | null; raw: string } {
	try {
		let json = text;
		const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (match) json = match[1].trim();

		// Also try to find JSON object in free text
		if (!json.trimStart().startsWith("{")) {
			const braceStart = json.indexOf("{");
			if (braceStart >= 0) json = json.slice(braceStart);
		}

		const parsed = JSON.parse(json);
		if (parsed && typeof parsed.is_plan === "boolean" && Array.isArray(parsed.steps)) {
			return { result: parsed as RawExtractionResult, raw: text };
		}
		return { result: null, raw: text };
	} catch {
		return { result: null, raw: text };
	}
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ExtractPlanResult {
	steps: PlanStep[];
	/** null = cancelled, "no_plan" = LLM said no plan, "error" = something went wrong */
	status: "ok" | "no_plan" | "error" | "cancelled";
	error?: string;
}

/**
 * Extract plan steps from assistant text using a small model.
 */
export async function extractPlan(
	assistantText: string,
	ctx: ExtensionContext,
	ui: {
		custom: <T>(factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any, options?: any) => Promise<T>;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
	},
): Promise<ExtractPlanResult> {
	const model = await selectExtractionModel(ctx);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { steps: [], status: "error", error: `Auth failed for ${model.provider}/${model.id}: ${auth.error}` };
	}

	const outcome = await ui.custom<{ result: RawExtractionResult | null; error?: string }>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Extracting plan via ${model.provider}/${model.id}...`);
		loader.onAbort = () => done({ result: null, error: "cancelled" });

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
			if (response.stopReason === "aborted") {
				return { result: null, error: "cancelled" };
			}
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			const { result, raw } = parseResult(text);
			if (!result) {
				return { result: null, error: `Model returned unparseable response:\n${raw.slice(0, 200)}` };
			}
			return { result };
		};

		run().then(done).catch((err) => {
			done({ result: null, error: `LLM call failed: ${err?.message ?? String(err)}` });
		});
		return loader;
	});

	if (outcome.error === "cancelled") {
		return { steps: [], status: "cancelled" };
	}

	if (outcome.error) {
		return { steps: [], status: "error", error: outcome.error };
	}

	if (!outcome.result || !outcome.result.is_plan || outcome.result.steps.length === 0) {
		return { steps: [], status: "no_plan" };
	}

	return {
		steps: outcome.result.steps.map((s) => ({
			step: s.step,
			text: truncateText(s.text, 60),
			detail: s.detail || s.text,
			completed: false,
		})),
		status: "ok",
	};
}
