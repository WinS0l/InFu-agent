//! InFu Windows 硬沙箱原生模块（restricted tokens + job objects + 网络出站控制）
//! napi 导出层：非 Windows 平台编译为不可用桩（available()=false）

#[cfg(target_os = "windows")]
mod appc;
#[cfg(target_os = "windows")]
mod cred;
#[cfg(target_os = "windows")]
mod job;
#[cfg(target_os = "windows")]
mod process;
#[cfg(target_os = "windows")]
mod runner;
#[cfg(target_os = "windows")]
mod state;
#[cfg(target_os = "windows")]
mod token;
#[cfg(target_os = "windows")]
mod user;

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
    /// 沙箱账号："offline"（断网）/ "online"（联网）；不传 = 当前用户受限令牌
    pub sandbox_user: Option<String>,
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
    /// offline | online | none（none = 未用专用账号）
    pub net: String,
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
        sandbox_user: opts.sandbox_user,
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
            net: r.net,
            error: r.error,
        }
    }
}

// ===================== 网络出站控制（M6）=====================

#[napi(object)]
#[cfg(target_os = "windows")]
pub struct NetSetupResult {
    pub offline_user: String,
    pub online_user: String,
    pub offline_sid: String,
    /// setup 时授权的工具目录（Read+Execute）
    pub tool_dirs: Vec<String>,
    pub created_at: String,
}

#[napi(object)]
#[cfg(target_os = "windows")]
pub struct NetStatusResult {
    /// 状态文件存在（账号+规则已配置过）
    pub configured: bool,
    /// 当前进程是否提权
    pub elevated: bool,
    /// offline 账号登录测试通过（账号存在 + 密文可解 + 密码正确）
    pub offline_ok: bool,
    pub online_ok: bool,
    /// WFP 双栈拦截规则已安装（非提权下查询受限时为 false）
    pub rules_ok: bool,
    pub error: Option<String>,
}

/// 当前进程是否管理员提权（UAC TokenElevation）
#[napi]
#[cfg(target_os = "windows")]
pub fn net_is_elevated() -> bool {
    user::is_elevated()
}

/// 安装网络出站控制：创建两个沙箱账号 + AppContainer 断网档案 + 写状态文件 + 授权工具目录。
/// 需提权（`infu sandbox-net setup` 通过 UAC 触发）。幂等（档案先删后建、账号重置密码）。
#[napi]
#[cfg(target_os = "windows")]
pub fn net_setup() -> napi::Result<NetSetupResult> {
    let err = |e: String| napi::Error::from_reason(e);

    if !user::is_elevated() {
        return Err(err(
            "需要管理员权限：请通过 `infu sandbox-net setup` 触发 UAC 提权后重试".into(),
        ));
    }

    // 1) 账号（已存在则重置密码）+ 批处理登录权（LogonUserW(BATCH) 必需）
    let offline_pw = user::create_or_reset_account(user::OFFLINE_USER).map_err(err)?;
    let online_pw = user::create_or_reset_account(user::ONLINE_USER).map_err(err)?;
    user::grant_batch_logon(user::OFFLINE_USER).map_err(err)?;
    user::grant_batch_logon(user::ONLINE_USER).map_err(err)?;
    // 当前用户特权由 PowerShell P/Invoke 路径授予（grant-rights.ps1，见 cli.ts setup 分支）

    // 2) AppContainer 断网档案（离线账号的 OS 级断网强制）
    let package_sid = appc::create_profile().map_err(err)?;

    // 3) 状态文件（DPAPI 密文 + 包 SID）
    let protect = |pw: &str| {
        cred::protect(pw.as_bytes())
            .map(|b| state::b64_encode(&b))
            .map_err(err)
    };
    let state = state::SandboxNetState {
        version: 1,
        offline: state::AccountCreds {
            name: user::OFFLINE_USER.into(),
            password_dpapi: protect(&offline_pw)?,
        },
        online: state::AccountCreds {
            name: user::ONLINE_USER.into(),
            password_dpapi: protect(&online_pw)?,
        },
        package_sid: state::b64_encode(&package_sid),
        created_at: now_iso(),
    };
    state::save_state(&state).map_err(err)?;

    // 4) 工具目录授权（PATH 里的可执行文件目录，两账号 Read+Execute）
    let online_sid = user::lookup_user_sid(user::ONLINE_USER).map_err(err)?;
    let sids = vec![package_sid.clone(), online_sid];
    let tool_dirs = user::grant_tool_dirs(&sids).map_err(err)?;

    Ok(NetSetupResult {
        offline_user: user::OFFLINE_USER.into(),
        online_user: user::ONLINE_USER.into(),
        offline_sid: user::sid_string(&user::lookup_user_sid(user::OFFLINE_USER).map_err(err)?)
            .map_err(err)?,
        tool_dirs,
        created_at: now_iso(),
    })
}

