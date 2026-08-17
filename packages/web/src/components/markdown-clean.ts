import { useEffect, type RefObject } from "react";

/**
 * v2.9：streamdown 表格/代码块自带卡片包装（my-4 rounded-xl border bg-sidebar + 内层
 * rounded-md border）→ 内联样式去框，内容纯直出。streamdown 硬编码类无法从 props 关闭；
 * 幂等全量清理，不设完成标记（流式渲染中途挂上的内层 div 也能被后续 mutation 清掉）。
 * 聊天区与子 Agent 详情共用（v2.9 修复：子 Agent 消息流里的「两个框」）。
 */
export function useCleanMarkdownBoxes(ref: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const clean = (root: HTMLElement) => {
      root.querySelectorAll("div.my-4").forEach((d) => {
        const el = d as HTMLElement;
        if (!d.querySelector("table") && !d.querySelector("pre")) return;
        el.style.background = "transparent";
        el.style.border = "none";
        el.style.borderRadius = "0";
        el.style.boxShadow = "none";
        el.style.padding = "0";
        // 内层滚动/边框容器（overflow-x-auto rounded-md border）
        d.querySelectorAll("div").forEach((inner) => {
          const ie = inner as HTMLElement;
          if (!ie.querySelector("table") && !ie.querySelector("pre")) return;
          ie.style.background = "transparent";
          ie.style.border = "none";
          ie.style.borderRadius = "0";
          ie.style.padding = "0";
        });
      });
    };
    const root = ref.current;
    if (!root) return;
    clean(root);
    const mo = new MutationObserver(() => clean(root));
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
