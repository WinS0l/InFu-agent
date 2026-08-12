import { sanitizeEnv } from "../src/sandbox/index.js";
import { runElevatedSandbox } from "../src/sandbox/sandbox-net.js";

const env = sanitizeEnv();
const proj = process.cwd();

let r = await runElevatedSandbox({ command: "whoami", cwd: proj, timeoutMs: 90000, env, sandboxUser: "offline" });
console.log("=== offline whoami ===");
console.log(JSON.stringify({ ok: r?.ok, code: r?.code, out: (r?.stdout ?? "").slice(0, 120), err: r?.error }));

r = await runElevatedSandbox({ command: "curl.exe -sS --max-time 6 https://example.com -o NUL && echo NET-OK || echo NET-BLOCKED", cwd: proj, timeoutMs: 90000, env, sandboxUser: "offline" });
console.log("=== offline curl（应断网）===");
console.log(JSON.stringify({ ok: r?.ok, code: r?.code, out: (r?.stdout ?? "").slice(0, 200), err: r?.error }));

r = await runElevatedSandbox({ command: "whoami", cwd: proj, timeoutMs: 90000, env, sandboxUser: "online" });
console.log("=== online whoami ===");
console.log(JSON.stringify({ ok: r?.ok, code: r?.code, out: (r?.stdout ?? "").slice(0, 120), err: r?.error }));

r = await runElevatedSandbox({ command: "curl.exe -sS --max-time 15 https://example.com -o NUL && echo NET-OK || echo NET-BLOCKED", cwd: proj, timeoutMs: 120000, env, sandboxUser: "online" });
console.log("=== online curl（应联网）===");
console.log(JSON.stringify({ ok: r?.ok, code: r?.code, out: (r?.stdout ?? "").slice(0, 200), err: r?.error }));
