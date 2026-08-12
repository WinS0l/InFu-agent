//! InFu Windows 硬沙箱原生模块（restricted tokens + job objects）
//! napi 导出层：非 Windows 平台编译为不可用桩（available()=false）

mod job;
mod process;
mod runner;
mod token;

use std::collections::HashMap;

use napi_derive::napi;

#[napi(object)]
#[cfg(target_os = "windows")]
pub struct RunOptions {
    pub cwd: String,
    pub timeout_ms: u32,
    #[napi(ts_type = "Record<string, string>")]
    pub env: Option<HashMap<String, String>>,
    pub process_memory_mb: Option<u32>,
    pub job_memory_mb: Option<u32>,
    pub active_process_limit: Option<u32>,
}

#[napi(object)]
pub struct RunResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// full | reduced | basic | job-only | none
    pub level: String,
    pub error: Option<String>,
}

/// 当前平台是否支持受限执行（Windows 且模块加载成功）
#[napi]
pub fn available() -> bool {
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 以受限令牌 + Job Object 执行命令（异步，后台线程）
#[napi]
#[cfg(target_os = "windows")]
pub async fn run_restricted(command: String, opts: RunOptions) -> napi::Result<RunResult> {
    let ro = runner::RunOptions {
        command,
        cwd: opts.cwd,
        timeout_ms: opts.timeout_ms,
        env: opts.env.unwrap_or_default(),
        process_memory_mb: opts
            .process_memory_mb
            .unwrap_or(runner::DEFAULT_PROCESS_MEMORY_MB),
        job_memory_mb: opts.job_memory_mb.unwrap_or(runner::DEFAULT_JOB_MEMORY_MB),
        active_process_limit: opts
            .active_process_limit
            .unwrap_or(runner::DEFAULT_ACTIVE_PROCESS_LIMIT),
    };
    let result = tokio::task::spawn_blocking(move || runner::run(&ro)).await;
    match result {
        Ok(r) => Ok(r.into()),
        Err(e) => Err(napi::Error::from_reason(format!("沙箱任务线程失败: {e}"))),
    }
}

impl From<runner::RunResult> for RunResult {
    fn from(r: runner::RunResult) -> Self {
        RunResult {
            ok: r.ok,
            code: r.code,
            stdout: r.stdout,
            stderr: r.stderr,
            timed_out: r.timed_out,
            level: r.level,
            error: r.error,
        }
    }
}

/// 非 Windows 平台的占位实现（模块可加载，但不可用）
#[napi]
#[cfg(not(target_os = "windows"))]
pub async fn run_restricted(_command: String, _opts: serde_json::Value) -> Result<RunResult, Error> {
    Ok(RunResult {
        ok: false,
        code: -1,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: false,
        level: "unsupported".into(),
        error: Some("InFu 硬沙箱仅支持 Windows".into()),
    })
}
