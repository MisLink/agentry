import path from "node:path";

export type ReviewContextFileState = "available" | "deleted" | "binary" | "unreadable";

export type ReviewContext = {
	diffSnapshot: string;
	files: Record<string, string>;
	fileDiffs: Record<string, string>;
	fileMetadata: Record<string, { state: ReviewContextFileState; lineCount?: number; reason?: string }>;
	fileHunks: Record<string, Array<{ id: string; header: string; startLine: number; endLine: number; excerpt: string }>>;
};

export type ReviewContextFile = {
	path: string;
	content: string;
};

export type ReviewContextFileDiff = {
	path: string;
	diff: string;
};

export type ReviewContextFileMetadata = {
	path: string;
	state: ReviewContextFileState;
	lineCount?: number;
	reason?: string;
};

export type ReviewContextFileHunk = {
	path: string;
	id: string;
	header: string;
	startLine: number;
	endLine: number;
	excerpt: string;
};

export type ReviewContextToolParams = {
	kind: "diff" | "file" | "list-files" | "file-diff" | "file-meta" | "file-excerpt" | "search" | "list-hunks" | "hunk-excerpt";
	path?: string;
	startLine?: number;
	endLine?: number;
	query?: string;
	maxResults?: number;
	hunkId?: string;
};

export type ReviewContextToolOptions = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
};

type ReviewContextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError: boolean;
};

function normalizeContextPath(rawPath: string): string | null {
	const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/").trim());
	if (!normalized || normalized === ".") return null;
	if (normalized.startsWith("../") || normalized === "..") return null;
	if (path.posix.isAbsolute(normalized)) return null;
	return normalized;
}

function parseDiffHunks(path: string, diff: string): ReviewContextFileHunk[] {
	const lines = diff.split(/\r?\n/);
	const hunks: ReviewContextFileHunk[] = [];
	let currentHeader: string | null = null;
	let currentStart = 1;
	let currentLength = 1;
	let currentLines: string[] = [];
	let hunkIndex = 0;

	const flush = (): void => {
		if (!currentHeader) return;
		hunkIndex += 1;
		hunks.push({
			path,
			id: `H${hunkIndex}`,
			header: currentHeader,
			startLine: currentStart,
			endLine: currentStart + Math.max(currentLength, 1) - 1,
			excerpt: currentLines.join("\n").trim(),
		});
		currentHeader = null;
		currentLines = [];
	};

	for (const line of lines) {
		const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (match) {
			flush();
			currentHeader = line;
			currentStart = Number(match[1] ?? "1");
			currentLength = Number(match[2] ?? "1");
			continue;
		}
		if (currentHeader) currentLines.push(line);
	}
	flush();
	return hunks;
}

export function buildReviewContext(input: {
	diffSnapshot: string;
	files: ReviewContextFile[];
	fileDiffs?: ReviewContextFileDiff[];
	fileMetadata?: ReviewContextFileMetadata[];
	fileHunks?: ReviewContextFileHunk[];
}): ReviewContext {
	const files: Record<string, string> = {};
	for (const file of input.files) {
		const normalizedPath = normalizeContextPath(file.path);
		if (!normalizedPath) continue;
		if (!(normalizedPath in files)) {
			files[normalizedPath] = file.content;
		}
	}
	const fileDiffs: Record<string, string> = {};
	for (const fileDiff of input.fileDiffs ?? []) {
		const normalizedPath = normalizeContextPath(fileDiff.path);
		if (!normalizedPath) continue;
		if (!(normalizedPath in fileDiffs)) {
			fileDiffs[normalizedPath] = fileDiff.diff;
		}
	}
	const fileMetadata: Record<string, { state: ReviewContextFileState; lineCount?: number; reason?: string }> = {};
	for (const item of input.fileMetadata ?? []) {
		const normalizedPath = normalizeContextPath(item.path);
		if (!normalizedPath) continue;
		if (!(normalizedPath in fileMetadata)) {
			fileMetadata[normalizedPath] = {
				state: item.state,
				...(item.lineCount != null ? { lineCount: item.lineCount } : {}),
				...(item.reason ? { reason: item.reason } : {}),
			};
		}
	}
	for (const normalizedPath of Object.keys(files)) {
		if (!(normalizedPath in fileMetadata)) {
			const lineCount = files[normalizedPath]?.split(/\r?\n/).length ?? 0;
			fileMetadata[normalizedPath] = { state: "available", lineCount };
		}
	}
	const fileHunks: Record<string, Array<{ id: string; header: string; startLine: number; endLine: number; excerpt: string }>> = {};
	for (const item of input.fileHunks ?? []) {
		const normalizedPath = normalizeContextPath(item.path);
		if (!normalizedPath) continue;
		const hunks = fileHunks[normalizedPath] ?? [];
		hunks.push({
			id: item.id,
			header: item.header,
			startLine: item.startLine,
			endLine: item.endLine,
			excerpt: item.excerpt,
		});
		fileHunks[normalizedPath] = hunks;
	}
	for (const [normalizedPath, diff] of Object.entries(fileDiffs)) {
		if (fileHunks[normalizedPath]?.length) continue;
		const parsed = parseDiffHunks(normalizedPath, diff);
		if (parsed.length > 0) fileHunks[normalizedPath] = parsed;
	}
	return {
		diffSnapshot: input.diffSnapshot,
		files,
		fileDiffs,
		fileMetadata,
		fileHunks,
	};
}

