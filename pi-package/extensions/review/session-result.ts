type SessionMessage = {
	role?: string;
	content?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(
		part
			&& typeof part === "object"
			&& "type" in part
			&& (part as Record<string, unknown>).type === "text"
			&& "text" in part
			&& typeof (part as { text?: unknown }).text === "string",
	);

function extractContentText(content: unknown): string | null {
	if (typeof content === "string") return content.trim() || null;
	if (!Array.isArray(content)) return null;
	const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
	return text || null;
}

function findLastMessage(messages: SessionMessage[], role: "assistant" | "user"): SessionMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === role) return message;
	}
	return null;
}

export function extractLastMessageText(messages: SessionMessage[], role: "assistant" | "user"): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== role) continue;
		const text = extractContentText(message.content);
		if (text) return text;
	}
	return null;
}

export function extractLastAssistantText(messages: SessionMessage[]): string | null {
	return extractLastMessageText(messages, "assistant");
}

export function extractLastUserText(messages: SessionMessage[]): string | null {
	return extractLastMessageText(messages, "user");
}

export function extractRequiredAssistantText(messages: SessionMessage[], taskLabel: string): string {
	const assistant = findLastMessage(messages, "assistant");
	if (!assistant) throw new Error(`${taskLabel} completed without an assistant message`);

	const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : undefined;
	const errorMessage = typeof assistant.errorMessage === "string" ? assistant.errorMessage.trim() : "";
	if (stopReason === "error" || stopReason === "aborted") {
		throw new Error(`${taskLabel} failed: ${errorMessage || `stopReason=${stopReason}`}`);
	}

	const text = extractContentText(assistant.content);
	if (!text) {
		throw new Error(`${taskLabel} completed without assistant text${stopReason ? ` (stopReason: ${stopReason})` : ""}`);
	}
	return text;
}
