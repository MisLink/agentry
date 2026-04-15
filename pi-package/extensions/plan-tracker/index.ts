/**
 * Plan Tracker Extension
 *
 * Non-modal plan tracking that integrates naturally into conversations.
 * The AI creates plans via the `create_plan` tool, the user tracks progress
 * via widget + mark_done.
 *
 * Features:
 * - create_plan tool: AI outputs structured plan steps directly (zero extra cost)
 * - mark_done tool: AI reports step completion with optional summary
 * - /plan <msg>: request a plan from the AI
 * - /todos: view current plan progress
 * - /done N: manually mark a step as complete
 * - Progress widget + footer status
 * - Work log on plan completion
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { notifyBeforePrompt } from "../notify/index.js";
import { filterPlanTrackerContextMessages, getTrackingExecutionOptions, insertPlanStepsAfterCurrent, replaceRemainingSteps, shouldAutoPlan, type PlanStepDraft } from "./logic.js";
import { formatElapsed, type PlanStep } from "./utils.js";

export default function planTrackerExtension(pi: ExtensionAPI): void {
	let steps: PlanStep[] = [];
	let planStartedAt = 0;
	let pauseOnStep = false;
	let skipConfirmations = false;
	let pendingRefine = false;
	let lastUserPrompt = "";

	// ── State persistence ──────────────────────────────────────────────────

	let lastPersisted = "";
	function persist(): void {
		const state = JSON.stringify({ steps, startedAt: planStartedAt });
		if (state === lastPersisted) return;
		lastPersisted = state;
		pi.appendEntry("plan-tracker", JSON.parse(state));
	}

	// ── UI updates ─────────────────────────────────────────────────────────

	function updateUI(ctx: ExtensionContext): void {
		if (steps.length === 0) {
			ctx.ui.setStatus("plan-tracker", undefined);
			ctx.ui.setWidget("plan-tracker", undefined);
			return;
		}

		const done = steps.filter((s) => s.completed).length;
		ctx.ui.setStatus("plan-tracker", ctx.ui.theme.fg("accent", `📋 ${done}/${steps.length}`));

		const lines = steps.map((item) => {
			if (item.completed) {
				const check = ctx.ui.theme.fg("success", "☑ ");
				const text = ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
				const summary = item.summary ? ctx.ui.theme.fg("muted", ` → ${item.summary}`) : "";
				return check + text + summary;
			}
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
		});
		ctx.ui.setWidget("plan-tracker", lines);
	}

	// ── Plan helpers ───────────────────────────────────────────────────────

	function getRemainingSteps(): PlanStep[] {
		return steps.filter((step) => !step.completed);
	}

	function getCurrentStep(): PlanStep | undefined {
		return getRemainingSteps()[0];
	}

	function setPlan(newSteps: PlanStep[], ctx: ExtensionContext): void {
		steps = newSteps;
		updateUI(ctx);
		persist();
	}

	function queueExecution(step: PlanStep, feedback?: string): void {
		let content = `Continue the plan. Execute step ${step.step}: ${step.detail}`;
		if (feedback) {
			content += `\n\nUser feedback for this step: ${feedback}`;
		}
		pi.sendMessage(
			{
				customType: "plan-tracker-execute",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	function activatePlan(newSteps: PlanStep[], pause: boolean, ctx: ExtensionContext): void {
		planStartedAt = Date.now();
		pauseOnStep = pause;
		skipConfirmations = !pause;
		setPlan(newSteps, ctx);
	}

	function clearPlan(ctx: ExtensionContext): void {
		steps = [];
		planStartedAt = 0;
		pauseOnStep = false;
		skipConfirmations = false;
		updateUI(ctx);
		persist();
	}

	function buildWorkLog(): string {
		const elapsed = formatElapsed(Date.now() - planStartedAt);
		const header = `📋 Plan Complete (${steps.length}/${steps.length}) — ${elapsed}`;
		const lines = steps.map((s) => {
			const summary = s.summary ? ` → ${s.summary}` : "";
			return ` ${s.step}. ✓ ${s.text}${summary}`;
		});
		return `**${header}**\n\n${lines.join("\n")}`;
	}

	function buildPlanDrafts(inputSteps: { text: string; detail: string }[]): PlanStepDraft[] {
		return inputSteps.map((step) => ({
			text: step.text.slice(0, 60),
			detail: step.detail,
		}));
	}

	function materializePlanSteps(drafts: readonly PlanStepDraft[]): PlanStep[] {
		return drafts.map((step, index) => ({
			step: index + 1,
			text: step.text.slice(0, 60),
			detail: step.detail,
			completed: false,
		}));
	}

	// ── Offer tracking mode selection ──────────────────────────────────────

	type TrackingChoice = "execute" | "refine" | "ignore";
	type ActivePlanChoice = "continue-current" | "insert-after-current" | "replace-remaining" | "ignore-new";

	/** User feedback collected during input phase, available after offerTracking returns "refine". */
	let lastRefineFeedback = "";

	async function offerTracking(planSteps: PlanStep[], isRefine: boolean, ctx: ExtensionContext): Promise<TrackingChoice> {
		const planList = planSteps.map((step) => `  ${step.step}. ${step.text}`).join("\n");

		const inputPrompt = isRefine
			? `修改后的计划（${planSteps.length} 步）：\n${planList}\n\n还要补充什么？（直接回车跳过）`
			: `计划（${planSteps.length} 步）：\n${planList}\n\n要补充什么？（直接回车跳过）`;
		const feedback = await notifyBeforePrompt(inputPrompt, () => ctx.ui.input(inputPrompt));
		if (feedback?.trim()) {
			lastRefineFeedback = feedback.trim();
			return "refine";
		}

		const choice = await notifyBeforePrompt("如何执行？", () => ctx.ui.select("如何执行？", getTrackingExecutionOptions(isRefine)));
		if (!choice || choice === "忽略") return "ignore";

		const pause = choice.startsWith("逐步");
		activatePlan(planSteps, pause, ctx);

		const first = getCurrentStep();
		if (!first) {
			throw new Error("Activated plan is missing its first step");
		}
		queueExecution(first);
		return "execute";
	}

	async function resolveActivePlanChoice(ctx: ExtensionContext): Promise<ActivePlanChoice> {
		if (!ctx.hasUI) return "continue-current";

		const choice = await notifyBeforePrompt(
			"已有执行计划，怎么处理新计划？",
			() => ctx.ui.select("已有执行计划，怎么处理新计划？", [
				"继续当前计划",
				"插入到当前步骤之后",
				"替换剩余步骤",
				"忽略新计划",
			]),
		);

		if (choice === "插入到当前步骤之后") return "insert-after-current";
		if (choice === "替换剩余步骤") return "replace-remaining";
		if (choice === "忽略新计划") return "ignore-new";
		return "continue-current";
	}

	// ── create_plan tool ───────────────────────────────────────────────────

	pi.registerTool({
		name: "create_plan",
		label: "Create Plan",
		description:
			"Create a tracked execution plan only when the user explicitly asks for a plan, " +
			"or when the task is non-trivial, spans multiple dependent steps, and clearly benefits from tracking.",
		promptSnippet: "create_plan({ steps }) - create a tracked execution plan for non-trivial, multi-step work",
		promptGuidelines: [
			"Only call create_plan when the user explicitly asks for a plan, or when the task is non-trivial, spans multiple dependent steps, and would benefit from explicit tracking.",
			"Do not use create_plan for small fixes, single-file edits, routine questions, simple code reading, or straightforward execution.",
			"Each step should have a short 'text' (≤60 chars, for the progress widget) and a detailed 'detail' (full description with enough context to execute).",
			"If a tracked plan is already active, do not open a second plan for routine sub-work. Continue current plan unless it truly needs to be extended or replaced.",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					text: Type.String({ description: "Short step summary (≤60 chars) for the progress widget" }),
					detail: Type.String({ description: "Full step description with enough context to execute" }),
				}),
				{ description: "Ordered list of plan steps", minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const drafts = buildPlanDrafts(params.steps);
			const isRefine = pendingRefine;
			pendingRefine = false;

			if (!isRefine) {
				const decision = shouldAutoPlan({
					prompt: lastUserPrompt,
					steps: drafts,
					hasActivePlan: steps.length > 0,
				});
				if (!decision.allow) {
					const current = getCurrentStep();
					const baseMessage =
						decision.reason === "straightforward-task"
							? "Skip tracked plan: current task looks straightforward. Continue execution directly unless user explicitly asks for a plan."
							: "Skip tracked plan: task is not complex enough for explicit plan tracking yet. Continue execution directly. If complexity grows, you can propose a plan later.";
					const currentMessage = current
						? `\n\nCurrent tracked step: ${current.step}. ${current.text}`
						: "";
					return {
						content: [{ type: "text", text: `${baseMessage}${currentMessage}` }],
						details: { success: false, skipped: true, reason: decision.reason, signals: decision.signals },
					};
				}
			}

			if (steps.length > 0) {
				const activeChoice = await resolveActivePlanChoice(ctx);
				if (activeChoice === "continue-current") {
					const current = getCurrentStep();
					const nextText = current ? ` Continue with step ${current.step}: ${current.detail}` : " Continue current plan.";
					return {
						content: [{ type: "text", text: `A tracked plan is already active.${nextText}` }],
						details: { success: false, reason: "continue-current-plan" },
					};
				}
				if (activeChoice === "ignore-new") {
					return {
						content: [{ type: "text", text: "User ignored the new plan proposal. Continue current work." }],
						details: { success: false, reason: "ignore-new-plan" },
					};
				}

				const mergedSteps =
					activeChoice === "insert-after-current"
						? insertPlanStepsAfterCurrent(steps, drafts)
						: replaceRemainingSteps(steps, drafts);
				setPlan(mergedSteps, ctx);

				const remaining = getRemainingSteps();
				const remainingList = remaining.map((step) => `${step.step}. ${step.text}`).join("\n");
				const actionText =
					activeChoice === "insert-after-current"
						? "Plan updated by inserting new steps after current step."
						: "Plan updated by replacing remaining steps.";
				return {
					content: [{ type: "text", text: `${actionText}\n\n${remainingList}` }],
					details: { success: true, merged: true, mode: activeChoice, stepCount: mergedSteps.length },
				};
			}

			const planSteps = materializePlanSteps(drafts);
			const choice = await offerTracking(planSteps, isRefine, ctx);

			if (choice === "refine") {
				pendingRefine = true;
				const list = planSteps.map((step) => `${step.step}. ${step.text} — ${step.detail}`).join("\n");
				const feedback = lastRefineFeedback;
				lastRefineFeedback = "";
				return {
					content: [{ type: "text", text: `User wants to refine the plan before starting. Current draft:\n${list}\n\nUser feedback: ${feedback}\n\nRevise the plan based on this feedback, then call create_plan again with the revised steps.` }],
					details: { success: false, reason: "refine" },
				};
			}

			if (steps.length > 0) {
				const list = steps.map((step) => `${step.step}. ${step.text}`).join("\n");
				return {
					content: [{ type: "text", text: `Plan created (${steps.length} steps):\n${list}` }],
					details: { success: true, stepCount: steps.length },
				};
			}

			return {
				content: [{ type: "text", text: "Plan was not activated (user chose to ignore)." }],
				details: { success: false },
			};
		},
	});

	// ── mark_done tool ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "mark_done",
		label: "Mark Step Done",
		description: "Mark a plan step as completed. Call this immediately after finishing each step during plan execution.",
		promptSnippet: "mark_done(step) - report a plan step as completed",
		promptGuidelines: [
			"Only call mark_done when there is an active tracked plan. If no plan is being tracked, ignore this tool.",
			"After calling mark_done, continue with the next tracked step unless the user explicitly paused execution.",
		],
		parameters: Type.Object({
			step: Type.Number({ description: "The step number to mark as completed" }),
			summary: Type.Optional(Type.String({ description: "Brief summary of what was accomplished (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (steps.length === 0) {
				return {
					content: [{ type: "text", text: "No plan is currently being tracked." }],
					details: { success: false },
				};
			}

			const item = steps.find((step) => step.step === params.step);
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
			item.completedAt = Date.now();
			if (params.summary) item.summary = params.summary;
			updateUI(ctx);
			persist();

			const message = params.summary
				? `✓ Step ${params.step} complete: ${params.summary}`
				: `✓ Step ${params.step} marked complete.`;

			if (steps.every((step) => step.completed)) {
				const log = buildWorkLog();
				pi.sendMessage(
					{ customType: "plan-tracker-complete", content: log, display: true },
					{ triggerTurn: false },
				);
				clearPlan(ctx);
				return {
					content: [{ type: "text", text: `${message}\n\nAll steps complete!` }],
					details: { success: true, step: params.step, planComplete: true },
				};
			}

			const nextStep = getCurrentStep();
			if (!nextStep) {
				throw new Error("Plan is missing the next pending step after mark_done");
			}

			let feedbackForNextStep = "";
			let paused = false;

			if (!skipConfirmations && pauseOnStep) {
				const nextPrompt = `${message}\n\nNext: Step ${nextStep.step} — ${nextStep.text}`;
				const choice = await notifyBeforePrompt(
					nextPrompt,
					() => ctx.ui.select(nextPrompt, ["Continue", "Run all remaining", "Stop here", "Give feedback"]),
				);
				if (choice === "Run all remaining") {
					skipConfirmations = true;
				} else if (choice === "Stop here") {
					ctx.abort();
					paused = true;
				} else if (choice === "Give feedback") {
					const feedback = await notifyBeforePrompt("Feedback for next step:", () => ctx.ui.input("Feedback for next step:"));
					feedbackForNextStep = feedback?.trim() ?? "";
				}
			}

			if (paused) {
				return {
					content: [{ type: "text", text: `${message}\n\nExecution paused by user.` }],
					details: { success: true, step: params.step, paused: true },
				};
			}

			queueExecution(nextStep, feedbackForNextStep || undefined);
			const feedbackText = feedbackForNextStep ? `\nUser feedback: ${feedbackForNextStep}` : "";
			return {
				content: [{ type: "text", text: `${message}${feedbackText}\n\nQueued step ${nextStep.step}.` }],
				details: { success: true, step: params.step, nextStep: nextStep.step },
			};
		},
	});

	// ── /plan command ──────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Request a plan: /plan <message>",
		handler: async (args, ctx) => {
			const message = args?.trim();
			if (!message) {
				ctx.ui.notify("Usage: /plan <message>  — e.g. /plan 重构登录模块", "info");
				return;
			}
			pi.sendUserMessage(`请分析以下任务并制定执行计划，使用 create_plan 工具输出：\n\n${message}`);
		},
	});

	// ── /todos command ─────────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (steps.length === 0) {
				ctx.ui.notify("No active plan. Ask the AI to create one with /plan or by requesting a tracked plan.", "info");
				return;
			}
			const done = steps.filter((step) => step.completed).length;
			const elapsed = formatElapsed(Date.now() - planStartedAt);
			const list = steps
				.map((step) => {
					const check = step.completed ? "✓" : "○";
					const summary = step.completed && step.summary ? ` → ${step.summary}` : "";
					return `  ${step.step}. ${check} ${step.text}${summary}`;
				})
				.join("\n");
			ctx.ui.notify(`Plan Progress (${done}/${steps.length}) — ${elapsed}\n\n${list}`, "info");
		},
	});

	// ── /done command ──────────────────────────────────────────────────────

	pi.registerCommand("done", {
		description: "Manually mark a plan step as complete: /done <step>",
		handler: async (args, ctx) => {
			if (steps.length === 0) {
				ctx.ui.notify("No active plan.", "info");
				return;
			}
			const n = parseInt(args?.trim() ?? "", 10);
			if (isNaN(n) || n < 1) {
				ctx.ui.notify("Usage: /done <step number>", "error");
				return;
			}
			const item = steps.find((step) => step.step === n);
			if (!item) {
				ctx.ui.notify(`Step ${n} not found.`, "error");
				return;
			}
			if (item.completed) {
				ctx.ui.notify(`Step ${n} is already complete.`, "info");
				return;
			}
			item.completed = true;
			item.completedAt = Date.now();
			updateUI(ctx);
			persist();
			ctx.ui.notify(`✓ Step ${n} marked complete.`, "info");

			if (steps.every((step) => step.completed)) {
				const log = buildWorkLog();
				pi.sendMessage(
					{ customType: "plan-tracker-complete", content: log, display: true },
					{ triggerTurn: false },
				);
				clearPlan(ctx);
			}
		},
	});

	// ── Context injection ──────────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		lastUserPrompt = event.prompt;
		if (steps.length === 0) return;

		const remaining = getRemainingSteps();
		if (remaining.length === 0) return;

		const done = steps.filter((step) => step.completed).length;
		const current = remaining[0];
		const next = remaining.length > 1 ? remaining[1] : null;

		let content = `[Plan Progress: ${done}/${steps.length} complete]\n`;
		content += `Current: Step ${current.step} — ${current.detail}\n`;
		if (next) content += `Next: Step ${next.step} — ${next.detail}\n`;
		content += "\nAfter completing each step, call mark_done(step) with a brief summary.";
		content += " Do not create a new plan for routine substeps while this tracked plan is active.";

		return {
			message: {
				customType: "plan-tracker-context",
				content,
				display: false,
			},
		};
	});

	// ── Filter stale context messages ──────────────────────────────────────

	pi.on("context", async (event) => {
		return {
			messages: filterPlanTrackerContextMessages(event.messages as (AgentMessage & { customType?: string })[], steps.length > 0),
		};
	});

	// ── Session restore ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		const stateEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "plan-tracker")
			.pop() as { data?: { steps?: PlanStep[]; startedAt?: number } } | undefined;

		if (stateEntry?.data?.steps && stateEntry.data.steps.length > 0) {
			steps = stateEntry.data.steps;
			planStartedAt = stateEntry.data.startedAt ?? Date.now();
			pauseOnStep = false;
			skipConfirmations = false;
		}

		updateUI(ctx);
	});
}
