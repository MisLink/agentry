/**
 * Notify Extension
 *
 * Sends a desktop notification when pi finishes a turn and is waiting for input.
 * The notification body contains a plain-text summary of the last LLM response.
 *
 * Terminal support (in priority order):
 *   - Kitty     — OSC 99 via `kitten notify --only-print-escape-code`
 *   - Windows   — PowerShell toast (WT_SESSION)
 *   - Ghostty / iTerm2 / WezTerm — OSC 777
 *   - Others    — terminal bell (BEL)
 *
 * NOTE: `kitten notify` without `--only-print-escape-code` opens /dev/tty
 * directly, which fails inside pi's extension environment (no controlling
 * terminal). We use `--only-print-escape-code` to capture the OSC 99
 * escape sequence and write it to process.stdout ourselves.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { execFile, execFileSync } from "node:child_process";
import { detectFocusMode, focusStatusIcon } from "./focus-mode.ts";

// ── Message extraction ─────────────────────────────────────────────────────

const isTextPart = (p: unknown): p is { type: "text"; text: string } =>
	Boolean(
		p &&
			typeof p === "object" &&
			"type" in p &&
			(p as Record<string, unknown>).type === "text" &&
			"text" in p,
	);

function extractLastAssistantText(
	messages: Array<{ role?: string; content?: unknown }>,
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const { content } = msg;
		if (typeof content === "string") return content.trim() || null;
		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((p) => p.text)
				.join("\n")
				.trim();
			return text || null;
		}
		return null;
	}
	return null;
}

// ── Markdown → plain text ─────────────────────────────────────────────────

const plainTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

function stripMarkdown(text: string, width = 120): string {
	return new Markdown(text, 0, 0, plainTheme).render(width).join("\n");
}

// ── Payload builder ────────────────────────────────────────────────────────

interface NotificationPayload {
	title: string;
	body: string;
}

const MAX_BODY = 200;

export function buildPayload(lastText: string | null): NotificationPayload | null {
	if (!lastText) return null;

	const plain = stripMarkdown(lastText).replace(/\s+/g, " ").trim();
	if (!plain) return null;

	const body =
		plain.length > MAX_BODY ? `${plain.slice(0, MAX_BODY - 1)}…` : plain;
	return { title: "π", body };
}

export function buildAttentionPayload(promptTitle: string): NotificationPayload {
	const plain = promptTitle.replace(/\s+/g, " ").trim();
	const body = plain ? `Waiting for input: ${plain}` : "Waiting for input";
	return body.length > MAX_BODY
		? { title: "π", body: `${body.slice(0, MAX_BODY - 1)}…` }
		: { title: "π", body };
}

export async function notifyBeforePrompt<T>(
	promptTitle: string,
	waitForUser: () => Promise<T>,
	send: (title: string, body: string) => void = notify,
): Promise<T> {
	const payload = buildAttentionPayload(promptTitle);
	send(payload.title, payload.body);
	return waitForUser();
}

// ── Notification backends ──────────────────────────────────────────────────

type KittyExec = (
	file: string,
	args: string[],
	options: { encoding: "utf8"; timeout: number },
) => string;

type CommandExec = (
	file: string,
	args: string[],
	options: { encoding: "utf8"; timeout: number },
) => string;

/**
 * Kitty: generate OSC 99 escape sequence via `kitten notify --only-print-escape-code`.
 * Synchronous path avoids losing notification escape codes after agent_end.
 */
export function getKittyEscapeCode(
	title: string,
	body: string,
	run: KittyExec = (file, args, options) => execFileSync(file, args, options),
): string | null {
	try {
		const stdout = run(
			"kitten",
			[
				"notify",
				"--only-print-escape-code",
				"--app-name=pi",
				"--type=pi-agent-ready",
				"--urgency=normal",
				"--expire-after=30s",
				title,
				body,
			],
			{ encoding: "utf8", timeout: 5000 },
		);
		return stdout || null;
	} catch {
		return null;
	}
}

/**
 * Kitty: generate OSC 99 escape sequence via `kitten notify --only-print-escape-code`,
 * then write it to stdout ourselves.
 */
function notifyKitten(title: string, body: string): void {
	const escapeCode = getKittyEscapeCode(title, body);
	if (!escapeCode) {
		// Fallback: raw OSC 99 without kitten
		notifyOSC99(title, body);
		return;
	}
	process.stdout.write(escapeCode);
}

/**
 * Raw OSC 99 (kitty desktop notification protocol).
 * Fallback when `kitten` command is unavailable.
 * Uses the simple single-payload form (title only, body appended).
 */
