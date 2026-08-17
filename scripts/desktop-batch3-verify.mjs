/** 批 3 验证（原生 CDP ws——playwright 强制 exit 会残留半开会话） */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("5199"));
if (!page) { console.log("FAIL: no main"); process.exit(1); }
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
const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await call("Runtime.enable");

// 1. 打开浏览器 tab（若未打开）
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().startsWith('浏览器')); if (b) b.click(); return true; })()`);
await sleep(2000);

// 2. 新建 tab → 期望 2 个 data: 起始页
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.title === '新建标签页'); if (b) b.click(); return !!b; })()`);
await sleep(1500);
let targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
console.log(`新建 tab 后起始页数: ${targets.filter(t => t.url.startsWith('data:')).length}（期望 2）`);

// 3. 地址栏导航
await evaluate(`(() => {
  const input = [...document.querySelectorAll('input')].find(i => i.placeholder.includes('网址'));
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'https://example.com');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
await sleep(5000);
targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
console.log("导航 example.com:", targets.some(t => t.url.includes("example.com")) ? "OK" : "FAIL");

// 4. 视口 375×667
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.title.includes('视口尺寸')); if (b) b.click(); return !!b; })()`);
await sleep(400);
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('手机 375×667')); if (b) b.click(); return !!b; })()`);
await sleep(1500);
const embPage = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find(t => t.url.includes("example.com"));
if (embPage) {
  const ws2 = new WebSocket(embPage.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; });
  const r2 = await new Promise((res, rej) => {
    ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result); };
    ws2.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "window.innerWidth + 'x' + window.innerHeight", returnByValue: true } }));
    setTimeout(() => rej(new Error("timeout")), 8000);
  });
  console.log("视口 375×667:", r2.result.value === "375x667" ? "OK" : `FAIL ${r2.result.value}`);
  ws2.close();
}

// 5. 关闭 tab（点第一个 ×）→ 期望嵌入式页数 1
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.title === '关闭标签页'); if (b) b.click(); return !!b; })()`);
await sleep(2000);
targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const embCount = targets.filter(t => t.type === "page" && !t.url.includes("5199") && !t.url.startsWith("devtools://")).length;
console.log("关闭 tab 后嵌入式页数:", embCount === 1 ? "OK(1)" : `FAIL(${embCount})`);

ws.close();
console.log("验证完成");
