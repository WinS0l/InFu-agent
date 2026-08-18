# InFu Web 交互式终端（v2.4 批 2）

Web 端底部通栏终端面板（xterm.js + node-pty），用户可直接在浏览器里操作项目 shell。

## 架构

```
浏览器 (xterm.js)
  │  POST /api/terminal                     创建会话（node-pty spawn cmd/powershell/bash）
  │  POST /api/terminal/:id/input           写入输入（{ data, command?, confirmed? }）
  │  POST /api/terminal/:id/resize          同步 PTY 尺寸
  │  DELETE /api/terminal/:id               终止会话（kill 进程）
  │  GET  /api/terminal/:id/stream          SSE 输出流（output/exit/ping；新连接重放会话缓冲）
  ▼
packages/agent/src/terminal/
  ├─ session.ts   会话管理：node-pty（Windows ConPTY）、输出环形缓冲（64KB，SSE 重连重放）、
  │               多会话 Map、服务退出统一清理（closeAllTerminalSessions）
  └─ policy.ts    命令策略：高危命令检测（rm -rf / del /f / format / mkfs / dd if=）+ 全量审计
```

- 输出经 SSE 推送：`GET /api/terminal/:id/stream` 先重放会话缓冲（收起/展开不丢内容），再实时转发
- 输入为**命令级**协议：前端回车结算整行，`command` 字段供服务端高危检测与审计；非命令字符
  （Ctrl+C 等）单独透传保证即时响应

## 安全模型

终端 = **用户亲手输入**的命令，信任级别等同用户本人直接开终端，但仍保留两道防线：

1. **高危命令审批**：`rm -rf` / `del /f` / `format` / `mkfs` / `dd if=` 等删除/格式化类命令
   在写入前拦截（未确认不写入 PTY），前端弹 Dark OLED 确认框，人工批准后带 `confirmed: true`
   重发才执行。**命令白名单不豁免终端**（白名单是给 Agent 的 run_command 用的；用户输入即用户
   意图，危险操作仍二次确认——安全红线与 run_command 一致）。
2. **全量审计**：每条命令 `auditCommand` 落盘 `logs/commands.log`（默认 `~/.infu/logs/`，数据目录迁移后跟随重定向目录；`sandbox=terminal` 标签，5MB×3 轮转）。

### 沙箱边界

- 终端进程**直连本机 spawn**，不走 L1.5 受限令牌/Job 整命令执行模型——PTY 需要交互式
  stdin/stdout 会话，与 run_command 的一次性执行模型不兼容
- 环境变量经 `sanitizeEnv` 消毒（宿主密钥不泄漏进子进程）
- 工作目录 = Web 当前项目根；`off` 档语义等同直连
- Windows 下 node-pty 经 ConPTY；conpty_console_list_agent 的 `AttachConsole failed`
  输出为已知噪音（辅助进程无 console），不影响功能

## 前端交互

- 右下角常驻「终端」按钮展开/收起底部通栏（240px）；收起 = 断开 SSE，会话保留，再展开重连重放
- 工具条「新建会话」= kill 旧会话 + 重建（清屏）
- 输入模型：命令字符本地缓冲 + 预览回显（xterm 输入不自动回显），回车时清预览行、
  整行发送（shell 回显命令 + 输出）；退格删预览尾字符；控制字符（Ctrl+C 等）立即透传
- `@xterm/xterm` + `@xterm/addon-fit`（纯 JS，无编译问题）

## 已知限制

- Windows 上 kill 会话后 cmd.exe 子进程可能短暂残留（node-pty 只终止 PTY 主进程）；
  长驻命令建议在终端内 Ctrl+C 结束
- 终端进程不受 L1.5 沙箱约束（见上）；高危审批 + 审计为兜底防线
