/**
 * overlay.ts — BtwOverlay TUI component.
 *
 * A floating panel hosting the BTW side-chat. Renders a scrollable transcript
 * and an inline input. All business logic lives in index.ts; this component is
 * purely presentational.
 *
 * Keyboard:
 *   ↑ / ↓      scroll transcript 3 lines per keypress
 *   Enter       submit question (delegated to inner Input)
 *   Esc         cancel in-flight request (when busy) OR close overlay (when idle)
 *   selectCancel  same as Esc (respects user keybinding remaps)
 */
import {
	Container,
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

// ─── Usage formatting ─────────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Format token usage as a compact string, e.g. "↑1.2k ↓340 $0.0012".
 * Returns empty string when usage is undefined.
 */
export function formatUsage(usage: AssistantMessage["usage"] | undefined): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

// ─── BtwOverlay ───────────────────────────────────────────────────────────────

export class BtwOverlay extends Container implements Focusable {
	/**
	 * When true, Esc triggers onCancel (abort the request) instead of
	 * onDismiss (close the overlay). Keep in sync with sideBusy in index.ts.
	 */
	busy = false;

	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (width: number, theme: Theme) => string[];
	private readonly getStatus: () => string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private readonly onCancelCallback: () => void;

	/**
	 * How many lines the viewport is scrolled above the bottom of the
	 * transcript. 0 = latest content (normal position). Higher = older content.
	 */
	private scrollOffset = 0;

	/**
	 * Maximum valid scrollOffset, recomputed each render pass.
	 * Stored so handleInput can clamp without triggering a redundant render.
	 */
	private maxScroll = 0;

	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		// Propagate to inner Input for correct IME cursor positioning.
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		getTranscript: (width: number, theme: Theme) => string[],
		getStatus: () => string,
		onSubmit: (value: string) => void,
		onDismiss: () => void,
		onCancel: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.getTranscript = getTranscript;
		this.getStatus = getStatus;
		this.onSubmitCallback = onSubmit;
		this.onDismissCallback = onDismiss;
		this.onCancelCallback = onCancel;

		this.input = new Input();
		this.input.onSubmit = (value) => this.onSubmitCallback(value);
		// Esc inside the Input delegates to the overlay's escape logic.
		this.input.onEscape = () => this.handleEscape();
	}

	// ── Input handling ────────────────────────────────────────────────────────

	handleInput(data: string): void {
		// ↑ / ↓ scroll the transcript (intercept before passing to Input).
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.min(this.scrollOffset + 3, this.maxScroll);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 3);
			this.tui.requestRender();
			return;
		}
		// selectCancel keybinding (or plain Esc via the Input's onEscape above).
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.handleEscape();
			return;
		}
		this.input.handleInput(data);
	}

	private handleEscape(): void {
		if (this.busy) {
			this.onCancelCallback();
		} else {
			this.onDismissCallback();
		}
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/** Reset scroll to bottom. Call when new content is committed to the thread. */
	resetScroll(): void {
		this.scrollOffset = 0;
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	// ── Rendering helpers ─────────────────────────────────────────────────────

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	/**
	 * A ├────┤ divider with an optional centred annotation.
	 * Used to display scroll position info, e.g. "↑ 8 above" or "↓ 3 below".
	 */
	private dividerLine(innerWidth: number, annotation = ""): string {
		if (!annotation) {
			return this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
		}
		const ann = ` ${annotation} `;
		const annWidth = visibleWidth(ann);
		const left = Math.floor((innerWidth - annWidth) / 2);
		const right = innerWidth - annWidth - left;
		return (
			this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, left))}`) +
			this.theme.fg("dim", ann) +
			this.theme.fg("borderMuted", `${"─".repeat(Math.max(0, right))}┤`)
		);
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render(width: number): string[] {
		const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
		const innerWidth = Math.max(40, dialogWidth - 2);
		const terminalRows = process.stdout.rows ?? 30;
		const dialogHeight = Math.max(16, Math.min(30, Math.floor(terminalRows * 0.75)));

		// chrome = top border + header + subtitle + 2 dividers
		//        + status + input + hint + bottom border = 9 lines
		const chromeHeight = 9;
		const transcriptHeight = Math.max(4, dialogHeight - chromeHeight);

		// ── Transcript with scrolling viewport ───────────────────────────────
		const allLines = this.getTranscript(innerWidth, this.theme);
		const totalLines = allLines.length;

		this.maxScroll = Math.max(0, totalLines - transcriptHeight);
		const clampedOffset = Math.min(this.scrollOffset, this.maxScroll);

		// startIdx: first visible line index (0 = oldest, totalLines-1 = newest)
		const startIdx = Math.max(0, totalLines - transcriptHeight - clampedOffset);
		const visibleLines = allLines.slice(startIdx, startIdx + transcriptHeight);
		const bottomPadding = Math.max(0, transcriptHeight - visibleLines.length);

		// Lines not visible: above = older content, below = newer content
		const linesAbove = startIdx;
		const linesBelow = Math.max(0, totalLines - startIdx - transcriptHeight);

		// ── Input line (rendered without cursor to get clean width) ──────────
		const prevFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? "";
		this.input.focused = prevFocused;

		// ── Context-sensitive hint ────────────────────────────────────────────
		const hint = this.busy
			? "Esc cancel request · ↑↓ scroll"
			: "Enter submit · Esc close · ↑↓ scroll";

		// ── Assemble ──────────────────────────────────────────────────────────
		const lines: string[] = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
			this.frameLine(
				this.theme.fg("dim", "Side conversation with full coding-agent access."),
				innerWidth,
			),
			this.dividerLine(innerWidth, linesAbove > 0 ? `↑ ${linesAbove} above` : ""),
		];

		for (const line of visibleLines) {
			lines.push(this.frameLine(line, innerWidth));
		}
		for (let i = 0; i < bottomPadding; i++) {
			lines.push(this.frameLine("", innerWidth));
		}

		lines.push(
			this.dividerLine(innerWidth, linesBelow > 0 ? `↓ ${linesBelow} below` : ""),
			this.frameLine(this.theme.fg("warning", this.getStatus()), innerWidth),
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
			this.frameLine(this.theme.fg("dim", hint), innerWidth),
			this.borderLine(innerWidth, "bottom"),
		);

		return lines;
	}
}
