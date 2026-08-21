/**
 * v3.5 数据目录定位与迁移：根目录可选，内部结构固定。
 * - 默认数据目录 = ~/.infu（config.json/infu.db/projects/schedules/memory/skills/agents/plugins/logs 等全部在内）
 * - 用户可通过设置界面把整个数据目录迁移到任意文件夹：旧位置 ~/.infu 只留下一个重定向指针
 *   文件 ~/.infu-redirect.json（{"dir": "<新目录>"}），此后所有模块经 resolveDataDir() 解析新位置。
 * - 重定向文件固定位于 homedir 根（避免「指针自身随目录被搬走」的鸡生蛋问题）；
 *   版本化内部结构（infu.db/projects.json 等子项）固定不可改。
 */
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, cpSync, statSync, readdirSync, renameSync } from "node:fs";

export const REDIRECT_FILE = join(homedir(), ".infu-redirect.json");
const DEFAULT_DATA_DIR = join(homedir(), ".infu");

let cachedDir: string | null = null;

/** 解析当前数据目录（redirect 指针优先，缺省 ~/.infu）；进程级缓存，迁移后 invalidateDataDir() */
export function resolveDataDir(): string {
  if (cachedDir) return cachedDir;
  let dir = DEFAULT_DATA_DIR;
  try {
    if (existsSync(REDIRECT_FILE)) {
      const raw = JSON.parse(readFileSync(REDIRECT_FILE, "utf-8"));
      if (typeof raw?.dir === "string" && raw.dir && isAbsolute(raw.dir)) dir = raw.dir;
    }
  } catch {
    // 指针文件损坏/不可读 → 回退默认目录（不阻塞启动）
  }
  cachedDir = dir;
  return dir;
}

/** 使缓存失效（迁移完成/测试注入后调用），下次 resolveDataDir 重新解析 */
export function invalidateDataDir(): void {
  cachedDir = null;
}

/** 测试专用：直接指定数据目录（覆盖 redirect/默认解析，便于单测隔离） */
export function setDataDirForTest(dir: string): void {
  cachedDir = dir;
}

/** 默认数据目录（~/.infu） */
export function defaultDataDir(): string {
  return DEFAULT_DATA_DIR;
}

export interface MigrateResult {
  ok: boolean;
  message: string;
  from: string;
  to?: string;
}

/**
 * 迁移数据目录：目标校验 → 整体复制（保留旧数据）→ 写入 redirect 指针 → 失效缓存。
 * 校验规则：非空目标目录必须为空（防覆盖冲突）；禁止根路径/当前目录/受保护区域；目标自身不能是已有文件。
 */
export function migrateDataDir(targetRaw: string): MigrateResult {
  const cur = resolveDataDir();
  // 先校验原始输入为绝对路径——resolve 会把相对路径静默解析成 cwd 下的绝对路径
  // （v3.5 bug 修复：此前先 resolve 再校验 isAbsolute 永远为 true，相对路径被放行并真实迁移）
  if (!targetRaw || !isAbsolute(targetRaw)) {
    return { ok: false, message: "路径必须为绝对路径（如 D:\\InFuData）", from: cur };
  }
  const target = resolve(targetRaw);
  const guardErr = validateTarget(target, cur);
  if (guardErr) return { ok: false, message: guardErr, from: cur };

  // 复制前确保目标父目录存在；复制内容 = 整个旧目录（含 config.json）
  // v4.0 审计修复（M11）：互迁/迁回目标已含 config.json 时，原实现逐项 force 复制 =
  // 破坏性覆盖合并（目标独有文件残留 + 同名文件被静默覆盖）。先整体改名备份
  // （目标.bak-<ts>），再全新复制——目标侧独有数据完整保留可查，无混合目录。
  let targetBackup = "";
  if (existsSync(target)) {
    try {
      const st = statSync(target);
      if (st.isDirectory() && existsSync(join(target, "config.json"))) {
        targetBackup = `${target}.bak-${Date.now()}`;
        renameSync(target, targetBackup);
      }
    } catch {
      return { ok: false, message: `目标目录备份失败（无法重命名目标）`, from: cur };
    }
  }
  mkdirSync(target, { recursive: true });
  try {
    // v3.5 bug 修复：Node 24 Windows 下同步 fs.cpSync(src, dst) 整体复制在服务进程内会
    // abort（0xC0000409，原因未明；独立进程/逐项复制均正常）→ 改逐项复制规避
    for (const name of readdirSync(cur)) {
      cpSync(join(cur, name), join(target, name), { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, message: `复制失败：${(e as Error).message}`, from: cur };
  }
  // 写入重定向指针（旧位置 homedir 根固定文件；旧 ~/.infu 保留完整备份）
  try {
    mkdirSync(join(homedir()), { recursive: true });
    const tmp = `${REDIRECT_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ dir: target }, null, 2), "utf-8");
    renameSync(tmp, REDIRECT_FILE);
  } catch (e) {
    return { ok: false, message: `指针写入失败：${(e as Error).message}`, from: cur };
  }
  invalidateDataDir();
  return {
    ok: true,
    message: `数据已迁移到 ${target}（旧目录已保留为备份${targetBackup ? `；目标原有数据已备份到 ${targetBackup}` : ""}）`,
    from: cur,
    to: target,
  };
}

/** 目标路径合法性校验（返回错误文案；null = 通过） */
export function validateTarget(target: string, cur: string): string | null {
  if (!target || !isAbsolute(target)) return "路径必须为绝对路径（如 D:\\InFuData）";
  const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, "");
  if (norm(target) === norm(cur)) return "新路径与当前数据目录相同";
  if (norm(target) === norm(homedir())) return "不能选择用户主目录本身";
  const rootLen = process.platform === "win32" ? 3 : 1;
  if (target.length <= rootLen) return "不能选择磁盘根目录";
  // 目标不能是当前数据目录的子目录（迁移嵌套自身会无限递归复制）
  if (norm(target).startsWith(norm(cur) + "\\") || norm(target).startsWith(norm(cur) + "/")) {
    return "不能迁移到当前数据目录内部";
  }
  if (existsSync(target)) {
    let st;
    try { st = statSync(target); } catch { return "目标路径不可访问"; }
    if (!st.isDirectory()) return "目标路径是已有文件，请选择文件夹";
    const entries = readdirSafe(target);
    if (entries.length > 0) {
      // v3.5 bug 修复：目标已是 InFu 数据目录（含 config.json）→ 放行（迁回/数据目录间互迁——
      // 原目录保留旧数据为备份，非空但合法）；否则拒绝防覆盖用户已有文件夹
      if (!existsSync(join(target, "config.json"))) {
        return `目标文件夹非空（含 ${entries.length} 项），请选择空文件夹或新建文件夹`;
      }
    }
  }
  return null;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
