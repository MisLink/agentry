/**
 * Notify Extension
 *
 * Sends a rich notification when pi finishes a turn and is waiting for input.
 * The notification body contains a plain-text summary of the last LLM response.
 *
 * Terminal support (in priority order):
 *   - Kitty     — `kitten notify` (rich: app name, body preview, urgency, type)
 *   - Windows   — PowerShell toast  (WT_SESSION)
 *   - Ghostty / iTerm2 / WezTerm — OSC 777
 *   - Others    — terminal bell (BEL)
 *
 * Kitty's `kitten notify` supports --app-name, --urgency, --type, --expire-after,
 * --icon, --button, etc. and works transparently over SSH.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";

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

function buildPayload(lastText: string | null): NotificationPayload {
	if (!lastText) return { title: "π", body: "Ready for input" };

	const plain = stripMarkdown(lastText).replace(/\s+/g, " ").trim();
	if (!plain) return { title: "π", body: "Ready for input" };

	const body =
		plain.length > MAX_BODY ? `${plain.slice(0, MAX_BODY - 1)}…` : plain;
	return { title: "π", body };
}

// ── Notification backends ──────────────────────────────────────────────────

/**
 * Kitty: use `kitten notify` for full desktop notification support.
 * Supports app-name, type (for user filter rules), urgency, icon,
 * expire-after, and works over SSH transparently.
 * kitten is always available when KITTY_WINDOW_ID is set.
 */
function notifyKitten(title: string, body: string): void {
	execFile(
		"kitten",
		[
			"notify",
			"--app-name=pi",
			"--type=pi-agent-ready", // users can create filter rules based on this
			"--urgency=normal",
			"--expire-after=30s",
			title,
			body,
		],
		{ timeout: 5000 },
		// fire-and-forget: ignore errors silently
	);
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

function notify(title: string, body: string): void {
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

// ── Extension entry point ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		const lastText = extractLastAssistantText(
			(event.messages ?? []) as Array<{ role?: string; content?: unknown }>,
		);
		const { title, body } = buildPayload(lastText);
		notify(title, body);
	});
}
