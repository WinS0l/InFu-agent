/** 嵌入式浏览器实测：模拟点击右侧栏「浏览器」tab → 验证 WebContentsView 创建 + CDP target */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("5199"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = (e) => j(new Error("ws err")); });
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
// 点击「浏览器」tab（空态面板按钮或已存在 tab）
const r = await call("Runtime.evaluate", {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => x.textContent.includes('浏览器') && !x.title.includes('浏览器面板（桌面版'));
    if (b) { b.click(); return 'clicked: ' + b.textContent.trim().slice(0, 20); }
    return 'no browser button found; buttons: ' + btns.slice(0, 12).map(x => x.textContent.trim().slice(0, 10)).join(',');
  })()`,
  returnByValue: true,
});
console.log("click:", r.result.value);
await new Promise((r) => setTimeout(r, 2500));

// 检查新 target（嵌入式浏览器 WebContentsView）
const list2 = await (await fetch("http://127.0.0.1:9222/json/list")).json();
console.log("\n=== targets after open ===");
for (const t of list2) console.log(" -", t.type, "|", JSON.stringify(t.title), "|", JSON.stringify(t.url.slice(0, 80)));

ws.close();
