//! 受限进程启动与输出捕获
//!
//! 借鉴 Codex process.rs，差异与理由：
//!   - 优先 CreateProcessWithTokenW（交互用户只需 SE_IMPERSONATE_NAME），
//!     ERROR_PRIVILEGE_NOT_HELD(1314) 时回退 CreateProcessAsUserW（需 SE_INCREASE_QUOTA）
//!   - M6 曾加入"提权调用者强制 AsUserW"分流（WithTokenW 产生 0xC0000142），
//!     随账号方案移除——该坑只影响专用账号令牌，当前用户受限令牌无此问题（M5 验证）
//!   - 命令统一写入临时 .cmd 文件再执行：绕开 CreateProcessWithTokenW 的
//!     1024 字符命令行限制与引号转义地狱
//!   - CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread：进程出生即入 Job，
//!     无"先跑后挂"窗口期（Codex tty=false 路径同款）
//!   - stdout/stderr 走匿名管道 + 读线程（防写满死锁），stdin 接 NUL（交互提示直接 EOF）

use std::collections::HashMap;
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_PRIVILEGE_NOT_HELD, GetLastError, HANDLE, HANDLE_FLAG_INHERIT,
    SetHandleInformation, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DeleteFileW, ReadFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessWithTokenW, GetExitCodeProcess, ResumeThread,
    TerminateProcess, WaitForSingleObject, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

/// 单通道输出捕获上限（与 Node exec 的 8MB maxBuffer 对齐）
pub const MAX_OUTPUT: usize = 8 * 1024 * 1024;

pub struct ProcessOutcome {
    /// 退出码（被终止/无法取得时为 None）
    pub code: Option<u32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    /// Job 挂载是否成功（仅信息，令牌限制始终生效）
    pub job_assigned: bool,
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 构造环境块（UTF-16 "K=V\0...\0"），空 map 时返回 None（继承父进程环境）
fn build_env_block(env: &HashMap<String, String>) -> Option<Vec<u16>> {
    if env.is_empty() {
        return None;
    }
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in env {
        block.extend(k.encode_utf16());
        block.push('=' as u16);
        block.extend(v.encode_utf16());
        block.push(0);
    }
    block.push(0);
    Some(block)
}

/// 写入临时 .cmd 文件
/// 编码策略（代码页无关，2026-08-12 修复）：
///   - 文件内容统一 UTF-8（无 BOM）
///   - 文件头 `@chcp 65001 >nul 2>nul` 把 cmd 解析代码页切到 UTF-8——无论外层控制台
///     代码页是 936（Git Bash / 中文系统）还是 65001（start-infu.bat 的 chcp 65001），
///     命令内容都按 UTF-8 解析，输出统一为 UTF-8 字节
///   - 2>nul 吞掉无控制台场景下 chcp 的报错噪音（曾出现"拒绝访问"污染 stderr）
/// dir：专用账号场景传入合成档案目录（真实用户 %TEMP% 对沙箱账号不可读）
fn write_cmd_file(command: &str, dir: Option<&str>) -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = match dir {
        Some(d) => std::path::Path::new(d).join(format!("infu-cmd-{}-{}.cmd", std::process::id(), nanos)),
        None => std::env::temp_dir().join(format!("infu-cmd-{}-{}.cmd", std::process::id(), nanos)),
    };
    let mut content: Vec<u8> = Vec::with_capacity(command.len() + 64);
    content.extend_from_slice(b"@echo off\r\n");
    content.extend_from_slice(b"@chcp 65001 >nul 2>nul\r\n");
    content.extend_from_slice(command.as_bytes());
    // 传播 ERRORLEVEL：cmd /c 跑批处理文件时退出码取最后一条命令，需显式退出
    // （命令本身以 exit 结束时不会执行到这里，无副作用）
    content.extend_from_slice(b"\r\nexit /b %errorlevel%\r\n");
    let path = file.to_string_lossy().into_owned();
    match std::fs::write(&file, content) {
        Ok(_) => Ok(path),
        Err(e) => Err(format!("写入临时命令文件失败: {e}")),
    }
}

