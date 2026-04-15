export type ReviewTier = "trivial" | "lite" | "full";
export type ReviewFocus = "code-quality" | "security" | "performance" | "release" | "docs" | "agents";
export type ReviewVcs = "git" | "jj";

export type ReviewEntry = {
	path: string;
	added: number;
	removed: number;
	generated?: boolean;
};

export type AgentsMateriality = "low" | "medium" | "high" | null;
export type ReviewPassId = ReviewFocus | "coordinator";

export type ReviewPlan = {
	tier: ReviewTier;
	focuses: ReviewFocus[];
	includedEntries: ReviewEntry[];
	excludedEntries: ReviewEntry[];
	totalLines: number;
	hasSecuritySensitiveFiles: boolean;
	agentsMateriality: AgentsMateriality;
};

export type ReviewStrategyPromptInput = {
	plan: ReviewPlan;
	targetLabel: string;
	vcs: ReviewVcs;
	customGuidelines?: string | null;
};

export type ReviewPass = {
	id: ReviewPassId;
	title: string;
	instruction: string;
};

const PROMPT_BOUNDARY_TAGS = [
	"mr_input",
	"mr_body",
	"mr_comments",
	"mr_details",
	"changed_files",
	"existing_inline_findings",
	"previous_review",
	"custom_review_instructions",
	"agents_md_template_instructions",
];

const PROMPT_BOUNDARY_TAG_PATTERN = new RegExp(
	`</?(?:${PROMPT_BOUNDARY_TAGS.join("|")})[^>]*>`,
	"gi",
);

const NOISE_FILE_PATTERNS = new Set([
	"bun.lock",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
	"go.sum",
	"poetry.lock",
	"Pipfile.lock",
	"flake.lock",
]);

const NOISE_SUFFIXES = [".min.js", ".min.css", ".bundle.js", ".map"];
const MIGRATION_HINTS = ["migration", "migrations", "schema", "ddl"];
const SECURITY_HINTS = ["auth", "oauth", "token", "session", "crypto", "secret", "permission", "acl", "rbac", "policy"];
const PERFORMANCE_HINTS = ["cache", "queue", "worker", "stream", "batch", "perf", "hot-path", "hotpath"];
const DOCS_HINTS = ["docs/", ".md", ".mdx"];
const RELEASE_HINTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Dockerfile", ".github/workflows/", ".gitlab-ci", "release", "changeset"];
const AGENT_HINTS = ["AGENTS.md", "REVIEW_GUIDELINES.md", ".agents/", ".pi/"];
const AGENT_HIGH_HINTS = [
	"AGENTS.md",
	"REVIEW_GUIDELINES.md",
	"package.json",
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"tsconfig",
	"vitest.config",
	"jest.config",
	"vite.config",
	"next.config",
	".github/workflows/",
	".gitlab-ci",
];
const AGENT_MEDIUM_HINTS = ["openapi", "swagger", "graphql", "eslint", "prettier", "turbo", "changeset"];
const GENERATED_HINTS = ["generated", "gen/", "gen.", "openapi", "swagger", "graphql/generated"];

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function isMigrationPath(filePath: string): boolean {
	const normalized = normalizePath(filePath).toLowerCase();
	return MIGRATION_HINTS.some((hint) => normalized.includes(hint));
}

