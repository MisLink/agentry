/**
 * thread.ts — BTW side-thread state management.
 *
 * BtwThread encapsulates all mutable state for the side conversation:
 * committed Q&A items, in-flight (pending) state, and session
 * persistence/restore. No pi-coding-agent or TUI imports here — pure logic.
 */
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

// ─── Constants ────────────────────────────────────────────────────────────────

export const BTW_ENTRY_TYPE = "btw-thread-entry";
export const BTW_RESET_TYPE = "btw-thread-reset";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	/** Short human-readable summary of the arguments. */
	args: string;
	status: "running" | "done" | "error";
};

export type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	usage?: AssistantMessage["usage"];
};

export type BtwResetDetails = { timestamp: number };

type SessionEntry = { type: string; customType?: string; data?: unknown };

// ─── BtwThread ────────────────────────────────────────────────────────────────

export class BtwThread {
	/** Committed Q&A pairs, oldest first. */
	readonly items: BtwDetails[] = [];

	/** The question currently in flight. null when idle. */
	pendingQuestion: string | null = null;

	/** Answer text streaming in from the active request. */
	pendingAnswer = "";

	/** Error message from the most recent failed request; null otherwise. */
	pendingError: string | null = null;

	/** Tool calls tracked during the current in-flight request. */
	readonly pendingToolCalls: ToolCallInfo[] = [];

	/** Usage stats from the most recently completed response. */
	lastUsage: AssistantMessage["usage"] | undefined = undefined;

	get isEmpty(): boolean {
		return this.items.length === 0 && this.pendingQuestion === null;
	}

	get hasPending(): boolean {
		return this.pendingQuestion !== null;
	}

	// ── Mutations ─────────────────────────────────────────────────────────────

	/** Clear all state including committed items. */
	reset(): void {
		this.items.length = 0;
		this.lastUsage = undefined;
		this.clearPending();
	}

	/** Clear only in-flight state; committed items remain. */
	clearPending(): void {
		this.pendingQuestion = null;
		this.pendingAnswer = "";
		this.pendingError = null;
		this.pendingToolCalls.length = 0;
	}

	/**
	 * Commit a completed Q&A pair and clear the pending state.
	 * Call after a side session response finishes successfully.
	 */
	commitPending(details: BtwDetails): void {
		this.items.push(details);
		this.lastUsage = details.usage;
		this.clearPending();
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	/**
	 * Restore thread state from a session branch.
	 * Finds the most recent reset marker, then replays BTW entries since that point.
	 */
	restore(branch: SessionEntry[]): void {
		this.reset();
		let lastResetIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			if (branch[i].type === "custom" && branch[i].customType === BTW_RESET_TYPE) {
				lastResetIndex = i;
			}
		}
		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) continue;
			const data = entry.data as BtwDetails | undefined;
			if (!data?.question || !data.answer) continue;
			this.items.push(data);
		}
		if (this.items.length > 0) {
			this.lastUsage = this.items[this.items.length - 1].usage;
		}
	}

	// ── Serialisation ─────────────────────────────────────────────────────────

	/**
	 * Render committed items as Message objects for seeding the side session.
	 * @param api — AI API identifier from ctx.model.api (e.g. "openai-responses").
	 */
	toMessages(api: string): Message[] {
		return this.items.flatMap((item): Message[] => [
			{
				role: "user",
				content: [{ type: "text", text: item.question }],
				timestamp: item.timestamp,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: item.answer }],
				provider: item.provider,
				model: item.model,
				api,
				usage: item.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: item.timestamp,
			},
		]);
	}

	/** Format all items as plain text for the summarisation prompt. */
	formatForSummary(): string {
		return this.items
			.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
			.join("\n\n---\n\n");
	}

	/** Sum token usage across all committed items. */
	totalUsage(): { input: number; output: number; cost: number } {
		return this.items.reduce(
			(acc, item) => ({
				input: acc.input + (item.usage?.input ?? 0),
				output: acc.output + (item.usage?.output ?? 0),
				cost: acc.cost + (item.usage?.cost?.total ?? 0),
			}),
			{ input: 0, output: 0, cost: 0 },
		);
	}
}
