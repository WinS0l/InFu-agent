/**
 * AI 可访问性树（v3.0 对齐 主流/InFu domSnapshot）——browser_snapshot 的页面结构区
 * 实现：CDP Accessibility.getFullAXTree（与 主流 Desktop 的 domSnapshot 同技术）——
 * 输出紧凑的可访问性树（角色/可访问名/状态/层级/shadow DOM）+ 交互节点 [n] 编号
 * （编号 = 点击操作的单一来源，与 click 定位一致——根治编号错位）。
 * iframe 遍历（Page.getFrameTree → 每 frame 单独 getFullAXTree，标记 <iframe>）；
 * 交互节点编号映射 backendDOMNodeId（clickByIndex 用 CDP 定位点击）。
 * v3.0 批 8：CDP 客户端抽象化（桌面 = 主进程桥，Web = playwright CDPSession）。
 */
import type { CdpClient } from "./cdp.js";

interface AxNode {
  nodeId: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  backendDOMNodeId?: number;
}

const MAX_NODES = 150;
const MAX_DEPTH = 12;
const NAME_CLIP = 60;

/** 可操作角色（参与 [n] 编号，可被 click 定位） */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab", "switch",
  "searchbox", "spinbutton", "slider", "listbox", "menu", "dialog", "treeitem", "colorwell",
]);

export interface AxSnapshotResult {
  /** 树文本（交互节点行带 [n] 前缀） */
  text: string;
  /** 编号 → backendDOMNodeId（clickByIndex CDP 定位用） */
  indexMap: Map<number, number>;
}

/** 从节点 properties 提取单个值 */
function propStr(node: AxNode, key: string): string | undefined {
  const v = node.properties?.find((p) => p.name === key)?.value?.value;
  return v === undefined || v === null ? undefined : String(v);
}