fn delete_file(path: &str) {
    let w = wide(path);
    unsafe { DeleteFileW(w.as_ptr()) };
}

/// 匿名管道对（读端不可继承；写端标记为可继承供子进程使用）
struct PipePair {
    read: HANDLE,
    write: HANDLE,
}

fn create_pipe() -> Result<PipePair, String> {
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    let ok = unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) };
    if ok == 0 {
        return Err(format!("CreatePipe 失败（WinError {}）", last_error()));
    }
    // CreatePipe 两端共享同一属性（默认不可继承），这里单独把写端标记为可继承
    unsafe { SetHandleInformation(write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
    Ok(PipePair { read, write })
}

/// stdin 接 NUL（子进程读到 EOF，不会从交互式输入阻塞）
fn open_nul_stdin() -> Result<HANDLE, String> {
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let name = wide("NUL");
    let h = unsafe {
        CreateFileW(
            name.as_ptr(),
            0x8000_0000, // GENERIC_READ
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &mut sa,
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if h == std::u32::MAX as isize as HANDLE {
        return Err(format!("打开 NUL 失败（WinError {}）", last_error()));
    }
    Ok(h)
}

/// 阻塞读管道直到 EOF 或达到上限（防写满死锁），返回读到的字节。
/// HANDLE 非 Send（裸指针），用包装类型跨线程传递。
#[derive(Clone, Copy)]
struct ReadHandle(HANDLE);
unsafe impl Send for ReadHandle {}

fn read_pipe(handle: ReadHandle, mut buf: Vec<u8>) -> Vec<u8> {
    let mut chunk = [0u8; 8192];
    loop {
        let mut n: u32 = 0;
        let ok = unsafe {
            ReadFile(
                handle.0,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut n,
                ptr::null_mut(),
            )
        };
        if ok == 0 || n == 0 {
            break; // EOF / 管道破裂（子进程死后 write 端已关闭）
        }
        if buf.len() >= MAX_OUTPUT {
            break;
        }
        let take = (n as usize).min(MAX_OUTPUT - buf.len());
        buf.extend_from_slice(&chunk[..take]);
    }
    buf
}

/// 输出解码：先按 UTF-8 严格解码（Node/tsx 等外部程序输出 UTF-8），
/// 失败则回退 GBK（cmd 内置命令按代码页 936 输出）；纯 ASCII 两种解码等价。
fn decode_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
    }
}

/// 组装 cmd 命令行：cmd.exe /d /s /c "<临时文件>"（System32 全路径，受限令牌下不可被替换）
fn build_cmdline(cmd_file: &str) -> Vec<u16> {
    let mut cmdline = format!("cmd.exe /d /s /c \"{cmd_file}\"");
    cmdline.push('\0');
    cmdline.encode_utf16().collect()
}

/// 用指定令牌创建进程。
/// 关键（2026-08-12 实测）：**提权调用者必须用 CreateProcessAsUserW**——
/// CreateProcessWithTokenW 从提权进程创建（无论何种令牌）会让子进程
/// DLL 初始化失败（0xC0000142，STATUS_DLL_INIT_FAILED）。
/// 非提权调用者无 SeIncreaseQuota/SeAssignPrimaryToken，只能 WithTokenW
/// （M5 验证可用），1314 时回退 AsUserW。
fn create_with_token(
    token: HANDLE,
    cmdline: &[u16],
    cwd: &str,
    env_block: Option<&[u16]>,
    startup: &mut STARTUPINFOW,
    flags: u32,
) -> Result<PROCESS_INFORMATION, u32> {
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let cwd_w = wide(cwd);
    let env_ptr = env_block.map_or(ptr::null(), |b| b.as_ptr() as *const _);

    // 1) CreateProcessWithTokenW（交互用户只需 SE_IMPERSONATE_NAME，非 LOGON 场景不加载 profile）
    let ok = unsafe {
        CreateProcessWithTokenW(
            token,
            0,
            ptr::null(),
            cmdline.as_ptr() as *mut u16,
            flags,
            env_ptr,
            cwd_w.as_ptr(),
            startup,
            &mut pi,
        )
    };
    if ok != 0 {
        return Ok(pi);
    }
    let err = last_error();
    if err != ERROR_PRIVILEGE_NOT_HELD {
        return Err(err);
    }

    // 2) 回退 CreateProcessAsUserW（管理员持有 SE_INCREASE_QUOTA 时可用）
    if create_as_user(&mut pi, token, cmdline, flags, env_ptr, &cwd_w, startup) != 0 {
        Ok(pi)
    } else {
        Err(last_error())
    }
}

/// CreateProcessAsUserW 封装（提权调用者的首选路径；非提权作为 WithTokenW 的回退）
#[allow(clippy::too_many_arguments)]
fn create_as_user(
    pi: &mut PROCESS_INFORMATION,
    token: HANDLE,
    cmdline: &[u16],
    flags: u32,
    env_ptr: *const core::ffi::c_void,
    cwd_w: &[u16],
    startup: &mut STARTUPINFOW,
) -> i32 {
    unsafe {
        CreateProcessAsUserW(
            token,
            ptr::null(),
            cmdline.as_ptr() as *mut u16,
            ptr::null(),
            ptr::null(),
            1, // bInheritHandles（继承 std handles）
            flags,
            env_ptr,
            cwd_w.as_ptr(),
            startup,
            pi,
        )
    }
}

/// 主流程：受限令牌 + Job Object 启动命令并等待完成
/// cmd_dir：专用账号场景的 .cmd 落盘目录（None = 系统临时目录）
pub fn run_restricted_process(
    token: HANDLE,
    command: &str,
    cwd: &str,
    env: &HashMap<String, String>,
    timeout_ms: u32,
    job: &crate::job::Job,
    cmd_dir: Option<&str>,
) -> ProcessOutcome {
    let mut outcome = ProcessOutcome {
        code: None,
        timed_out: false,
        stdout: String::new(),
        stderr: String::new(),
        job_assigned: false,
    };

    // 临时命令文件
    let cmd_file = match write_cmd_file(command, cmd_dir) {
        Ok(f) => f,
        Err(e) => {
            outcome.stdout = e;
            return outcome;
        }
    };

    // 管道与启动信息
    // v4.0 审计修复（L1）：部分创建失败时关闭已成功创建的句柄——原实现走统一 `_` 分支
    // 只删了 cmd 文件，已创建的管道读/写端与 NUL 句柄全部泄漏（每次 2-6 个句柄，
    // 长驻服务低频失败路径累积）
    let (out_pipe, err_pipe, nul_stdin) = match (create_pipe(), create_pipe(), open_nul_stdin()) {
        (Ok(o), Ok(e), Ok(n)) => (o, e, n),
        (o, e, n) => {
            for p in [o, e] {
                if let Ok(p) = p {
                    unsafe {
                        CloseHandle(p.read);
                        CloseHandle(p.write);
                    }
                }
            }
            if let Ok(n) = n {
                unsafe { CloseHandle(n) };
            }
            outcome.stdout = "创建管道失败".to_string();
            delete_file(&cmd_file);
            return outcome;
        }
    };

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul_stdin;
    si.hStdOutput = out_pipe.write;
    si.hStdError = err_pipe.write;

    let cmdline = build_cmdline(&cmd_file);
    let env_block = build_env_block(env);
    let flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;

    let pi = match create_with_token(token, &cmdline, cwd, env_block.as_deref(), &mut si, flags) {
        Ok(pi) => pi,
        Err(code) => {
            outcome.stdout = format!("受限进程创建失败（WinError {code}）");
            unsafe {
                CloseHandle(out_pipe.read);
                CloseHandle(out_pipe.write);
                CloseHandle(err_pipe.read);
                CloseHandle(err_pipe.write);
                CloseHandle(nul_stdin);
            }
            delete_file(&cmd_file);
            return outcome;
        }
    };

    // 出生即入 Job（挂起态无竞态窗口）；失败仅记录——令牌限制依然生效
    outcome.job_assigned = crate::job::assign(job.handle, pi.hProcess);
    unsafe { ResumeThread(pi.hThread) };

    // 读线程（管道写满前开始读，防死锁）；结果经 channel 回传（v3.6：不用 join——
    // 子进程 spawn 出继承管道写句柄的后台进程（如 `start /b`）时读线程永不 EOF，
    // 裸 join 永久阻塞 → N-API promise 永不 resolve（spawn_blocking 线程泄漏））
    let (tx_out, rx_out) = std::sync::mpsc::channel::<Vec<u8>>();
    let (tx_err, rx_err) = std::sync::mpsc::channel::<Vec<u8>>();
    let _t_out = std::thread::spawn({
        let h = ReadHandle(out_pipe.read);
        move || {
            let buf = read_pipe(h, Vec::new());
            let _ = tx_out.send(buf);
        }
    });
    let _t_err = std::thread::spawn({
        let h = ReadHandle(err_pipe.read);
        move || {
            let buf = read_pipe(h, Vec::new());
            let _ = tx_err.send(buf);
        }
    });

    // 等待完成 / 超时杀整树
    let wait = unsafe { WaitForSingleObject(pi.hProcess, timeout_ms.max(1)) };
    if wait == WAIT_TIMEOUT {
        outcome.timed_out = true;
        if !crate::job::terminate(job.handle) {
            unsafe { TerminateProcess(pi.hProcess, 1) };
        }
        unsafe { WaitForSingleObject(pi.hProcess, 5000) };
    } else if wait == WAIT_FAILED {
        outcome.stdout = format!("WaitForSingleObject 失败（WinError {}）", last_error());
    } else if wait == WAIT_OBJECT_0 {
        let mut code: u32 = 0;
        if unsafe { GetExitCodeProcess(pi.hProcess, &mut code) } != 0 {
            outcome.code = Some(code);
        }
    }

    // 关闭写端 → 读线程 EOF
    unsafe {
        CloseHandle(out_pipe.write);
        CloseHandle(err_pipe.write);
    }
    // v3.6：汇合带超时——读线程未在 30s 内结束（后台进程继承管道写句柄）→ 强制关闭
    // 读端中断阻塞中的 ReadFile 并放弃该通道结果（防 N-API 调用永久挂起；线程本身随
    // 管道关闭/进程退出自然结束，不阻塞调用方）。返回是否已关闭读端（收尾防 double-close）
    let recv_bounded = |rx: std::sync::mpsc::Receiver<Vec<u8>>, read_h: HANDLE| -> (Vec<u8>, bool) {
        match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(b) => (b, false),
            Err(_) => {
                unsafe { CloseHandle(read_h) }; // 中断阻塞中的 ReadFile
                (Vec::new(), true)
            }
        }
    };
    let (out_buf, out_closed) = recv_bounded(rx_out, out_pipe.read);
    let (err_buf, err_closed) = recv_bounded(rx_err, err_pipe.read);
    // 读线程句柄已随 recv_bounded 的 CloseHandle / 正常 EOF 释放；线程本身 detached

    outcome.stdout = decode_output(&out_buf);
    outcome.stderr = decode_output(&err_buf);

    // 收尾
    unsafe {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        if !out_closed { CloseHandle(out_pipe.read); }
        if !err_closed { CloseHandle(err_pipe.read); }
        CloseHandle(nul_stdin);
    }
    delete_file(&cmd_file);
    outcome
}