function notifyOSC99(title: string, body: string): void {
	const text = body ? `${title}: ${body}` : title;
	// d=0 means complete (non-chunked) notification
	process.stdout.write(`\x1b]99;d=0;${text}\x1b\\`);
}

/** Windows Terminal: PowerShell toast notification. */
function notifyWindows(title: string, body: string): void {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const tmpl = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	const script = [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${tmpl})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-Command", script]);
}

/** Ghostty / iTerm2 / WezTerm / rxvt-unicode via OSC 777. */
function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

/** Universal fallback: audible terminal bell. */
function notifyBell(): void {
	process.stdout.write("\x07");
}

function isFocusedKittyWindow(raw: string, currentWindowId: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}

	if (!Array.isArray(parsed)) return false;

	for (const osWindow of parsed) {
		if (!osWindow || typeof osWindow !== "object" || !Array.isArray((osWindow as { tabs?: unknown }).tabs)) {
			continue;
		}
		for (const tab of (osWindow as { tabs: Array<{ windows?: unknown }> }).tabs) {
			if (!tab || typeof tab !== "object" || !Array.isArray(tab.windows)) continue;
			for (const window of tab.windows) {
				if (!window || typeof window !== "object") continue;
				const id = (window as { id?: unknown }).id;
				const isFocused = (window as { is_focused?: unknown }).is_focused;
				if (typeof id === "number" && String(id) === currentWindowId && isFocused === true) {
					return true;
				}
			}
		}
	}

	return false;
}

export function shouldSendNotification(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
	run: CommandExec = (file, args, options) => execFileSync(file, args, options),
): boolean {
	const currentWindowId = env.KITTY_WINDOW_ID?.trim();
	const kittyListenOn = env.KITTY_LISTEN_ON?.trim();

	if (currentWindowId && kittyListenOn) {
		try {
			const focused = run(
				"kitten",
				["@", "--to", kittyListenOn, "ls", "--match", "state:focused"],
				{ encoding: "utf8", timeout: 5000 },
			);
			if (isFocusedKittyWindow(focused, currentWindowId)) return false;
			return true;
		} catch {
			// Fall through to platform-specific checks below.
		}
	}

	if (platform === "darwin") {
		try {
			const frontmostApp = run(
				"osascript",
				[
					"-e",
					'tell application "System Events" to get name of first application process whose frontmost is true',
				],
				{ encoding: "utf8", timeout: 5000 },
			)
				.trim()
				.toLowerCase();
			if (frontmostApp === "kitty") return false;
		} catch {
			// If frontmost-app detection fails, prefer sending notification.
		}
	}

	return true;
}

function notify(title: string, body: string): void {
	if (!shouldSendNotification(process.env, process.platform)) return;

	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyKitten(title, body);
	} else if (
		process.env.TERM_PROGRAM === "iTerm.app" ||
		process.env.TERM_PROGRAM === "WezTerm" ||
		process.env.TERM === "xterm-ghostty" ||
		process.env.COLORTERM === "truecolor"
	) {
		notifyOSC777(title, body);
	} else {
		notifyBell();
	}
}

// ── Focus indicator ───────────────────────────────────────────────────────

const FOCUS_STATUS_KEY = "notify-focus";
const FOCUS_POLL_MS = 15_000;

async function updateFocusIndicator(ctx: ExtensionContext): Promise<void> {
	const state = await detectFocusMode();
	const icon = focusStatusIcon(state);
	if (!icon) {
		ctx.ui.setStatus(FOCUS_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(FOCUS_STATUS_KEY, ctx.ui.theme.fg("warning", icon));
}

// ── Extension entry point ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let focusPollTimer: ReturnType<typeof setInterval> | undefined;

	function stopFocusPolling(ctx?: ExtensionContext): void {
		if (focusPollTimer) {
			clearInterval(focusPollTimer);
			focusPollTimer = undefined;
		}
		ctx?.ui.setStatus(FOCUS_STATUS_KEY, undefined);
	}

	function startFocusPolling(ctx: ExtensionContext): void {
		stopFocusPolling(ctx);
		void updateFocusIndicator(ctx);
		focusPollTimer = setInterval(() => {
			void updateFocusIndicator(ctx);
		}, FOCUS_POLL_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		startFocusPolling(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopFocusPolling(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const lastText = extractLastAssistantText(
			(event.messages ?? []) as Array<{ role?: string; content?: unknown }>,
		);
		const payload = buildPayload(lastText);
		if (!payload) {
			await updateFocusIndicator(ctx);
			return;
		}
		notify(payload.title, payload.body);
		await updateFocusIndicator(ctx);
	});
}
