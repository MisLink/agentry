/**
 * Safety Gate Extension for pi
 *
 * Prompts for confirmation before dangerous operations:
 * - Dangerous bash commands: rm, mv, sudo, chmod, kill, etc.
 * - write that overwrites existing files
 * - write/edit to paths outside current working directory
 *
 * Installation:
 *   cp safety-gate.ts ~/.pi/agent/extensions/
 *   or symlink from your agentry project
 *
 * Usage:
 *   pi (auto-loaded from extensions directory, /reload to hot-reload)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve, relative } from "node:path";
import { readFile } from "node:fs/promises";

/** 危险命令检测规则 */
const DANGEROUS_COMMANDS: Array<{
  pattern: RegExp;
  label: string;
  reason: string;
}> = [
  // 文件删除/移动
  { pattern: /\brm\b/, label: "⚠️ 确认删除", reason: "用户取消删除" },
  { pattern: /\bmv\b/, label: "⚠️ 确认移动/覆盖", reason: "用户取消移动" },

  // 权限与所有权
  { pattern: /\bsudo\b/, label: "⚠️ 提权执行", reason: "用户取消提权" },
  { pattern: /\bchmod\b/, label: "⚠️ 修改权限", reason: "用户取消权限修改" },
  { pattern: /\bchown\b/, label: "⚠️ 修改所有者", reason: "用户取消所有者修改" },

  // 进程管理
  { pattern: /\b(kill|killall|pkill)\b/, label: "⚠️ 终止进程", reason: "用户取消进程终止" },

  // 系统控制
  { pattern: /\b(reboot|shutdown|halt|poweroff)\b/, label: "⚠️ 系统关机/重启", reason: "用户取消系统操作" },

  // 磁盘操作
  { pattern: /\bdd\b/, label: "⚠️ 磁盘操作", reason: "用户取消磁盘操作" },
  { pattern: /\bmkfs\b/, label: "⚠️ 格式化磁盘", reason: "用户取消格式化" },
  { pattern: /\b(fdisk|parted)\b/, label: "⚠️ 磁盘分区", reason: "用户取消分区操作" },

  // 危险重定向（/dev/null 是安全的）
  { pattern: />\s*\/dev\/(?!null\b)/, label: "⚠️ 写入设备文件", reason: "用户取消设备写入" },
  { pattern: />\s*\/etc\//, label: "⚠️ 写入系统配置", reason: "用户取消系统配置写入" },

  // 下载并执行
  { pattern: /(curl|wget)\s+.*\|\s*(sh|bash)/, label: "⚠️ 下载并执行脚本", reason: "用户取消脚本执行" },
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) return undefined;

    // 1. 检查 bash 中的危险命令
    if (event.toolName === "bash") {
      const cmd = event.input.command as string;

      for (const rule of DANGEROUS_COMMANDS) {
        if (rule.pattern.test(cmd)) {
          const ok = await ctx.ui.confirm(rule.label, `执行命令？\n\n${cmd}`);
          if (!ok) return { block: true, reason: rule.reason };
          break; // 匹配到第一条就停止，避免多次弹窗
        }
      }
    }

    // 2. 检查 write/edit 操作
    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      
      // 写入 /dev/null 是安全的
      if (filePath === "/dev/null") {
        return undefined;
      }

      const absolute = resolve(ctx.cwd, filePath);
      const rel = relative(ctx.cwd, absolute);

      // 检查是否在当前工作目录之外
      if (rel.startsWith("..")) {
        const ok = await ctx.ui.confirm(
          "⚠️ 跨目录修改",
          `目标路径在工作目录之外：\n\n${absolute}\n\n允许？`
        );
        if (!ok) return { block: true, reason: "用户取消跨目录修改" };
      }

      // write 操作：检查是否覆盖已有文件
      if (event.toolName === "write") {
        try {
          await readFile(absolute, "utf8");
          const ok = await ctx.ui.confirm(
            "⚠️ 覆盖文件",
            `文件已存在，确认覆盖？\n\n${filePath}`
          );
          if (!ok) return { block: true, reason: "用户取消覆盖" };
        } catch {
          // 文件不存在，正常创建
        }
      }
    }
  });
}
