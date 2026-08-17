/** 端到端实测：桌面窗口聊天输入「用浏览器打开必应搜索」→ Agent 调 browser_navigate 驱动嵌入式浏览器 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("5199"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

await call("Runtime.enable");

// 在聊天输入框输入任务并发送
const r = await call("Runtime.evaluate", {
  expression: `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用浏览器打开 https://www.bing.com 搜索 InFu');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`,
  returnByValue: true,
});
console.log("输入:", r.result.value);
await new Promise((r) => setTimeout(r, 500));
const r2 = await call("Runtime.evaluate", {
  expression: `(() => {
    // 发送按钮：输入卡右侧圆形按钮（非停止态）
    const btns = [...document.querySelectorAll('button')];
    const send = btns.find(b => b.querySelector('svg') && b.closest('form') === null && b.getAttribute('aria-label'));
    // 兜底：找最右侧圆形小按钮
    const round = btns.find(b => {
      const s = b.querySelector('svg');
      return s && !b.textContent.trim() && b.className.includes('rounded-full');
    });
    if (round) { round.click(); return 'sent via round btn'; }
    return 'no send btn';
  })()`,
  returnByValue: true,
});
console.log("发送:", r2.result.value);

// 轮询嵌入式浏览器 URL 变化（Agent 驱动证据）
console.log("轮询嵌入式浏览器 URL（Agent 驱动）...");
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const emb = targets.find((t) => t.type === "page" && !t.url.includes("5199"));
  if (emb && emb.url.startsWith("https://")) {
    console.log(`第 ${i + 1} 轮: 嵌入式浏览器已导航 → ${emb.url.slice(0, 70)}`);
    if (emb.url.includes("bing.com/search")) {
      console.log("✅ Agent 成功驱动嵌入式浏览器完成搜索");
      break;
    }
  } else {
    console.log(`第 ${i + 1} 轮: 嵌入式浏览器状态 ${emb ? emb.url.slice(0, 40) : "未创建"}`);
  }
}
ws.close();