export function createReviewContextTool(getContext: () => ReviewContext | undefined, options: ReviewContextToolOptions) {
	return {
		name: options.name,
		label: options.label,
		description: options.description,
		promptSnippet: options.promptSnippet ?? "Inspect shared review diff snapshot, changed files, file diffs, hunks, metadata, and targeted excerpts without write access.",
		promptGuidelines: options.promptGuidelines ?? [
			"Use this read-only review context tool to inspect shared diff context on demand instead of asking for the whole diff in the prompt.",
		],
		execute: async (_toolCallId: string, params: ReviewContextToolParams): Promise<ReviewContextToolResult> => {
			const context = getContext();
			if (!context) {
				return {
					content: [{ type: "text" as const, text: "No active review context is available." }],
					details: { kind: params.kind },
					isError: true,
				};
			}
			if (params.kind === "diff") {
				return {
					content: [{ type: "text" as const, text: context.diffSnapshot }],
					details: { kind: "diff" },
					isError: false,
				};
			}
			if (params.kind === "list-files") {
				const lines = Object.entries(context.fileMetadata)
					.map(([filePath, metadata]) => `${filePath} [${metadata.state}]${metadata.lineCount != null ? ` lines=${metadata.lineCount}` : ""}${metadata.reason ? ` reason=${metadata.reason}` : ""}`)
					.join("\n");
				return {
					content: [{ type: "text" as const, text: lines }],
					details: { kind: "list-files", count: Object.keys(context.fileMetadata).length },
					isError: false,
				};
			}
			if (params.kind === "search") {
				const query = params.query?.trim().toLowerCase();
				if (!query) {
					return {
						content: [{ type: "text" as const, text: "Search query is invalid in review context." }],
						details: { kind: "search", query: params.query ?? null },
						isError: true,
					};
				}
				const maxResults = Number.isInteger(params.maxResults) && (params.maxResults ?? 0) > 0 ? params.maxResults as number : 5;
				const matches: string[] = [];
				for (const [filePath, content] of Object.entries(context.files)) {
					const metadata = context.fileMetadata[filePath];
					if (metadata?.state !== "available") continue;
					const lines = content.split(/\r?\n/);
					for (let index = 0; index < lines.length; index++) {
						const line = lines[index];
						if (!line?.toLowerCase().includes(query)) continue;
						matches.push(`${filePath}:${index + 1}: ${line}`);
						if (matches.length >= maxResults) break;
					}
					if (matches.length >= maxResults) break;
				}
				return {
					content: [{ type: "text" as const, text: matches.length > 0 ? matches.join("\n") : "No matches found in review context." }],
					details: { kind: "search", query, count: matches.length, maxResults },
					isError: false,
				};
			}
			const normalizedPath = params.path ? normalizeContextPath(params.path) : null;
			if (!normalizedPath) {
				return {
					content: [{ type: "text" as const, text: "Requested file is not available in review context." }],
					details: { kind: params.kind, path: params.path ?? null },
					isError: true,
				};
			}
			if (params.kind === "list-hunks") {
				const hunks = context.fileHunks[normalizedPath];
				if (!hunks || hunks.length === 0) {
					return {
						content: [{ type: "text" as const, text: `Requested file is not available in review context: ${normalizedPath}` }],
						details: { kind: "list-hunks", path: normalizedPath },
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: hunks.map((hunk) => `${hunk.id} ${hunk.header} lines=${hunk.startLine}-${hunk.endLine}`).join("\n") }],
					details: { kind: "list-hunks", path: normalizedPath, count: hunks.length },
					isError: false,
				};
			}
			if (params.kind === "hunk-excerpt") {
				const hunks = context.fileHunks[normalizedPath];
				const hunk = hunks?.find((item) => item.id === params.hunkId);
				if (!hunk) {
					return {
						content: [{ type: "text" as const, text: `Requested hunk is not available in review context: ${normalizedPath}` }],
						details: { kind: "hunk-excerpt", path: normalizedPath, hunkId: params.hunkId ?? null },
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `${hunk.header}\n${hunk.excerpt}` }],
					details: { kind: "hunk-excerpt", path: normalizedPath, hunkId: hunk.id, startLine: hunk.startLine, endLine: hunk.endLine },
					isError: false,
				};
			}
			if (params.kind === "file-meta") {
				const metadata = context.fileMetadata[normalizedPath];
				if (!metadata) {
					return {
						content: [{ type: "text" as const, text: `Requested file is not available in review context: ${normalizedPath}` }],
						details: { kind: "file-meta", path: normalizedPath },
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `${normalizedPath} [${metadata.state}]${metadata.lineCount != null ? ` lines=${metadata.lineCount}` : ""}${metadata.reason ? ` reason=${metadata.reason}` : ""}` }],
					details: { kind: "file-meta", path: normalizedPath, ...metadata },
					isError: false,
				};
			}
			if (params.kind === "file-diff") {
				const diff = context.fileDiffs[normalizedPath];
				if (diff == null) {
					return {
						content: [{ type: "text" as const, text: `Requested file is not available in review context: ${normalizedPath}` }],
						details: { kind: "file-diff", path: normalizedPath },
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: diff }],
					details: { kind: "file-diff", path: normalizedPath },
					isError: false,
				};
			}
			const metadata = context.fileMetadata[normalizedPath];
			const content = context.files[normalizedPath];
			if (params.kind === "file-excerpt") {
				if (content == null || metadata?.state !== "available") {
					return {
						content: [{ type: "text" as const, text: `Requested file is not available in review context: ${normalizedPath}` }],
						details: { kind: "file-excerpt", path: normalizedPath },
						isError: true,
					};
				}
				if (!Number.isInteger(params.startLine) || !Number.isInteger(params.endLine) || (params.startLine ?? 0) < 1 || (params.endLine ?? 0) < (params.startLine ?? 0)) {
					return {
						content: [{ type: "text" as const, text: "Requested line range is invalid in review context." }],
						details: { kind: "file-excerpt", path: normalizedPath, startLine: params.startLine ?? null, endLine: params.endLine ?? null },
						isError: true,
					};
				}
				const lines = content.split(/\r?\n/);
				const excerpt = lines
					.slice((params.startLine ?? 1) - 1, params.endLine)
					.map((line, index) => `${(params.startLine ?? 1) + index}: ${line}`)
					.join("\n");
				return {
					content: [{ type: "text" as const, text: excerpt }],
					details: { kind: "file-excerpt", path: normalizedPath, startLine: params.startLine, endLine: params.endLine },
					isError: false,
				};
			}
			if (content == null || metadata?.state !== "available") {
				return {
					content: [{ type: "text" as const, text: `Requested file is not available in review context: ${normalizedPath}` }],
					details: { kind: "file", path: normalizedPath },
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: content }],
				details: { kind: "file", path: normalizedPath },
				isError: false,
			};
		},
	};
}
