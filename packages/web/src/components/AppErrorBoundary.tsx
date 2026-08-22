import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { failed: boolean }

/** Keep persisted sessions usable when a non-critical workbench view crashes. */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[infu-web] render failure", error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="flex h-full items-center justify-center bg-ink p-6"><section className="max-w-md rounded-3xl border border-line bg-elevated p-7 shadow-lv3"><div className="text-lg font-semibold text-text">工作台暂时无法渲染</div><p className="mt-2 text-sm leading-6 text-sub">本地会话数据没有被修改。重新加载可恢复工作区；若问题持续，请在命令审计中查看最近错误。</p><button className="mt-5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover" onClick={() => window.location.reload()}>重新加载</button></section></main>;
  }
}
