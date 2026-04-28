export type ReviewWidgetStatusInput = {
	targetLabel?: string | null;
	startedAtMs: number;
	nowMs: number;
	isComplete?: boolean;
};

const HEARTBEAT_THRESHOLD_MS = 30_000;

function formatSeconds(durationMs: number): string {
	return `${Math.max(0, Math.floor(durationMs / 1000))}s`;
}

export function buildReviewWidgetLine(input: ReviewWidgetStatusInput): string {
	const elapsed = Math.max(0, input.nowMs - input.startedAtMs);
	const seconds = formatSeconds(elapsed);
	const label = input.targetLabel?.trim();
	const statusText = input.isComplete ? "📋 审查完成" : "📋 审查进行中";
	const parts = [statusText];
	if (label) parts.push(label);
	if (input.isComplete) {
		parts.push(`耗时 ${seconds}`);
	} else {
		parts.push(elapsed >= HEARTBEAT_THRESHOLD_MS ? `模型思考中 ${seconds}` : seconds);
	}
	return parts.join(" · ");
}
