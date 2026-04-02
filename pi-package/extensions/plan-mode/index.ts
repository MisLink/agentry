/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { extractTodoItems, isSafeCommand, type TodoItem } from "./utils.js";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const EXECUTION_MODE_TOOLS = [...NORMAL_MODE_TOOLS, "mark_done"];

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		// Warn before discarding in-progress execution
		if (executionMode && todoItems.some((t) => !t.completed)) {
			const remaining = todoItems.filter((t) => !t.completed).length;
			const ok = await ctx.ui.confirm(
				"Abandon plan?",
				`${remaining} step${remaining > 1 ? "s" : ""} not yet complete. Discard progress?`,
			);
			if (!ok) return;
		}

		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	let lastPersistedState = "";
	function persistState(): void {
		const state = JSON.stringify({ enabled: planModeEnabled, todos: todoItems, executing: executionMode });
		if (state === lastPersistedState) return;
		lastPersistedState = state;
		pi.appendEntry("plan-mode", JSON.parse(state));
	}

	pi.registerTool({
		name: "mark_done",
		label: "Mark Step Done",
		description: "Mark a plan step as completed. Call this immediately after finishing each step during plan execution.",
		promptSnippet: "mark_done(step) - report a plan step as completed",
		parameters: Type.Object({
			step: Type.Number({ description: "The step number to mark as completed" }),
			summary: Type.Optional(Type.String({ description: "Brief summary of what was accomplished (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!executionMode || todoItems.length === 0) {
				return {
					content: [{ type: "text", text: "No plan is currently being executed." }],
					details: { success: false },
				};
			}
			const item = todoItems.find((t) => t.step === params.step);
			if (!item) {
				return {
					content: [{ type: "text", text: `Step ${params.step} not found in current plan.` }],
					details: { success: false },
				};
			}
			if (item.completed) {
				return {
					content: [{ type: "text", text: `Step ${params.step} is already marked complete.` }],
					details: { success: true, step: params.step, alreadyDone: true },
				};
			}
			item.completed = true;
			updateStatus(ctx);
			persistState();
			const message = params.summary
				? `✓ Step ${params.step} complete: ${params.summary}`
				: `✓ Step ${params.step} marked complete.`;
			return {
				content: [{ type: "text", text: message }],
				details: { success: true, step: params.step },
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or submit a plan request: /plan <message>",
		handler: async (args, ctx) => {
			const message = args?.trim();
			if (!message) {
				return togglePlanMode(ctx);
			}
			// Enable plan mode silently if not already active
			if (!planModeEnabled) {
				planModeEnabled = true;
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(PLAN_MODE_TOOLS);
				updateStatus(ctx);
				persistState();
			}
			pi.sendUserMessage(message);
		},
	});

	pi.registerCommand("done", {
		description: "Manually mark a plan step as complete, e.g. /done 2",
		handler: async (args, ctx) => {
			if (!executionMode || todoItems.length === 0) {
				ctx.ui.notify("No plan is currently being executed.", "info");
				return;
			}
			const n = parseInt(args?.trim() ?? "", 10);
			if (isNaN(n) || n < 1) {
				ctx.ui.notify("Usage: /done <step number>, e.g. /done 2", "error");
				return;
			}
			const item = todoItems.find((t) => t.step === n);
			if (!item) {
				ctx.ui.notify(`Step ${n} not found in current plan.`, "error");
				return;
			}
			if (item.completed) {
				ctx.ui.notify(`Step ${n} is already marked complete.`, "info");
				return;
			}
			item.completed = true;
			updateStatus(ctx);
			persistState();
			ctx.ui.notify(`✓ Step ${n} marked complete.`, "info");
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan/execution context messages when no longer relevant
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				// Remove plan-mode-context when not in plan mode
				if (msg.customType === "plan-mode-context" && !planModeEnabled) return false;
				// Remove plan-execution-context when not in execution mode
				if (msg.customType === "plan-execution-context" && !executionMode) return false;
				if (msg.role !== "user") return true;

				if (!planModeEnabled) {
					const content = msg.content;
					if (typeof content === "string") {
						return !content.includes("[PLAN MODE ACTIVE]");
					}
					if (Array.isArray(content)) {
						return !content.some(
							(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
						);
					}
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.fullText ?? t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing each step, call mark_done(step) to record your progress.`,
					display: false,
				},
			};
		}
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		// Show plan steps and prompt for next action
		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(executionMode ? EXECUTION_MODE_TOOLS : NORMAL_MODE_TOOLS);
			updateStatus(ctx);

			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		} else if (executionMode) {
			pi.setActiveTools(EXECUTION_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
