import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REFERENCE_PATH = path.resolve(currentDir, "../../../skills/review-workflow/reference.md");

export function buildPortableAlignmentSection(referenceMarkdown: string): string {
	const trimmed = referenceMarkdown.trim();
	if (!trimmed) return "";
	return `## 共享审查语义（portable source）\n\n${trimmed}`;
}

export function loadPortableAlignmentSection(readFile: (filePath: string) => string = (filePath) => readFileSync(filePath, "utf8")): string {
	try {
		return buildPortableAlignmentSection(readFile(DEFAULT_REFERENCE_PATH));
	} catch {
		return "";
	}
}
