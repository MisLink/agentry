const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[A-Za-z]/;
const SLASH_COMMAND_RE = /^\/[A-Za-z][\w-]*(?:\s|$)/;

type ReviewOutputLanguage = "chinese" | "english" | "unknown";
export type ReviewLanguageMode = "zh" | "en" | "auto";

export function buildReviewLanguageInstruction(userText: string | undefined, mode: ReviewLanguageMode = "zh"): string {
	if (mode === "zh") return buildInstructionForLanguage("chinese");
	if (mode === "en") return buildInstructionForLanguage("english");
	const text = userText?.trim() ?? "";
	return buildInstructionForLanguage(detectReviewOutputLanguage(text));
}

export function buildReviewLanguageInstructionFromUserTexts(
	userTexts: string[],
	mode: ReviewLanguageMode = "zh",
): string {
	if (mode === "zh") return buildInstructionForLanguage("chinese");
	if (mode === "en") return buildInstructionForLanguage("english");
	for (let i = userTexts.length - 1; i >= 0; i--) {
		const language = detectReviewOutputLanguage(userTexts[i] ?? "");
		if (language !== "unknown") return buildInstructionForLanguage(language);
	}
	return buildInstructionForLanguage("unknown");
}

function detectReviewOutputLanguage(text: string): ReviewOutputLanguage {
	const trimmed = text.trim();
	if (CJK_RE.test(trimmed)) return "chinese";
	if (SLASH_COMMAND_RE.test(trimmed)) return "unknown";
	if (LATIN_RE.test(trimmed)) return "english";
	return "unknown";
}

function buildInstructionForLanguage(language: ReviewOutputLanguage): string {
	if (language === "chinese") {
		return [
			"Output language: Chinese. Match the user's Chinese request and write every user-visible review section in 中文.",
			"Use these exact Chinese section headings:",
			"## 问题",
			"## 结论",
			"## 非阻塞人工审查提示",
			"Use these exact Chinese verdict values instead of the English enum values:",
			"- 通过，有备注",
			"- 小问题",
			"- 重大疑虑",
			"Do not output English section headings or English verdict enum strings.",
		].join("\n");
	}
	if (language === "english") {
		return "Output language: English. Match the user's English request for findings, verdict, and non-blocking human-review notes.";
	}
	return "Output language: use the same language as the user's review request or the current conversation. Do not switch languages just because code, file paths, or commands are English.";
}
