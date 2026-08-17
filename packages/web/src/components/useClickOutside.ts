import { useEffect, useRef } from "react";

/**
 * v3.0 批 12：下拉栏「点击空白处自动收起」通用 hook
 * 用法：const ref = useClickOutside(() => setOpen(false));
 *       挂在下拉容器的 ref 上——点击容器外任意处触发关闭
 */
export function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef(onOutside);
  cbRef.current = onOutside;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) cbRef.current();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return ref;
}

/** 多下拉容器版本（同一组件多个下拉共用一个 ref 容器时） */
export function useClickOutsideAll(handlers: Array<() => void>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const hRef = useRef(handlers);
  hRef.current = handlers;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) {
        for (const h of hRef.current) h();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return ref;
}
