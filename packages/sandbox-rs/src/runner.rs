//! 编排层：令牌 → Job → 受限进程 的完整链路与降级
//!
//! M6 扩展：`sandbox_user`（沙箱专用账号）分支——
//!   - 令牌来源改为 LogonUserW（offline/online 账号，凭据来自 DPAPI 密文）
//!   - 子进程环境重定向到工作区内的合成档案目录（.infu-sandbox-profile），
//!     不碰真实用户档案（避免 Codex 的 ACL 泛滥/档案污染问题）
//!   - 临时 .cmd 文件写入合成档案目录（真实用户 %TEMP% 对沙箱账号不可读）

use std::collections::HashMap;

use windows_sys::Win32::Foundation::HANDLE;

use crate::process::{run_restricted_process, ProcessOutcome};
use crate::token::{build_restricted, open_current_token};

/// 默认资源上限（与 Docker 档 --memory 2g / --pids-limit 256 对齐的本地等价物）
pub const DEFAULT_PROCESS_MEMORY_MB: u32 = 4096;
pub const DEFAULT_JOB_MEMORY_MB: u32 = 8192;
pub const DEFAULT_ACTIVE_PROCESS_LIMIT: u32 = 256;

/// 合成档案目录名（工作区内）
pub const PROFILE_DIR_NAME: &str = ".infu-sandbox-profile";

/// 合成档案里重定向的环境变量（工具按这些路径读写缓存/配置）
const PROFILE_ENV_KEYS: [&str; 6] = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
];

pub struct RunOptions {
    pub command: String,
    pub cwd: String,
    pub timeout_ms: u32,
    pub env: HashMap<String, String>,
    pub process_memory_mb: u32,
    pub job_memory_mb: u32,
    pub active_process_limit: u32,
    /// 沙箱账号类型："offline"（断网）/ "online"（联网）；None = 当前用户受限令牌
    pub sandbox_user: Option<String>,
}

pub struct RunResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// full | reduced | basic | job-only
    pub level: String,
    /// offline | online | none（none = 未用专用账号）
    pub net: String,
    pub error: Option<String>,
}

fn err_result(error: String) -> RunResult {
    RunResult {
        ok: false,
        code: -1,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: false,
        level: "none".into(),
        net: "none".into(),
        error: Some(error),
    }
}

fn outcome_to_result(outcome: ProcessOutcome, level: &str, job_note: &str) -> RunResult {
    let stderr = if job_note.is_empty() {
        outcome.stderr
    } else if outcome.stderr.is_empty() {
        job_note.to_string()
    } else {
        format!("{}\n{}", outcome.stderr, job_note)
    };
    RunResult {
        ok: outcome.code.is_some(),
        code: outcome.code.map_or(-1, |c| c as i32),
        stdout: outcome.stdout,
        stderr,
        timed_out: outcome.timed_out,
        level: level.into(),
        net: "none".into(),
        error: None,
    }
}

/// 受限执行完整链路
pub fn run(opts: &RunOptions) -> RunResult {
    // 0) 令牌来源：沙箱专用账号（sandbox-net 已配置）或当前用户
    //     INFU_SANDBOX_CURRENT_USER=1：忽略 sandbox_user 用当前用户（调试对照）
    let (base, sandbox_kind) = if std::env::var("INFU_SANDBOX_CURRENT_USER").is_ok() {
        match open_current_token() {
            Ok(h) => (h, None),
            Err(e) => return err_result(e),
        }
    } else {
        match opts.sandbox_user.as_deref() {
            Some(kind) => match crate::user::logon_sandbox_user(kind) {
                Ok(t) => (t, Some(kind.to_string())),
                Err(e) => return err_result(e),
            },
            None => match open_current_token() {
                Ok(h) => (h, None),
                Err(e) => return err_result(e),
            },
        }
    };

    // 1) Job Object（无论令牌等级如何都创建——内存/进程数/关闭即杀始终生效）
    //     INFU_SANDBOX_SKIP_JOB=1：跳过 Job（调试用）
    let job = if std::env::var("INFU_SANDBOX_SKIP_JOB").is_ok() {
        None
    } else {
        match crate::job::create(
        opts.process_memory_mb,
        opts.job_memory_mb,
        opts.active_process_limit,
    ) {
            Ok(j) => Some(j),
            Err(e) => {
                crate::token::close(base);
                return err_result(e);
            }
        }
    };

    // 2) 合成档案目录 + 环境重定向（仅专用账号）
    let (env, cmd_dir) = match sandbox_kind.as_deref() {
        Some(_) => {
            let profile = std::path::Path::new(&opts.cwd).join(PROFILE_DIR_NAME);
            if let Err(e) = std::fs::create_dir_all(&profile) {
                crate::token::close(base);
                if let Some(j) = &job { crate::job::close(j.handle); }
                return err_result(format!("创建合成档案目录失败（{e}）——工作区需先授权沙箱账号（infu sandbox-net grant）"));
            }
            let profile_str = profile.to_string_lossy().into_owned();
            let mut env = opts.env.clone();
            if std::env::var("INFU_SANDBOX_NO_PROFILE").is_err() {
                for k in PROFILE_ENV_KEYS {
                    env.insert(k.to_string(), profile_str.clone());
                }
            }
            (env, Some(profile_str))
        }
        None => (opts.env.clone(), None),
    };

    // 3) 受限令牌（逐级降级；全失败则回退原令牌 → job-only）
    //     INFU_SANDBOX_RAW_TOKEN=1：跳过受限管线（调试用——定位 DLL 初始化失败）
    let (token_handle, level) = if std::env::var("INFU_SANDBOX_RAW_TOKEN").is_ok() {
        (base, "raw".to_string())
    } else {
        match build_restricted(base) {
            Ok(t) => (t.handle, t.level.to_string()),
            Err(_) => (base, "job-only".to_string()),
        }
    };

    // 3b) 离线账号 → AppContainer 低盒包裹（无网络能力 = 出站全断，OS 强制）
    //     online 账号保持普通受限令牌（联网）；低盒令牌句柄随 token_handle 一并清理
    let mut lowbox: Option<HANDLE> = None;
    if sandbox_kind.as_deref() == Some("offline") {
        match crate::appc::lowbox_from_state(token_handle) {
            Ok(lb) => lowbox = Some(lb),
            Err(e) => {
                crate::token::close(token_handle);
                if token_handle != base {
                    crate::token::close(base);
                }
                if let Some(j) = &job { crate::job::close(j.handle); }
                return err_result(e);
            }
        }
    }
    let exec_token = lowbox.unwrap_or(token_handle);

    // 4) 受限进程执行
    let job_ref = job.as_ref().unwrap();
    let outcome = run_restricted_process(
        exec_token,
        &opts.command,
        &opts.cwd,
        &env,
        opts.timeout_ms,
        job_ref,
        cmd_dir.as_deref(),
    );

    // Job 挂载失败说明（照抄 Codex：仅警告不阻断）
    let job_note = if outcome.job_assigned {
        String::new()
    } else {
        "警告：进程未能挂入 Job Object（嵌套 Job 限制），资源约束降级——令牌限制仍生效".to_string()
    };

    let mut result = outcome_to_result(outcome, &level, &job_note);
    result.net = sandbox_kind.unwrap_or_else(|| "none".into());

    // 清理
    if let Some(j) = job {
        crate::job::close(j.handle);
    }
    if let Some(lb) = lowbox {
        crate::token::close(lb);
    }
    crate::token::close(token_handle);
    if token_handle != base {
        crate::token::close(base);
    }
    result
}
