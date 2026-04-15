const GLOBAL_REVIEW_WIDGET_RUNTIME_KEY = "__piReviewWidgetRuntime";

type ReviewWidgetRuntimeState = {
	generation: number;
	timer?: ReturnType<typeof setInterval>;
};

type ReviewWidgetRuntimeGlobal = typeof globalThis & {
	[GLOBAL_REVIEW_WIDGET_RUNTIME_KEY]?: ReviewWidgetRuntimeState;
};

const reviewGlobal = globalThis as ReviewWidgetRuntimeGlobal;

function runtimeState(): ReviewWidgetRuntimeState {
	const existing = reviewGlobal[GLOBAL_REVIEW_WIDGET_RUNTIME_KEY];
	if (existing) return existing;
	const state: ReviewWidgetRuntimeState = { generation: 0 };
	reviewGlobal[GLOBAL_REVIEW_WIDGET_RUNTIME_KEY] = state;
	return state;
}

export type ReviewWidgetRuntimeHandle = {
	generation: number;
	isCurrent: () => boolean;
	getTimer: () => ReturnType<typeof setInterval> | undefined;
	setTimer: (timer: ReturnType<typeof setInterval>) => void;
	clearTimer: () => void;
};

export function claimReviewWidgetRuntime(): ReviewWidgetRuntimeHandle {
	const state = runtimeState();
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	state.generation += 1;
	const generation = state.generation;
	return {
		generation,
		isCurrent: () => runtimeState().generation === generation,
		getTimer: () => runtimeState().generation === generation ? runtimeState().timer : undefined,
		setTimer: (timer) => {
			const current = runtimeState();
			if (current.generation !== generation) {
				clearInterval(timer);
				return;
			}
			if (current.timer) clearInterval(current.timer);
			current.timer = timer;
		},
		clearTimer: () => {
			const current = runtimeState();
			if (current.generation !== generation) return;
			if (current.timer) clearInterval(current.timer);
			current.timer = undefined;
		},
	};
}

export function resetReviewWidgetRuntimeForTest(): void {
	const state = runtimeState();
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	state.generation = 0;
}
