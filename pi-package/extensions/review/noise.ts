/**
 * Diff 噪声过滤提示 —— 告诉审查模型哪些文件路径默认忽略，不要为
 * 它们单独给出评审项。这里只产出提示词文案，不实际预过滤 diff 条目。
 */

const NOISE_FILE_NAMES = [
	"bun.lock",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
	"go.sum",
	"poetry.lock",
	"Pipfile.lock",
	"flake.lock",
];

const NOISE_SUFFIXES = [".min.js", ".min.css", ".bundle.js", ".map"];

const GENERATED_HINTS = ["generated/", "/gen/", ".gen.", "openapi", "swagger", "graphql/generated"];
const MIGRATION_EXEMPT_HINTS = ["migration", "migrations", "schema", "ddl"];

export function buildNoiseGuidance(): string {
	return [
		"## 噪声忽略提示",
		"审查 diff 时默认忽略下列文件，不要为它们单独给出评审项：",
		`- 锁文件：${NOISE_FILE_NAMES.join("、")}`,
		`- 编译产物 / source map：后缀包含 ${NOISE_SUFFIXES.join("、")}`,
		`- 自动生成代码：路径含 ${GENERATED_HINTS.join("、")} 等关键词`,
		`例外：路径含 ${MIGRATION_EXEMPT_HINTS.join("、")} 关键词的迁移 / schema 文件即便看似自动生成，也需要审查。`,
	].join("\n");
}
