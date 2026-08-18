/**
 * v2.6.1 项目注册表（~/.infu/projects.json）
 *
 * 项目 = 用户显式创建（选择文件夹/输入路径）注册的容器；会话通过 root 命中
 * 注册表判断隶属（未命中 = 自由会话）。移除项目只删注册条目，不删文件夹、
 * 不删会话（该 root 下会话转为自由会话，数据不丢）。
 *
 * 安全：项目注册表位于 ~/.infu（写保护区域）——本模块是唯一合法写入通道
 * （对齐 memory_write 白名单模式）；root 必须为已存在的目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cleanupOldBackups } from "./cleanup.js";
import { deleteIndex } from "./index/index.js";
import { resolveDataDir } from "./data-dir.js";

export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: number;
}

function projectsFilePath(): string {
  return path.join(resolveDataDir(), "projects.json");
}

/** root 归一化（去尾部分隔符；Windows 大小写不敏感比较用 lower） */
export function normalizeRoot(root: string): string {
  return root.trim().replace(/[\\/]+$/, "");
}

/** root 等价比较（Windows 大小写不敏感） */
export function sameRoot(a: string, b: string): boolean {
  return normalizeRoot(a).toLowerCase() === normalizeRoot(b).toLowerCase();
}

/** 读取注册表（文件缺失/损坏返回空列表；损坏备份后重建） */
export function listProjects(): Project[] {
  const PROJECTS_FILE = projectsFilePath();
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
    const arr = Array.isArray(raw?.projects) ? raw.projects : [];
    return arr
      .filter((p: unknown) => p && typeof (p as Project).root === "string" && typeof (p as Project).name === "string")
      .map((p: Project) => ({ id: p.id, name: p.name, root: normalizeRoot(p.root), createdAt: Number(p.createdAt) || 0 }));
  } catch {
    try { fs.renameSync(PROJECTS_FILE, `${PROJECTS_FILE}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    // v3.5 数据生命周期：顺带清理超期损坏备份（.corrupt-* 永久累积）
    try { cleanupOldBackups(PROJECTS_FILE); } catch { /* ignore */ }
    return [];
  }
}

function saveProjects(projects: Project[]) {
  const PROJECTS_FILE = projectsFilePath();
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  // v3.5：原子写（tmp + rename）——多进程并发（server/CLI/定时任务）直写会截断半写内容，
  // 读方 JSON.parse 失败 → 反复产生 .corrupt-* 备份（本机曾累积 9 个）
  const tmp = `${PROJECTS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2), "utf-8");
  fs.renameSync(tmp, PROJECTS_FILE);
}

/** 注册项目；root 必须存在；返回 {ok, project?, message} */
export function createProject(root: string, name?: string): { ok: boolean; project?: Project; message: string } {
  const r = normalizeRoot(root);
  if (!r) return { ok: false, message: "root 不能为空" };
  if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
    return { ok: false, message: `目录不存在：${r}` };
  }
  const projects = listProjects();
  if (projects.some((p) => sameRoot(p.root, r))) {
    return { ok: false, message: `该项目已存在：${r}` };
  }
  const project: Project = {
    id: `p-${randomUUID().slice(0, 8)}`,
    name: (name?.trim() || path.basename(r) || r).slice(0, 60),
    root: r,
    createdAt: Date.now(),
  };
  projects.push(project);
  saveProjects(projects);
  // v3.3 补 23（对齐 opencode project git init API）：新建项目自动初始化 git 仓库——
  // 非 git 目录 git init（失败静默不阻塞创建）；审查/代码界面的改动 diff 立即可用
  let initNote = "";
  if (!isGitRepoDir(r)) {
    try {
      execFileSync("git", ["init"], { cwd: r, stdio: "ignore", windowsHide: true });
      ensureGitIgnore(r); // v3.3 补 26：.infu/ 是 InFu 自身数据，不跟踪（否则嵌套 worktree 无法 add）
      initNote = "（已自动初始化 git 仓库——代码改动与审查立即可用）";
    } catch {
      /* git 不可用/初始化失败——静默降级（审查功能不可用但不阻塞） */
    }
  }
  return { ok: true, project, message: `已创建项目「${project.name}」${initNote}` };
}

/** v3.3 补 26：确保 .gitignore 包含 .infu/（InFu 自身数据不跟踪——嵌套 worktree
 *  目录无法被 git add 索引，不加会导致基线提交失败/污染） */
export function ensureGitIgnore(dir: string): void {
  try {
    const gi = path.join(dir, ".gitignore");
    const has = fs.existsSync(gi) && fs.readFileSync(gi, "utf-8").split(/\r?\n/).some((l) => l.trim() === ".infu/");
    if (!has) fs.appendFileSync(gi, (fs.existsSync(gi) ? "\n" : "") + ".infu/\n", "utf-8");
  } catch {
    /* 写失败静默（不影响主流程） */
  }
}

/** v3.3 补 23：目录是否为 git 仓库（.git 存在 + git 命令可用；worktree 的 .git 是指针文件） */
export function isGitRepoDir(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 移除项目（只删注册；会话保留为自由会话；v3.5：连带清理孤儿索引文件） */
export function removeProject(id: string): { ok: boolean; message: string } {
  const projects = listProjects();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return { ok: false, message: "项目不存在" };
  const removed = projects.find((p) => p.id === id)!;
  saveProjects(next);
  // v3.5 数据生命周期：~/.infu/index/<root-hash>.json 按 root 哈希命名——项目移除后
  // 索引永久孤儿；这里同步删除（仅索引文件，不动项目文件夹）；失败不影响移除
  try { deleteIndex(removed.root); } catch { /* ignore */ }
  return { ok: true, message: `已移除项目「${removed.name}」（会话保留为自由会话，文件夹未删除）` };
}

/** 查询 root 命中的项目（未注册返回 null） */
export function findProjectByRoot(root: string): Project | null {
  return listProjects().find((p) => sameRoot(p.root, root)) ?? null;
}

/**
 * 按目录名解析候选路径（v2.6.1 浏览文件夹降级：浏览器拿不到所选文件夹的绝对路径，
 * 只给目录名——服务端在常见位置（各盘符根 + 用户目录）的一层子目录中精确匹配同名目录，
 * 返回候选列表供用户确认）。只读扫描，不递归。
 */
export function resolveProjectByName(name: string): string[] {
  const n = name.trim();
  if (!n) return [];
  const roots: string[] = [];
  for (const drive of "CDEFGH".split("")) {
    const p = `${drive}:\\`;
    if (fs.existsSync(p)) roots.push(p);
  }
  roots.push(os.homedir());
  roots.push(resolveDataDir());
  const out: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase() === n.toLowerCase()) {
          out.push(path.join(root, entry.name));
        }
      }
    } catch {
      /* 无权限目录跳过 */
    }
  }
  return out;
}
