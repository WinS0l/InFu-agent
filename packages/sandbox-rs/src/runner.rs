//! 编排层：令牌 → Job → 受限进程 的完整链路与降级
//!
//! M6 结论（2026-08-12）：网络出站控制在当前机器上无 OS 级实现路线
//! （WFP/AppContainer/专用账号/SYSTEM 辅助均被加固环境封死，见 ROADMAP），
//! 收尾为应用层命令策略（agent 侧 net-policy.ts）。本模块保持 M5 形态：
//! 当前用户受限令牌 + Job Object。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::Foundation::HANDLE;

use crate::process::{run_restricted_process, ProcessOutcome};
use crate::token::{build_restricted, open_current_token};

/// 审计修复（H-2）：运行注册表——run_id → Job 句柄（存 usize 数值：
/// HANDLE 裸指针非 Send/Sync 不能入 static Mutex；句柄本质是整数，terminate 时转回）。
/// abort_run 通过 Job terminate 杀整棵进程树（含 `start /b` 分离进程），
/// 阻塞中的 WaitForSingleObject 随进程退出返回，无需轮询。
/// 只在 run 生命周期内注册（job 创建后 → 收尾 close 前），abort 在窗口外
/// 未命中返回 false（幂等无害）。
static RUN_REGISTRY: OnceLock<Mutex<HashMap<u32, usize>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u32, usize>> {
    RUN_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_run(run_id: Option<u32>, handle: HANDLE) {
    if let Some(id) = run_id {
        if let Ok(mut m) = registry().lock() {
            m.insert(id, handle as usize);
        }
    }
}

fn unregister_run(run_id: Option<u32>) {
    if let Some(id) = run_id {
        if let Ok(mut m) = registry().lock() {
            m.remove(&id);
        }
    }
}

/// 终止指定运行（杀整树）；未注册/已结束返回 false
pub fn abort_run(run_id: u32) -> bool {
    // Keep the registry lock while terminating. Otherwise run completion can
    // close this handle and Windows may reuse its numeric value for another Job.
    match registry().lock() {
        Ok(m) => m
            .get(&run_id)
            .copied()
            .map(|h| crate::job::terminate(h as HANDLE))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 默认资源上限（与 Docker 档 --memory 2g / --pids-limit 256 对齐的本地等价物）
pub const DEFAULT_PROCESS_MEMORY_MB: u32 = 4096;
pub const DEFAULT_JOB_MEMORY_MB: u32 = 8192;
pub const DEFAULT_ACTIVE_PROCESS_LIMIT: u32 = 256;

pub struct RunOptions {
    pub command: String,
    pub cwd: String,
    pub timeout_ms: u32,
    pub env: HashMap<String, String>,
    pub process_memory_mb: u32,
    pub job_memory_mb: u32,
    pub active_process_limit: u32,
    pub run_id: Option<u32>,
}

pub struct RunResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// full | reduced | basic | job-only
    pub level: String,
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
        error: None,
    }
}

/// 受限执行完整链路
pub fn run(opts: &RunOptions) -> RunResult {
    // 0) 令牌来源：当前用户
    let base = match open_current_token() {
        Ok(h) => h,
        Err(e) => return err_result(e),
    };

    // 1) Job Object（无论令牌等级如何都创建——内存/进程数/关闭即杀始终生效）
    let job = match crate::job::create(
        opts.process_memory_mb,
        opts.job_memory_mb,
        opts.active_process_limit,
    ) {
        Ok(j) => Some(j),
        Err(e) => {
            crate::token::close(base);
            return err_result(e);
        }
    };

    // 审计修复（H-2）：注册运行（abort_run 通过 Job terminate 杀整树）
    register_run(opts.run_id, job.as_ref().unwrap().handle);

    // 2) 受限令牌（逐级降级；全失败则回退原令牌 → job-only）
    let (token_handle, level) = match build_restricted(base) {
        Ok(t) => (t.handle, t.level.to_string()),
        Err(_) => (base, "job-only".to_string()),
    };

    // 3) 受限进程执行
    let job_ref = job.as_ref().unwrap();
    let outcome = run_restricted_process(
        token_handle,
        &opts.command,
        &opts.cwd,
        &opts.env,
        opts.timeout_ms,
        job_ref,
        None,
    );

    // Job 挂载失败说明（照抄 Codex：仅警告不阻断）
    let job_note = if outcome.job_assigned {
        String::new()
    } else {
        "警告：进程未能挂入 Job Object（嵌套 Job 限制），资源约束降级——令牌限制仍生效".to_string()
    };

    let result = outcome_to_result(outcome, &level, &job_note);

    // 清理
    if let Some(j) = job {
        // 审计修复（H-2）：先注销再关句柄（abort 窗口外未命中 → false，无害）
        unregister_run(opts.run_id);
        crate::job::close(j.handle);
    }
    crate::token::close(token_handle);
    if token_handle != base {
        crate::token::close(base);
    }
    result
}
