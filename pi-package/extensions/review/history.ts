import type { ReviewVcs } from "./strategy.ts";
import type { ReviewTargetSpec } from "./diff.ts";

export type ReviewFindingStatus = "open" | "resolved" | "acknowledged" | "disputed";

export type ReviewFinding = {
	id?: string;
	threadId?: string;
	key: string;
	priority: string;
	headline: string;
	location?: string;
	status: ReviewFindingStatus;
	firstSeenAtMs?: number;
	lastSeenAtMs?: number;
	resolvedAtMs?: number;
	acknowledgedAtMs?: number;
	disputedAtMs?: number;
};

export type FindingFeedbackDisposition = "acknowledged" | "disputed";

export type FindingFeedback = {
	key?: string;
	id?: string;
	threadId?: string;
	disposition: FindingFeedbackDisposition;
};

export type ReviewMemory = {
	targetKey: string;
	summary: string;
	createdAtMs: number;
	findings?: ReviewFinding[];
};

export type MergeReviewMemoryInput = {
	targetKey: string;
	summary: string;
	createdAtMs: number;
	reviewText: string;
};

const MAX_SUMMARY_CHARS = 500;
const MAX_RESOLVED_FINDINGS = 5;
const FINDING_LINE_PATTERN = /^(?:[-*]\s*)?\[(P[0-3])\]((?:\[[^\]]+\])*)\s+([^:\n]+):\s+(.+)$/i;
const FEEDBACK_STRUCTURED_PATTERN = /^(acknowledged|won't fix|i disagree)\s+((?:\[[^\]]+\])*)\s*([^:\n]+):\s+(.+)$/i;
const FEEDBACK_REFERENCE_PATTERN = /^(acknowledged|won't fix|i disagree)\s+(.+)$/i;

function normalizeFindingPart(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildFindingKey(location: string | undefined, headline: string): string {
	const normalizedHeadline = normalizeFindingPart(headline);
	if (!location) return normalizedHeadline;
	return `${location.trim()}::${normalizedHeadline}`;
}

function parseBracketTags(text: string): { id?: string; threadId?: string } {
	const tags = [...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]?.trim()).filter(Boolean);
	let id: string | undefined;
	let threadId: string | undefined;
	for (const tag of tags) {
		if (/^thread:/i.test(tag)) {
			threadId = tag.replace(/^thread:/i, "").trim() || threadId;
			continue;
		}
		if (/^finding:/i.test(tag)) {
			id = tag.replace(/^finding:/i, "").trim() || id;
			continue;
		}
		if (/^F[-A-Za-z0-9_]+$/i.test(tag)) {
			id = tag;
		}
	}
	return {
		...(id ? { id } : {}),
		...(threadId ? { threadId } : {}),
	};
}

function parseExplicitFeedbackReference(text: string): { id?: string; threadId?: string } | null {
	const normalized = text.trim();
	const threadMatch = normalized.match(/^thread:\s*([A-Za-z0-9_-]+)$/i);
	if (threadMatch?.[1]) return { threadId: threadMatch[1] };
	const findingMatch = normalized.match(/^(?:finding:\s*)?(F[-A-Za-z0-9_]+)$/i);
	if (findingMatch?.[1]) return { id: findingMatch[1] };
	return null;
}

function tokenizeForMatch(text: string): string[] {
	return normalizeFindingPart(text)
		.split(/[^a-z0-9]+/i)
		.filter((token) => token.length >= 4);
}

function detectFeedbackDisposition(text: string): FindingFeedbackDisposition | null {
	if (/\bi disagree\b/i.test(text) || /\bdisagree\b/i.test(text)) return "disputed";
	if (/\backnowledged\b/i.test(text) || /won't fix/i.test(text)) return "acknowledged";
	return null;
}

function findBestFeedbackMatch(line: string, findings: ReviewFinding[]): FindingFeedback | null {
	const disposition = detectFeedbackDisposition(line);
	if (!disposition) return null;
	const lineTokens = new Set(tokenizeForMatch(line));
	let bestFinding: ReviewFinding | null = null;
	let bestScore = 0;
	for (const finding of findings) {
		const candidateTokens = new Set([
			...tokenizeForMatch(finding.location ?? ""),
			...tokenizeForMatch(finding.headline),
		]);
		let score = 0;
		for (const token of candidateTokens) {
			if (lineTokens.has(token)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestFinding = finding;
		}
	}
	if (!bestFinding || bestScore === 0) return null;
	return { key: bestFinding.key, id: bestFinding.id, threadId: bestFinding.threadId, disposition };
}

export function buildReviewTargetKey(vcs: ReviewVcs, target: ReviewTargetSpec): string {
	switch (target.type) {
		case "uncommitted":
			return `${vcs}:uncommitted`;
		case "baseBranch":
			return `${vcs}:baseBranch:${target.branch}`;
		case "commit":
			return `${vcs}:commit:${target.sha}`;
	}
}

export function compactReviewSummary(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
	return normalized.slice(0, MAX_SUMMARY_CHARS);
}

export function findPreviousReviewMemory(memories: ReviewMemory[], targetKey: string): ReviewMemory | null {
	const matches = memories.filter((memory) => memory.targetKey === targetKey);
	if (matches.length === 0) return null;
	return matches.reduce((latest, memory) => (memory.createdAtMs > latest.createdAtMs ? memory : latest));
}

export function extractReviewFindings(reviewText: string): ReviewFinding[] {
	return reviewText
		.split("\n")
		.map((line) => line.trim())
		.map((line) => line.match(FINDING_LINE_PATTERN))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => {
			const [, priority, rawTags, rawLocation, rawHeadline] = match;
			const location = rawLocation?.trim();
			const headline = rawHeadline?.trim() ?? "";
			const { id, threadId } = parseBracketTags(rawTags ?? "");
			return {
				...(id ? { id } : {}),
				...(threadId ? { threadId } : {}),
				key: buildFindingKey(location, headline),
				priority: priority.toUpperCase(),
				location,
				headline,
				status: "open" as const,
			};
		});
}

export function extractFindingFeedback(text: string): FindingFeedback[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line)
		.map((line) => {
			const structuredMatch = line.match(FEEDBACK_STRUCTURED_PATTERN);
			if (structuredMatch) {
				const [, rawDisposition, rawTags, rawLocation, rawHeadline] = structuredMatch;
				const { id, threadId } = parseBracketTags(rawTags ?? "");
				return {
					key: buildFindingKey(rawLocation.trim(), rawHeadline.trim()),
					...(id ? { id } : {}),
					...(threadId ? { threadId } : {}),
					disposition: /disagree/i.test(rawDisposition) ? "disputed" as const : "acknowledged" as const,
				};
			}
			const referenceMatch = line.match(FEEDBACK_REFERENCE_PATTERN);
			if (!referenceMatch) return null;
			const [, rawDisposition, rawReference] = referenceMatch;
			const parsedReference = parseExplicitFeedbackReference(rawReference);
			if (!parsedReference) return null;
			return {
				...parsedReference,
				disposition: /disagree/i.test(rawDisposition) ? "disputed" as const : "acknowledged" as const,
			};
		})
		.filter((item): item is FindingFeedback => Boolean(item));
}

export function pruneReviewMemory(memory: ReviewMemory, maxResolvedFindings = MAX_RESOLVED_FINDINGS): ReviewMemory {
	const findings = memory.findings ?? [];
	const activeFindings = findings
		.filter((finding) => finding.status === "open" || finding.status === "disputed")
		.sort((left, right) => {
			const leftRank = left.status === "disputed" ? 0 : 1;
			const rightRank = right.status === "disputed" ? 0 : 1;
			return leftRank - rightRank;
		});
	const historicalFindings = findings
		.filter((finding) => finding.status === "resolved" || finding.status === "acknowledged")
		.sort((left, right) => {
			const leftTime = left.acknowledgedAtMs ?? left.resolvedAtMs ?? 0;
			const rightTime = right.acknowledgedAtMs ?? right.resolvedAtMs ?? 0;
			return rightTime - leftTime;
		})
		.slice(0, maxResolvedFindings);
	return {
		...memory,
		findings: [...activeFindings, ...historicalFindings],
	};
}

export function applyFindingFeedback(memory: ReviewMemory, feedbackText: string, atMs: number): ReviewMemory {
	const explicitFeedback = extractFindingFeedback(feedbackText);
	const fuzzyFeedback = feedbackText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line)
		.map((line) => findBestFeedbackMatch(line, memory.findings ?? []))
		.filter((item): item is FindingFeedback => Boolean(item));
	const feedback = [...explicitFeedback, ...fuzzyFeedback];
	if (feedback.length === 0) return memory;
	const feedbackById = new Map(feedback.filter((item) => item.id).map((item) => [item.id, item]));
	const feedbackByThreadId = new Map(feedback.filter((item) => item.threadId).map((item) => [item.threadId, item]));
	const feedbackByKey = new Map(feedback.filter((item) => item.key).map((item) => [item.key, item]));
	return pruneReviewMemory({
		...memory,
		findings: (memory.findings ?? []).map((finding) => {
			const item = (finding.id ? feedbackById.get(finding.id) : undefined)
				?? (finding.threadId ? feedbackByThreadId.get(finding.threadId) : undefined)
				?? feedbackByKey.get(finding.key);
			if (!item) return finding;
			if (item.disposition === "disputed") {
				return { ...finding, status: "disputed", disputedAtMs: atMs };
			}
			return { ...finding, status: "acknowledged", acknowledgedAtMs: atMs };
		}),
	});
}

export function mergeReviewMemory(previous: ReviewMemory | null, input: MergeReviewMemoryInput): ReviewMemory {
	const nextFindings = extractReviewFindings(input.reviewText);
	const previousFindings = previous?.findings ?? [];
	const nextByKey = new Map(nextFindings.map((finding) => [finding.key, finding]));
	const mergedFindings: ReviewFinding[] = [];

	for (const finding of previousFindings) {
		const nextFinding = nextByKey.get(finding.key);
		if (nextFinding) {
			mergedFindings.push({
				...nextFinding,
				...(nextFinding.id ?? finding.id ? { id: nextFinding.id ?? finding.id } : {}),
				...(nextFinding.threadId ?? finding.threadId ? { threadId: nextFinding.threadId ?? finding.threadId } : {}),
				status: "open",
				firstSeenAtMs: finding.firstSeenAtMs ?? input.createdAtMs,
				lastSeenAtMs: input.createdAtMs,
			});
			nextByKey.delete(finding.key);
			continue;
		}
		if (finding.status === "open" || finding.status === "disputed") {
			mergedFindings.push({
				...finding,
				status: "resolved",
				resolvedAtMs: input.createdAtMs,
			});
			continue;
		}
		mergedFindings.push(finding);
	}

	for (const finding of nextByKey.values()) {
		mergedFindings.push({
			...finding,
			status: "open",
			firstSeenAtMs: input.createdAtMs,
			lastSeenAtMs: input.createdAtMs,
		});
	}

	return pruneReviewMemory({
		targetKey: input.targetKey,
		summary: input.summary,
		createdAtMs: input.createdAtMs,
		findings: mergedFindings,
	});
}

export function buildRereviewPromptSection(memory: ReviewMemory | null): string {
	if (!memory) return "";
	const activeFindings = (memory.findings ?? []).filter((finding) => finding.status === "open" || finding.status === "disputed");
	const resolvedCount = (memory.findings ?? []).filter((finding) => finding.status === "resolved").length;
	const acknowledgedCount = (memory.findings ?? []).filter((finding) => finding.status === "acknowledged").length;
	const disputedCount = (memory.findings ?? []).filter((finding) => finding.status === "disputed").length;
	const activeLines = activeFindings.length > 0
		? activeFindings.map((finding) => {
			const prefix = finding.status === "disputed" ? "[争议]" : `[${finding.priority}]`;
			const refs = [finding.id, finding.threadId ? `thread:${finding.threadId}` : undefined].filter(Boolean).join(" ");
			const prefixRefs = refs ? `${refs} ` : "";
			return `- ${prefix} ${prefixRefs}${finding.location ?? "(unknown)"}: ${finding.headline}`;
		}).join("\n")
		: "- （无未解决旧问题）";

	return `## 增量复审上下文\n- 上次审查摘要：${memory.summary}\n- 已修复旧问题：${resolvedCount} 个\n- 已确认不修复 / acknowledged：${acknowledgedCount} 个\n- 存在争议的问题：${disputedCount} 个\n- 先重新核实以下未解决或有争议的问题；如果现在已修复，不要重复。\n${activeLines}\n- 仅在问题仍存在、作者明确不同意、或问题变严重时重新提出，并解释变化。`;
}
