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
			return "trivial — 小改动。先偏向通过，只有在问题具体且影响明确时才提。";
		case "lite":
			return "lite — 中等改动。先做代码质量主审，再按命中文件类型补充专项检查。";
		case "full":
			return "full — 高风险或高范围改动。按专项视角逐项检查，再汇总真正重要的问题。";
	}
}

const PASS_ORDER: ReviewFocus[] = ["code-quality", "security", "performance", "release", "docs", "agents"];

function describeFocus(focus: ReviewFocus): string {
	switch (focus) {
		case "code-quality":
			return `### Code Quality\nWhat to flag:\n- 真实的正确性问题、状态流转错误、静默失败、错误边界错误\n- 本次 diff 引入的可维护性/可观测性退化\nWhat NOT to flag:\n- 纯风格偏好\n- 作者显然有意的局部取舍\n- 未改动代码中的既有问题`;
		case "security":
			return `### Security\nWhat to flag:\n- 可利用或具体危险的输入校验、认证、授权、密钥、注入问题\n- 对不受信任输入的边界处理缺失\nWhat NOT to flag:\n- 需要一串牵强前提才成立的理论风险\n- 只是“最好再加一层防御”的泛泛建议\n- 与本次改动无关的旧问题`;
		case "performance":
			return `### Performance\nWhat to flag:\n- 明确的 N+1、热路径额外 IO、无界队列/缓存、背压缺失\n- 会让关键路径明显变慢或放大资源消耗的改动\nWhat NOT to flag:\n- 无法落到具体代码路径的“可能变慢”猜测\n- 纯微优化建议`;
		case "release":
			return `### Release / Dependency\nWhat to flag:\n- 依赖变更带来的兼容性、部署、迁移、权限影响\n- 破坏性操作或需要人工留意的发布风险\nWhat NOT to flag:\n- 仅有 lockfile 噪音本身\n- 与发布无关的普通实现细节`;
		case "docs":
			return `### Docs / UX Surface\nWhat to flag:\n- 本次改动改变行为但文档、注释、用户提示没有同步\n- 错误信息或交互文案会误导用户\nWhat NOT to flag:\n- 纯措辞偏好\n- 不影响理解的轻微文案问题`;
		case "agents":
			return `### AGENTS / Review Instructions\nWhat to flag:\n- 会显著改变 AI 工作流、命令、目录约定，但 AGENTS.md / REVIEW_GUIDELINES.md 未同步\nWhat NOT to flag:\n- 普通业务改动\n- 不会影响 agent 工作方式的小修小补`;
	}
}

function describePass(focus: ReviewFocus): ReviewPass {
	switch (focus) {
		case "code-quality":
			return { id: focus, title: "Pass 1 · Code Quality", instruction: "先检查真实正确性问题、静默失败、状态流转和维护性退化。" };
		case "security":
			return { id: focus, title: "Pass · Security", instruction: "聚焦可利用或具体危险的输入边界、认证、授权、密钥、注入问题。" };
		case "performance":
			return { id: focus, title: "Pass · Performance", instruction: "聚焦热路径、背压、无界资源增长、额外 IO 和明确性能回退。" };
		case "release":
			return { id: focus, title: "Pass · Release", instruction: "检查依赖、迁移、部署、兼容性和破坏性发布风险。" };
		case "docs":
			return { id: focus, title: "Pass · Docs", instruction: "检查行为变化是否同步到文档、注释和用户提示。" };
		case "agents":
			return { id: focus, title: "Pass · AGENTS", instruction: "检查 AI 工作流/命令/目录约定变化是否同步到 AGENTS.md 或 REVIEW_GUIDELINES.md。" };
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
			title: "Final Pass · Coordinator",
			instruction: "最后统一去重、校准严重性、应用 approval bias，并给出最终 verdict。",
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
	const includedPaths = input.plan.includedEntries.map((entry) => `- ${entry.path}`).join("\n") || "- （未能预先分析文件列表）";
	const excludedPaths = input.plan.excludedEntries.map((entry) => `- ${entry.path}`).join("\n") || "- （无）";
	const focusBlocks = input.plan.focuses.map((focus) => describeFocus(focus)).join("\n\n");
	const passPlan = buildMultiPassReviewPlan(input.plan)
		.map((pass, index) => `${index + 1}. ${pass.title} — ${pass.instruction}`)
		.join("\n");

	const agentsMateriality = input.plan.agentsMateriality ?? "null";

	return `## 审查策略\n\n目标：${sanitizePromptInput(input.targetLabel)}\nVCS：${input.vcs}\n风险层级：${describeTier(input.plan)}\n涉及文件：${input.plan.includedEntries.length} 个，估算变更行数 ${input.plan.totalLines}\nAGENTS 物料性：${agentsMateriality}\n\n### 范围边界\n- 只审查本次改动（changed code / diff）里真正会影响正确性、安全性、性能、发布风险或维护成本的问题。\n- 对小改动保持 bias toward approval：若只有轻微建议，倾向给出 approved_with_comments 风格结论，而不是阻塞。\n- 先忽略锁文件、压缩产物、source map、明显生成文件；但数据库迁移、schema 变更、权限变更仍要检查。\n\n### 将重点查看的文件\n${includedPaths}\n\n### 预先排除的噪音文件\n${excludedPaths}\n\n### 多阶段审查流程\n${passPlan}\n\n### 专项检查清单\n${focusBlocks}\n\n## Finding / thread ID 约定\n- 每个 finding 用稳定 ID：\`[P1][F-auth-expiry] path/to/file: headline\`。\n- 如果环境支持 comment thread / 评论线程，可额外带上 thread ID：\`[P1][F-auth-expiry][thread:T-auth-expiry] path/to/file: headline\`。\n- 后续复审或用户反馈优先引用 finding id、稳定 ID、或 \`thread:T-auth-expiry\` 这类 thread ID，而不是重复整段 finding 文本。\n- 如果作者说 \`acknowledged F-auth-expiry\`、\`won't fix F-auth-expiry\`、\`I disagree F-auth-expiry\` 或 \`I disagree thread:T-auth-expiry\`，要把它当成该 finding / reply-to-finding comment thread 的精确反馈。\n\n## 协调与去重\n- 如果多个专项命中同一问题，只保留一次，放在最合适的类别下。\n- 如果不确定严重性，先回到代码核实，不要靠猜。\n- coordinator final pass 负责汇总、去重和最终判断。\n- 先给高信号问题，再给非阻塞提示。\n\n## 决策 rubric\n- 只有 suggestion 级别建议：approved_with_comments\n- 有 warning 但无生产风险：approved_with_comments\n- 多个 warning 形成风险模式：minor_issues\n- 任一 critical 或明确生产安全风险：significant_concerns\n\n## 人工判断偏向\n- 如果只有 suggestion 级别建议，不要夸大成阻塞问题。\n- 如果改动很小且干净，可以明确写“看起来没有阻塞性问题”。\n\n## 项目附加规范\n${customGuidelines ?? "- （无）"}`;
}
