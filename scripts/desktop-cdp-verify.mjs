/** 桌面端验证（原生 CDP WebSocket，绕开 playwright 兼容问题）：页面状态 + API 连通 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("5199"));
if (!page) {
  console.log("FAIL: 主窗口页面未找到");
  console.log(list.map((t) => `${t.type} ${t.url}`).join("\n"));
  process.exit(1);
}
console.log("target:", page.title, "|", page.url.slice(0, 80));

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
const r = await call("Runtime.evaluate", {
  expression: `(async () => {
    const out = {};
    out.search = location.search;
    out.hasBridge = !!window.infuDesktop;
    out.title = document.title;
    try {
      const res = await fetch("/api/health");
      const h = await res.json();
      out.health = h.name + " tools=" + h.tools;
    } catch (e) { out.health = "ERR " + e.message; }
    const aside = document.querySelector("aside");
    out.sidebar = aside ? aside.innerText.slice(0, 100).replace(/\\n/g, " | ") : "无 aside";
    out.minBtn = !!document.querySelector("button[title='最小化']");
    out.maxBtn = !!document.querySelector("button[title='最大化']");
    out.closeBtn = !!document.querySelector("button[title='关闭']");
    out.bodyText = document.body.innerText.slice(0, 150).replace(/\\n/g, " | ");
    return out;
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(r.result.value, null, 2));
ws.close();