/// 移除网络出站控制：删档案 + 删账号 + 删状态文件。需提权。幂等。
#[napi]
#[cfg(target_os = "windows")]
pub fn net_remove() -> napi::Result<String> {
    let err = |e: String| napi::Error::from_reason(e);
    if !user::is_elevated() {
        return Err(err(
            "需要管理员权限：请通过 `infu sandbox-net remove` 触发 UAC 提权后重试".into(),
        ));
    }
    appc::delete_profile().map_err(err)?;
    user::delete_account(user::OFFLINE_USER).map_err(err)?;
    user::delete_account(user::ONLINE_USER).map_err(err)?;
    state::delete_state().map_err(err)?;
    Ok(format!(
        "已移除：AppContainer 档案 + 账号（{}/{}）+ 状态文件",
        user::OFFLINE_USER,
        user::ONLINE_USER
    ))
}

/// 查询网络出站控制状态（非提权可调用，如实报告各环节）
#[napi]
#[cfg(target_os = "windows")]
pub fn net_status() -> NetStatusResult {
    let elevated = user::is_elevated();
    let state = state::load_state();
    let (configured, offline_ok, online_ok, profile_ok, detail) = match state {
        Ok(Some(s)) => {
            let pkg_sid = state::b64_decode(&s.package_sid).unwrap_or_default();
            let offline_ok = match user::logon_sandbox_user("offline") {
                Ok(t) => {
                    let r = appc::create_lowbox(t, &pkg_sid);
                    crate::token::close(t);
                    match r {
                        Ok(_) => (true, String::new()),
                        Err(e) => (false, format!("离线低盒令牌创建失败: {e}")),
                    }
                }
                Err(e) => (false, format!("离线账号登录失败: {e}")),
            };
            let online_ok = user::logon_sandbox_user("online").is_ok();
            (
                true,
                offline_ok.0,
                online_ok,
                appc::profile_ok(&pkg_sid),
                if offline_ok.0 { String::new() } else { offline_ok.1 },
            )
        }
        Ok(None) => (false, false, false, false, String::new()),
        Err(e) => {
            return NetStatusResult {
                configured: false,
                elevated,
                offline_ok: false,
                online_ok: false,
                rules_ok: false,
                error: Some(e),
            }
        }
    };
    NetStatusResult {
        configured,
        elevated,
        offline_ok,
        online_ok,
        rules_ok: profile_ok,
        error: if detail.is_empty() { None } else { Some(detail) },
    }
}

/// 授权沙箱账号访问工作区：root Modify（继承）+ 祖先路径 Traverse + Low 完整性级别。
/// 授权主体含 AppContainer 包 SID（AppContainer 进程按包 SID 做路径访问检查，
/// 仅授用户 SID 会报 WinError 267）。非提权可调用（当前用户拥有目录）。返回授权明细。
#[napi]
#[cfg(target_os = "windows")]
pub fn net_grant_dir(path: String) -> napi::Result<Vec<String>> {
    let err = |e: String| napi::Error::from_reason(e);
    if !std::path::Path::new(&path).exists() {
        return Err(err(format!("路径不存在: {path}")));
    }
    let offline_sid = user::lookup_user_sid(user::OFFLINE_USER).map_err(err)?;
    let online_sid = user::lookup_user_sid(user::ONLINE_USER).map_err(err)?;
    // 包 SID（来自状态文件；缺失时跳过——纯用户授权也能覆盖在线账号）
    let mut sids = vec![offline_sid, online_sid];
    if let Ok(Some(s)) = state::load_state() {
        if let Ok(pkg) = state::b64_decode(&s.package_sid) {
            sids.push(pkg);
        }
    }
    let mut granted = user::grant_workspace(&path, &sids).map_err(err)?;
    // Low 完整性：Low IL 的 AppContainer 进程可写工作区（icacls 是系统工具，稳定）
    appc::set_dir_low_integrity(&path).map_err(err)?;
    granted.push(format!("{path}（Low 完整性级别）"));
    Ok(granted)
}

fn now_iso() -> String {
    // 简单的本地时间 ISO（不引 chrono；仅用于状态元数据）
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02} (unix {secs})")
}

/// 天数 → 公历（Howard Hinnant 算法）
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as i64;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ===================== 非 Windows 占位 =====================

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
        net: "none".into(),
        error: Some("InFu 硬沙箱仅支持 Windows".into()),
    })
}

#[napi]
#[cfg(not(target_os = "windows"))]
pub fn net_is_elevated() -> bool {
    false
}

#[napi]
#[cfg(not(target_os = "windows"))]
pub fn net_setup() -> Result<serde_json::Value, Error> {
    Err(napi::Error::from_reason(
        "InFu 网络出站控制仅支持 Windows".into(),
    ))
}

#[napi]
#[cfg(not(target_os = "windows"))]
pub fn net_remove() -> Result<String, Error> {
    Err(napi::Error::from_reason(
        "InFu 网络出站控制仅支持 Windows".into(),
    ))
}

#[napi]
#[cfg(not(target_os = "windows"))]
pub fn net_status() -> serde_json::Value {
    serde_json::json!({ "configured": false, "elevated": false, "offlineOk": false, "onlineOk": false, "rulesOk": false, "error": "InFu 网络出站控制仅支持 Windows" })
}

#[napi]
#[cfg(not(target_os = "windows"))]
pub fn net_grant_dir(_path: String) -> Result<Vec<String>, Error> {
    Err(napi::Error::from_reason(
        "InFu 网络出站控制仅支持 Windows".into(),
    ))
}