/** 渲染单行：[n] <role> "name" [状态后缀] */
function renderLine(node: AxNode, idx: number | null): string {
  const role = node.role?.value ?? "unknown";
  const name = (node.name?.value ?? "").trim();
  const value = propStr(node, "valuetext") ?? node.value?.value?.trim();
  const line = [
    idx != null ? `[${idx}]` : null,
    `<${role}>`,
    name ? `"${name.slice(0, NAME_CLIP)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const suffix: string[] = [];
  const checked = propStr(node, "checked");
  if (checked && checked !== "false") suffix.push(checked === "mixed" ? "[mixed]" : "[checked]");
  if (propStr(node, "disabled") === "true") suffix.push("[disabled]");
  const expanded = propStr(node, "expanded");
  if (expanded === "true") suffix.push("[expanded]");
  else if (expanded === "false") suffix.push("[collapsed]");
  const pressed = propStr(node, "pressed");
  if (pressed === "true") suffix.push("[pressed]");
  const selected = propStr(node, "selected");
  if (selected === "true") suffix.push("[selected]");
  const level = propStr(node, "level");
  if (level && role !== "listitem") suffix.push(`[level ${level}]`);
  if (propStr(node, "hasPopup") === "true") suffix.push("[popup]");
  if (propStr(node, "focused") === "true") suffix.push("[focused]");
  const live = propStr(node, "live");
  if (live && live !== "off") suffix.push(`[live:${live}]`);
  if (value) suffix.push(`= ${value.slice(0, 40)}`);
  return suffix.length ? `${line} ${suffix.join(" ")}` : line;
}

/** 单 frame 的 AX 树 → 行文本（交互节点编号）+ 编号映射 */
function renderFrame(ax: AxNode[], frameLabel: string | null, indexMap: Map<number, number>, lines: string[]): void {
  const byId = new Map(ax.map((n) => [n.nodeId, n]));
  const childrenOf = new Map<string, AxNode[]>();
  const roots: AxNode[] = [];
  for (const n of ax) {
    if (n.ignored) continue;
    for (const cid of n.childIds ?? []) {
      const child = byId.get(cid);
      if (child && !child.ignored) {
        const list = childrenOf.get(n.nodeId) ?? [];
        list.push(child);
        childrenOf.set(n.nodeId, list);
      }
    }
    const hasParent = ax.some((p) => p.childIds?.includes(n.nodeId) && !p.ignored);
    if (!hasParent) roots.push(n);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => ax.indexOf(a) - ax.indexOf(b));
  roots.sort((a, b) => ax.indexOf(a) - ax.indexOf(b));

  if (frameLabel) lines.push(frameLabel);
  let count = 0;
  const walk = (node: AxNode, depth: number) => {
    if (count >= MAX_NODES || depth > MAX_DEPTH) return;
    const role = node.role?.value ?? "";
    if (role === "InlineTextBox" || role === "none") return;
    count++;
    // 交互节点编号（单一来源——click 定位与快照一致）
    let idx: number | null = null;
    if (INTERACTIVE_ROLES.has(role)) {
      idx = indexMap.size + 1;
      if (node.backendDOMNodeId != null) indexMap.set(idx, node.backendDOMNodeId);
    }
    lines.push("  ".repeat(depth) + renderLine(node, idx));
    for (const child of childrenOf.get(node.nodeId) ?? []) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
}

/** 生成 AI 可访问性树文本 + 编号映射；失败返回 null（调用方降级） */
export async function axSnapshot(cdp: CdpClient): Promise<AxSnapshotResult | null> {
  try {
    await cdp.send("Accessibility.enable");
    const indexMap = new Map<number, number>();
    const lines: string[] = [];

    // 主 frame 树
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    renderFrame((nodes ?? []) as AxNode[], null, indexMap, lines);

    // iframe 遍历（v3.0 批 5：每 frame 单独树，<iframe> 标记）
    try {
      const frameTreeRes = await cdp.send("Page.getFrameTree");
      const frameTree = frameTreeRes.frameTree as
        | { frame: { id: string; url?: string }; childFrames?: Array<{ frame: { id: string; url?: string }; childFrames?: unknown[] }> }
        | undefined;
      const walkFrames = (node: { frame: { id: string; url?: string }; childFrames?: unknown[] }, depth: number) => {
        for (const child of (node.childFrames ?? []) as Array<{ frame: { id: string; url?: string }; childFrames?: unknown[] }>) {
          const url = child.frame.url ?? "";
          const label = `  ${"  ".repeat(depth)}[iframe] ${url.slice(0, 80)}`;
          const childAx = cdp.send("Accessibility.getFullAXTree", { frameId: child.frame.id });
          childAx
            .then((res) => {
              const fn = (res.nodes ?? []) as AxNode[];
              if (fn.length) renderFrame(fn, label, indexMap, lines);
            })
            .catch(() => {});
          walkFrames(child, depth + 1);
        }
      };
      if (frameTree) walkFrames(frameTree, 0);
      // 等 iframe 树（异步）
      await new Promise((r) => setTimeout(r, 150));
    } catch { /* iframe 遍历失败不影响主树 */ }

    if (!lines.length) return null;
    const truncated = lines.length >= MAX_NODES;
    return {
      text: lines.join("\n") + (truncated ? `\n…（可访问性树已截断，可结合页面文本阅读）` : ""),
      indexMap,
    };
  } catch {
    return null;
  }
}

/**
 * 按编号点击（编号来自 AX 树——与快照同一来源）。
 * CDP 定位：backendDOMNodeId → DOM.describeNode → DOM.resolveNode → Runtime.callFunctionOn 触发 click
 * 失败返回错误描述（调用方并入快照输出）。
 * v3.0 批 8：必须传「与展示给 Agent 的同一份 snapshot」的 indexMap——
 * 动态页面（bing 等）两次 snapshot 之间编号漂移，click 内重取会导致
 * 编号→backendDOMNodeId 映射错位（describeNode nodeId=0）。
 */
export async function clickByIndex(cdp: CdpClient, idx: number, ax?: AxSnapshotResult | null): Promise<string> {
  const snap = ax ?? (await axSnapshot(cdp));
  const backendId = snap?.indexMap.get(idx);
  if (backendId == null) {
    return `错误：编号 ${idx} 不存在，请重新 browser_snapshot 确认`;
  }
  try {
    const { node } = await cdp.send("DOM.describeNode", { backendNodeId: backendId });
    if (!node || !(node as { nodeId?: number }).nodeId) return `错误：编号 ${idx} 无法定位元素`;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId: (node as { nodeId: number }).nodeId });
    await cdp.send("Runtime.callFunctionOn", {
      objectId: (object as { objectId: string }).objectId,
      functionDeclaration: "function () { this.click(); if (typeof this.focus === 'function') this.focus(); return true; }",
      returnByValue: true,
    });
    return "已点击";
  } catch (e) {
    return `点击失败：${(e as Error).message}（请重新 browser_snapshot）`;
  }
}
