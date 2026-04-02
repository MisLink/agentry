/**
 * session.ts — BTW side session lifecycle management.
 *
 * SideSessionManager creates and manages a dedicated AgentSession for the
 * BTW side conversation. It seeds the session with the main conversation
 * context so answers are informed by what has already happened.
 *
 * Improvements over the original btw.ts:
 *  - stripSystemPromptFooter: more robust regex, documented clearly [step 8]
 *  - buildSeedMessages: warns (via callback) on seed failure instead of
 *    swallowing the error silently [step 9]
 *  - abort(): lightweight abort without full dispose, used by cancel [step 6]
 *  - summarise(): uses complete() instead of a full AgentSession [step 1]
 */
import {
	buildSessionContext,
	codingTools,
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionContext,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { complete, type UserMessage, type AssistantMessage, type Message } from "@mariozechner/pi-ai";
import type { BtwThread } from "./thread.js";

// ─── System prompts ───────────────────────────────────────────────────────────

export const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

export const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. " +
	"Keep key decisions, findings, risks, and next actions. Output only the summary.";

// ─── System prompt helpers ────────────────────────────────────────────────────

/**
 * Remove the dynamic footer that pi appends to every system prompt.
 *
 * createAgentSession re-adds the footer automatically, so passing it through
 * would produce duplicates. We strip any contiguous block of trailing lines
 * that begin with "Current date", "Current time", or "Current working directory".
 *
 * The regex anchors to the end of the string ($) and handles all combinations
 * of those footer lines, making it resilient to reordering or additions.
 */
function stripSystemPromptFooter(prompt: string): string {
	return prompt
		.replace(/(?:\n(?:Current (?:date(?: and time)?|working directory):[^\n]*))+$/u, "")
		.trim();
}

function makeBtwResourceLoader(
	ctx: ExtensionContext,
	appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripSystemPromptFooter(ctx.getSystemPrompt());
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => appendSystemPrompt,
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Build the initial message list for a fresh side session.
 *
 * Seeds with:
 *  1. Main session context (so BTW can reference ongoing work)
 *  2. Prior BTW thread items (for conversational continuity)
 *
 * On failure to build main context, onWarn is called and seeding continues
 * with thread items only — the side chat still works, just without history.
 */
function buildSeedMessages(
	ctx: ExtensionContext,
	thread: BtwThread,
	onWarn: (msg: string) => void,
): Message[] {
	const seed: Message[] = [];
	try {
		const { messages } = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		);
		seed.push(...messages);
	} catch (error) {
		onWarn(
			`BTW: could not seed main session context (${
				error instanceof Error ? error.message : String(error)
			}). Side chat will continue without it.`,
		);
	}
	seed.push(...thread.toMessages(ctx.model?.api ?? "openai-responses"));
	return seed;
}

// ─── Public utilities ─────────────────────────────────────────────────────────

/** Extract plain text from an assistant message content array. */
export function extractAssistantText(parts: AssistantMessage["content"]): string {
	return parts
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

/** Return the most recent assistant message in a session, or null. */
export function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const m = session.state.messages[i];
		if (m.role === "assistant") return m as AssistantMessage;
	}
	return null;
}

/**
 * Pull streamed assistant text from a raw session event message object.
 * Typed as unknown because AgentSessionEvent shapes vary across event types.
 */
export function extractStreamedText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
	return m.content
		.filter(
			(p): p is { type: "text"; text: string } =>
				!!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
		)
		.map((p) => p.text)
		.join("\n")
		.trim();
}

// ─── SideSessionManager ───────────────────────────────────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ActiveSession = {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
};

/**
 * Manages the lifecycle of the BTW side AgentSession.
 *
 * A single session is reused as long as the active model stays the same.
 * If the model changes the old session is disposed and a fresh one is created.
 */
export class SideSessionManager {
	private active: ActiveSession | null = null;

	private keyFor(ctx: ExtensionContext): string {
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	}

	/**
	 * Return the active session, creating or recreating it as needed.
	 * Seeds with main context messages plus prior BTW items.
	 */
	async ensure(
		ctx: ExtensionContext,
		thread: BtwThread,
		thinkingLevel: ThinkingLevel,
		onEvent: (event: AgentSessionEvent) => void,
		onWarn: (msg: string) => void,
	): Promise<AgentSession | null> {
		if (!ctx.model) return null;

		const expectedKey = this.keyFor(ctx);
		if (this.active?.modelKey === expectedKey) return this.active.session;

		await this.dispose();

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model: ctx.model,
			modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
			thinkingLevel,
			tools: codingTools,
			resourceLoader: makeBtwResourceLoader(ctx),
		});

		const seed = buildSeedMessages(ctx, thread, onWarn);
		if (seed.length > 0) {
			session.agent.replaceMessages(seed as typeof session.state.messages);
		}

		const unsubscribe = session.subscribe(onEvent);
		this.active = { session, modelKey: expectedKey, unsubscribe };
		return session;
	}

	/**
	 * Abort the current in-flight request without disposing the session.
	 * The session can be reused for the next prompt if the model hasn't changed.
	 * Use this for user-initiated cancellation.
	 */
	async abort(): Promise<void> {
		if (!this.active) return;
		try {
			await this.active.session.abort();
		} catch {
			/* ignore abort errors */
		}
	}

	/** Abort and fully dispose the active session. Safe when no session is active. */
	async dispose(): Promise<void> {
		const current = this.active;
		this.active = null;
		if (!current) return;
		try {
			current.unsubscribe();
		} catch {
			/* ignore cleanup errors */
		}
		try {
			await current.session.abort();
		} catch {
			/* ignore abort errors */
		}
		current.session.dispose();
	}

}

// ─── One-shot summarisation ───────────────────────────────────────────────────

/**
 * Summarise a BTW thread using a single complete() call.
 *
 * complete() is the right tool here: summarisation is a single prompt →
 * response with no tools or session state needed. Using createAgentSession
 * for this was overkill — it spins up a full agent loop, in-memory session
 * manager, and resource loader just to make one LLM call.
 *
 * @param ctx    Current extension context (provides model + auth).
 * @param text   Formatted thread text (from BtwThread.formatForSummary()).
 * @param signal Optional AbortSignal for cancellation (e.g. from BorderedLoader).
 */
export async function summarise(
	ctx: ExtensionContext,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!ctx.model) throw new Error("No active model selected.");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key available for ${ctx.model.provider}.`);

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: BTW_SUMMARY_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") throw new Error("Summary was cancelled.");
	if (response.stopReason === "error") {
		const msg = (response as { errorMessage?: string }).errorMessage;
		throw new Error(msg || "Summary request failed.");
	}

	const result = response.content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();

	return result || "(No summary generated)";
}
