# Agentry — AI Agent Configuration & Extensions

## 项目简介

`agentry` 是一个个人 AI 编码助手的配置与扩展集合，通过 [GNU Stow](https://www.gnu.org/software/stow/) 将各子目录 symlink 到 `$HOME`，统一管理多个 AI 工具（pi、claude）的配置、扩展和 Skills。

## 目录结构

```
agentry/
├── pi-package/         # Pi agent 的自定义扩展（TypeScript）
│   └── extensions/
│       ├── btw/        # 侧边栏对话浮层（/btw 或 Ctrl+Alt+B）
│       ├── plan-tracker/ # 非模态计划追踪（/plan）
│       ├── review/     # AI 代码审查（/review、/end-review）
│       ├── static-check/ # 多语言静态检查（tsc/mypy/golangci-lint/go vet/cargo）
│       ├── files/       # 交互式文件浏览器（/files、/diff）
│       ├── web-search/ # web_search + web_fetch + get_search_content 工具
│       ├── notify/      # agent 完成后发送桌面通知
│       ├── questionnaire/    # 交互式问卷工具（单选/多选/自定义输入）
│       ├── caveman/    # 复用 caveman skill 的会话级简洁回复模式（/caveman）
│       └── rtk.ts      # RTK token 节省代理
├── agents/             # `.agents` 目录（stow 到 $HOME）含 Skills
├── claude/             # `.claude` 目录（stow 到 $HOME）含 Claude 配置
├── pi/                 # `.pi` 目录（stow 到 $HOME）含 Pi 配置及加密密钥
├── skills/             # Skills 源码（vcs-commit、evals）
├── Makefile            # install / uninstall / decrypt 入口
├── package.json        # pi-package 声明，TypeScript devDep
└── tsconfig.json
```

## 扩展功能概览

| 扩展 | 命令/快捷键 | 功能 |
|------|------------|------|
| **btw** | `/btw`、`Ctrl+Alt+B` | 侧边悬浮对话，不污染主 session |
| **plan-tracker** | `/plan` | 非模态计划检测 + 执行追踪 + 工作日志 |
| **review** | `/review`、`/end-review` | Fork session 进行代码审查，支持 P0-P3 rubric |
| **static-check** | `/staticcheck` | 编辑文件后自动运行类型检查，可自动修复 |
| **files** | `/files`、`/diff` | 交互式文件浏览器（模糊搜索 + open/reveal/diff） |
| **web-search** | `web_search` + `web_fetch` + `get_search_content` tools | `web_search` 用于 DuckDuckGo 搜索，`web_fetch` 用于 URL 内容抓取，`get_search_content` 用于读取之前搜索/抓取结果的完整缓存内容（二进制 URL 自动 fallback 到 markitdown） |
| **notify** | 自动 | agent 完成工作后发送通知（OSC 777/99 或终端 bell）|
| **questionnaire** | `questionnaire` tool | 单题/多题交互式问卷（单选/多选/自定义输入） |
| **caveman** | `/caveman [level|off]` | 复用已安装 caveman skill，在当前 session 启用极简回复风格 |
| **rtk** | `/rtk` | 通过 rtk 代理压缩 token，节省费用 |
| **markitdown** | skill（自动触发） | 将 PDF/DOCX/PPTX/XLSX 等文档转为 Markdown（via `uv tool run markitdown`） |

## 开发约束

### 安装与部署
- 使用 `make install` 安装（先 decrypt 加密文件，再 stow）
- 使用 `make uninstall` 移除 stow symlinks
- **不要**直接修改 `$HOME/.pi`、`$HOME/.agents`、`$HOME/.claude` 里的文件，应修改本仓库后重新 stow

### 加密文件
- `pi/.pi/agent/models.enc.json` 和 `telegram.enc.json` 用 SOPS + age 加密
- 解密依赖 1Password SSH key（通过 `op` CLI）：`SOPS_AGE_SSH_PRIVATE_KEY_CMD = "op read ..."`
- 解密后的 `.json` 文件**不提交**到 git（`.gitignore` 已配置）

### TypeScript 扩展开发
- 扩展入口为 `pi-package/extensions/<name>/index.ts`，export default 函数接收 `ExtensionAPI`
- peer dependencies 来自 `@mariozechner/pi-*`，不要 lock 具体版本
- 编译目标由 `tsconfig.json` 决定；开发时使用 `typescript ^6`

### Skills
- `skills/` 是本仓库内 skill 的**唯一源码目录（source of truth）**；修改 skill 时只编辑 `skills/<name>/...`
- 每个 skill 有 `SKILL.md` 描述触发条件和使用规范
- **不要**直接修改 `agents/.agents/skills/`、`claude/.claude/skills/`、`$HOME/.agents/skills/` 或其他已安装目标路径中的 skill 文件
- 如需安装到目标路径，先修改 `skills/` 下源码，再通过你的安装流程（如 `npx skills add ...` / package / stow）同步过去

### 代码风格
- 扩展代码使用 TypeScript，文件顶部有 JSDoc 描述命令和功能
- 中文注释/文档用于面向用户的说明（review rubric、error message 等）
- 英文注释用于代码逻辑

## 常用命令

```bash
# 安装（解密 + stow）
make install

# 卸载 stow symlinks
make uninstall

# 仅解密配置文件
make decrypt

# TypeScript 类型检查
npx tsc --noEmit
```