function isNoisePath(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	const base = normalized.split("/").at(-1) ?? normalized;
	if (NOISE_FILE_PATTERNS.has(base)) return true;
	return NOISE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isGeneratedEntry(entry: ReviewEntry): boolean {
	if (entry.generated) return true;
	const normalized = normalizePath(entry.path).toLowerCase();
	return GENERATED_HINTS.some((hint) => normalized.includes(hint));
}

function hasHint(filePath: string, hints: string[]): boolean {
	const normalized = normalizePath(filePath).toLowerCase();
	return hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

function pushFocus(focuses: ReviewFocus[], focus: ReviewFocus): void {
	if (!focuses.includes(focus)) focuses.push(focus);
}

function assessAgentsMateriality(entries: ReviewEntry[]): AgentsMateriality {
	if (entries.some((entry) => hasHint(entry.path, AGENT_HIGH_HINTS))) return "high";
	if (entries.some((entry) => hasHint(entry.path, AGENT_MEDIUM_HINTS))) return "medium";
	if (entries.some((entry) => hasHint(entry.path, AGENT_HINTS))) return "low";
	return null;
}

function describeTier(plan: ReviewPlan): string {
	switch (plan.tier) {
		case "trivial":
			return "trivial - small change. Bias toward approval and flag only concrete issues with clear impact.";
		case "lite":
			return "lite - medium change. Start with code-quality review, then add focused checks based on touched file types.";
		case "full":
			return "full - high-risk or broad change. Review by specialist perspective, then merge only material findings.";
	}
}

const PASS_ORDER: ReviewFocus[] = ["code-quality", "security", "performance", "release", "docs", "agents"];

function describeFocus(focus: ReviewFocus): string {
	switch (focus) {
		case "code-quality":
			return `### Code Quality\nWhat to flag:\n- Real correctness bugs, broken state transitions, silent failures, and wrong error boundaries\n- Maintainability or observability regressions introduced by this diff\nWhat NOT to flag:\n- Pure style preferences\n- Clearly intentional local tradeoffs\n- Pre-existing issues in unchanged code`;
		case "security":
			return `### Security\nWhat to flag:\n- Exploitable or concretely dangerous input validation, authentication, authorization, secret, or injection issues\n- Missing boundary handling for untrusted input\nWhat NOT to flag:\n- Theoretical risks that require a chain of weak assumptions\n- Generic defense-in-depth suggestions without concrete impact\n- Old issues unrelated to this change`;
		case "performance":
			return `### Performance\nWhat to flag:\n- Clear N+1 behavior, extra hot-path IO, unbounded queues/caches, and missing backpressure\n- Changes that materially slow critical paths or amplify resource usage\nWhat NOT to flag:\n- Vague "might be slower" guesses without a concrete code path\n- Pure micro-optimization ideas`;
		case "release":
			return `### Release / Dependency\nWhat to flag:\n- Compatibility, deployment, migration, or permission impact from dependency changes\n- Destructive operations or release risks that need human attention\nWhat NOT to flag:\n- Lockfile noise by itself\n- Ordinary implementation details unrelated to release risk`;
		case "docs":
			return `### Docs / UX Surface\nWhat to flag:\n- Behavior changes without matching updates to docs, comments, or user prompts\n- Error messages or interaction text that mislead users\nWhat NOT to flag:\n- Pure wording preferences\n- Minor copy issues that do not affect understanding`;
		case "agents":
			return `### AGENTS / Review Instructions\nWhat to flag:\n- Significant AI workflow, command, or directory convention changes not reflected in AGENTS.md or REVIEW_GUIDELINES.md\nWhat NOT to flag:\n- Ordinary product changes\n- Small edits that do not affect how agents work`;
	}
}

function describePass(focus: ReviewFocus): ReviewPass {
	switch (focus) {
		case "code-quality":
			return { id: focus, title: "Pass 1 - Code Quality", instruction: "First check real correctness issues, silent failures, state transitions, and maintainability regressions." };
		case "security":
			return { id: focus, title: "Pass - Security", instruction: "Focus on exploitable or concretely dangerous input-boundary, authentication, authorization, secret, and injection issues." };
		case "performance":
			return { id: focus, title: "Pass - Performance", instruction: "Focus on hot paths, backpressure, unbounded resource growth, extra IO, and clear performance regressions." };
		case "release":
			return { id: focus, title: "Pass - Release", instruction: "Check dependency, migration, deployment, compatibility, and destructive-release risks." };
		case "docs":
			return { id: focus, title: "Pass - Docs", instruction: "Check whether behavior changes are reflected in docs, comments, and user-facing prompts." };
		case "agents":
			return { id: focus, title: "Pass - AGENTS", instruction: "Check whether AI workflow, command, or directory-convention changes are reflected in AGENTS.md or REVIEW_GUIDELINES.md." };
		}
}

export function sanitizePromptInput(text: string): string {
	return text.replace(PROMPT_BOUNDARY_TAG_PATTERN, "").replace(/\s+/g, " ").trim();
}

export function buildMultiPassReviewPlan(plan: ReviewPlan): ReviewPass[] {
	const activeFocuses = plan.tier === "trivial"
		? ["code-quality"] satisfies ReviewFocus[]
		: PASS_ORDER.filter((focus) => plan.focuses.includes(focus));

	return [
		...activeFocuses.map((focus) => describePass(focus)),
		{
			id: "coordinator",
			title: "Final Pass - Coordinator",
			instruction: "Finally dedupe findings, calibrate severity, apply approval bias, and give the final verdict.",
		},
	];
}

export function assessReviewPlan(entries: ReviewEntry[]): ReviewPlan {
	const includedEntries: ReviewEntry[] = [];
	const excludedEntries: ReviewEntry[] = [];

	for (const entry of entries) {
		if (isNoisePath(entry.path)) {
			excludedEntries.push(entry);
			continue;
		}
		if (isGeneratedEntry(entry) && !isMigrationPath(entry.path)) {
			excludedEntries.push(entry);
			continue;
		}
		includedEntries.push(entry);
	}

	const totalLines = includedEntries.reduce((sum, entry) => sum + entry.added + entry.removed, 0);
	const hasSecuritySensitiveFiles = includedEntries.some((entry) => hasHint(entry.path, SECURITY_HINTS));
	const agentsMateriality = assessAgentsMateriality(includedEntries);

	const focuses: ReviewFocus[] = ["code-quality"];
	if (includedEntries.some((entry) => hasHint(entry.path, SECURITY_HINTS))) pushFocus(focuses, "security");
	if (includedEntries.some((entry) => hasHint(entry.path, PERFORMANCE_HINTS))) pushFocus(focuses, "performance");
	if (includedEntries.some((entry) => hasHint(entry.path, RELEASE_HINTS))) pushFocus(focuses, "release");
	if (includedEntries.some((entry) => hasHint(entry.path, DOCS_HINTS))) pushFocus(focuses, "docs");
	if (includedEntries.some((entry) => hasHint(entry.path, AGENT_HINTS))) pushFocus(focuses, "agents");

	let tier: ReviewTier;
	if (hasSecuritySensitiveFiles || includedEntries.length > 20 || totalLines > 100) {
		tier = "full";
	} else if (totalLines <= 10 && includedEntries.length <= 20) {
		tier = "trivial";
	} else {
		tier = "lite";
	}

	return {
		tier,
		focuses,
		includedEntries,
		excludedEntries,
		totalLines,
		hasSecuritySensitiveFiles,
		agentsMateriality,
	};
}

export function buildReviewStrategyPrompt(input: ReviewStrategyPromptInput): string {
	const customGuidelines = input.customGuidelines ? sanitizePromptInput(input.customGuidelines) : null;
	const includedPaths = input.plan.includedEntries.map((entry) => `- ${entry.path}`).join("\n") || "- No changed-file list was available before review.";
	const excludedPaths = input.plan.excludedEntries.map((entry) => `- ${entry.path}`).join("\n") || "- None";
	const focusBlocks = input.plan.focuses.map((focus) => describeFocus(focus)).join("\n\n");
	const passPlan = buildMultiPassReviewPlan(input.plan)
		.map((pass, index) => `${index + 1}. ${pass.title} — ${pass.instruction}`)
		.join("\n");

	const agentsMateriality = input.plan.agentsMateriality ?? "null";

	return `## Review Strategy

Target: ${sanitizePromptInput(input.targetLabel)}
VCS: ${input.vcs}
Risk tier: ${describeTier(input.plan)}
Changed files considered: ${input.plan.includedEntries.length}; estimated changed lines: ${input.plan.totalLines}
AGENTS materiality: ${agentsMateriality}

### Scope Boundaries
- Review only issues in the changed code or diff that materially affect correctness, security, performance, release risk, or maintainability.
- Keep approval bias for small changes. If there are only minor suggestions, prefer a non-blocking approval outcome over blocking.
- Ignore lockfile noise, minified outputs, source maps, and obvious generated files first; still inspect migrations, schema changes, auth changes, and permission changes.

### Files To Inspect
${includedPaths}

### Noise Excluded Up Front
${excludedPaths}

### Review Pass Plan
${passPlan}

### Focus Checklists
${focusBlocks}

## Finding / Thread ID Convention
- Give each finding a stable ID: \`[P1][F-auth-expiry] path/to/file: headline\`.
- If the environment supports comment threads, optionally include a thread ID: \`[P1][F-auth-expiry][thread:T-auth-expiry] path/to/file: headline\`.
- In re-reviews or user feedback, prefer finding IDs, stable IDs, or \`thread:T-auth-expiry\` references instead of repeating whole finding text.
- Treat feedback such as \`acknowledged F-auth-expiry\`, \`won't fix F-auth-expiry\`, \`I disagree F-auth-expiry\`, or \`I disagree thread:T-auth-expiry\` as precise feedback on that finding or reply-to-finding thread.

## Coordination And Dedupe
- If multiple specialist passes identify the same issue, keep one copy in the best-fitting category.
- If severity is uncertain, re-check the code instead of guessing.
- The coordinator final pass dedupes findings, calibrates severity, and decides the final verdict.
- Lead with high-signal issues, then non-blocking notes.

## Verdict Rubric
- Suggestions only: 通过，有备注.
- Warnings without production risk: 通过，有备注.
- Multiple warnings forming a risk pattern: 小问题.
- Any critical issue or clear production-safety risk: 重大疑虑.

## Approval Bias
- Do not inflate suggestion-level comments into blocking issues.
- For small clean changes, explicitly say there are no blocking issues.

## Project-Specific Guidelines
${customGuidelines ?? "- None"}`;
}
