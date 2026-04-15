/**
 * 从任何用户 / 远端可控的字符串中剥离 prompt 注入向量：
 *   - boundary tag：Cloudflare 那套分段 prompt 标签，防止用户在 MR title /
 *     分支名里塞 `</mr_body><mr_details>...` 越界
 *   - 多行折叠为单行，避免被误认为 Markdown 标题
 *
 * 用途：MR 标题、分支名、目标标题、项目级审查规范、`--extra` 内容、
 *       REVIEW_GUIDELINES.md 内容。
 */
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
	"review_target",
	"review_extra",
];

const PROMPT_BOUNDARY_TAG_PATTERN = new RegExp(
	`</?(?:${PROMPT_BOUNDARY_TAGS.join("|")})[^>]*>`,
	"gi",
);

export function sanitizePromptInput(text: string): string {
	return text.replace(PROMPT_BOUNDARY_TAG_PATTERN, "").replace(/\s+/g, " ").trim();
}

/**
 * 多行变体：保留换行（用于 REVIEW_GUIDELINES.md 这种合法多段内容），
 * 但仍剥离 boundary tag。
 */
export function sanitizePromptBlock(text: string): string {
	return text.replace(PROMPT_BOUNDARY_TAG_PATTERN, "").trim();
}

/**
 * 严格清洗 ref 名称（分支 / bookmark / commit SHA / revset 片段）。
 *
 * 场景：该值会拼进 prompt 中给 LLM 复制进 shell 命令（如
 * `jj diff --from '${revset}'`）。如果名称含单引号 / 反引号 / 其它 shell
 * 元字符，会打破引号块，甚至在某些情形下造成命令注入。
 *
 * 这里采用白名单：只保留 git / jj ref 名称的常见安全字符
 * (`A-Za-z0-9_./-` 以及 `@` 与表示冲突分隔的 `+`)；遇到其它字符一律丢弃。
 * 返回清洗后的安全字符串；如果原输入全部被丢弃，返回空字符串。
 */
export function sanitizeRefName(name: string): string {
	return name.replace(/[^A-Za-z0-9_./@+\-]/g, "").trim();
}
