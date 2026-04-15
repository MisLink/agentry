export interface PlanStepDraft {
	text: string;
	detail: string;
}

export type PlanExecutionMode = "tracked" | "running";

export type PlanCommand =
	| { action: "draft"; prompt?: string }
	| { action: "track" }
	| { action: "run"; prompt?: string }
	| { action: "done"; step: number }
	| { action: "clear" }
	| { action: "status" };

export function parsePlanCommand(args?: string): PlanCommand {
	const trimmed = args?.trim() ?? "";
	if (!trimmed) return { action: "draft" };

	const [command = "", ...rest] = trimmed.split(/\s+/);
	const payload = rest.join(" ").trim();
	switch (command.toLowerCase()) {
		case "track":
			return { action: "track" };
		case "run":
			return payload ? { action: "run", prompt: payload } : { action: "run" };
		case "done":
			return { action: "done", step: Number.parseInt(payload, 10) };
		case "clear":
		case "discard":
			return { action: "clear" };
		case "status":
		case "show":
			return { action: "status" };
		default:
			return { action: "draft", prompt: trimmed };
	}
}

export function shouldQueueNextStepAfterCompletion(mode: PlanExecutionMode): boolean {
	return mode === "running";
}

export function filterPlanTrackerContextMessages<T extends { customType?: string }>(messages: readonly T[], hasActivePlan: boolean): T[] {
	let lastContextIndex = -1;
	if (hasActivePlan) {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i]?.customType === "plan-tracker-context") {
				lastContextIndex = i;
				break;
			}
		}
	}

	return messages.filter((message, index) => {
		if (message.customType !== "plan-tracker-context") return true;
		if (!hasActivePlan) return false;
		return index === lastContextIndex;
	});
}
