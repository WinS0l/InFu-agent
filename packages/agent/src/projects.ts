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
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: number;
}

const PROJECTS_FILE = path.join(os.homedir(), ".infu", "projects.json");

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
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
    const arr = Array.isArray(raw?.projects) ? raw.projects : [];
    return arr
      .filter((p: unknown) => p && typeof (p as Project).root === "string" && typeof (p as Project).name === "string")
      .map((p: Project) => ({ id: p.id, name: p.name, root: normalizeRoot(p.root), createdAt: Number(p.createdAt) || 0 }));
  } catch {
    try { fs.renameSync(PROJECTS_FILE, `${PROJECTS_FILE}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return [];
  }
}

function saveProjects(projects: Project[]) {
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ version: 1, projects }, null, 2), "utf-8");
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
  return { ok: true, project, message: `已创建项目「${project.name}」` };
}

/** 移除项目（只删注册；会话保留为自由会话） */
export function removeProject(id: string): { ok: boolean; message: string } {
  const projects = listProjects();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return { ok: false, message: "项目不存在" };
  const removed = projects.find((p) => p.id === id)!;
  saveProjects(next);
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
