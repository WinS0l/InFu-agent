//! 受限令牌（restricted token）——借鉴 OpenAI Codex windows-sandbox-rs token.rs
//!
//! 降级阶梯（对应非管理员环境下 CreateRestrictedToken 偶发 ERROR_INVALID_PARAMETER 的处理）：
//!   full    = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED | DISALLOW_VIRTUALIZATION
//!   reduced = 去 WRITE_RESTRICTED
//!   basic   = 去 LUA_TOKEN（仅禁用特权 + 禁止虚拟化）
//!   job-only = 全部失败，回退原令牌（仍受 Job Object 约束，由调用方处理）
//!
//! 语义说明（与 MSDN/Codex 一致）：
//!   - DISABLE_MAX_PRIVILEGE：禁用除 SeChangeNotifyPrivilege 外的全部特权（SeDebug 等全部没有）
//!   - LUA_TOKEN：模拟 UAC 过滤——Administrators 等提升组 SID 变为 deny-only（写系统目录被 OS 拒绝）
//!   - WRITE_RESTRICTED：写访问双检查（无 restricting SID 时无害，保留与 Codex 对齐）
//!   - DISALLOW_VIRTUALIZATION：禁止 UAC 虚拟化（否则写 Program Files 等会被悄悄重定向到 VirtualStore）
//!   - 不降完整性级别：低 IL 会挡住对工作区的正常写入，破坏 Agent 本职

use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LUID};
use windows_sys::Win32::Security::{
    AdjustTokenPrivileges, CreateRestrictedToken, DuplicateTokenEx, LookupPrivilegeValueW,
    LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, SECURITY_ATTRIBUTES, SecurityImpersonation,
    TOKEN_ACCESS_MASK, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ALL_ACCESS,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenPrimary,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// CreateRestrictedToken 标志位（winnt.h）
pub const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
pub const LUA_TOKEN: u32 = 0x04;
/// 保留常量作文档：实测 WRITE_RESTRICTED / DISALLOW_VIRTUALIZATION 会让 .NET（powershell）
/// 与 cygwin 系（Git for Windows）程序 DLL 初始化失败（0xC0000142 / TokenDefaultDacl 拒绝），
/// 故不使用——full 档 = DISABLE_MAX_PRIVILEGE | LUA_TOKEN（与 Codex 官方组合对齐的兼容子集）
#[allow(dead_code)]
pub const WRITE_RESTRICTED: u32 = 0x08;

pub fn last_error() -> u32 {
    unsafe { GetLastError() }
}

fn err(msg: &str) -> String {
    format!("{msg}（WinError {}）", last_error())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 打开当前进程令牌（可被 CreateRestrictedToken 降级的最小权限集）
pub fn open_current_token() -> Result<HANDLE, String> {
    let access: TOKEN_ACCESS_MASK =
        TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_PRIVILEGES;
    let mut h: HANDLE = ptr::null_mut();
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut h) };
    if ok == 0 {
        return Err(err("OpenProcessToken 失败"));
    }
    Ok(h)
}

fn create_restricted(base: HANDLE, flags: u32) -> Result<HANDLE, String> {
    let mut new_token: HANDLE = ptr::null_mut();
    let ok = unsafe {
        CreateRestrictedToken(
            base,
            flags,
            0,
            ptr::null(), // 不显式禁用 SID——LUA_TOKEN 已把提升组变 deny-only
            0,
            ptr::null(), // 不显式删特权——DISABLE_MAX_PRIVILEGE 全部禁用
            0,
            ptr::null(), // 无 capability restricting SID（v1 不做按目录授权）
            &mut new_token,
        )
    };
    if ok == 0 {
        return Err(err("CreateRestrictedToken 失败"));
    }
    Ok(new_token)
}

/// 显式启用 SeChangeNotifyPrivilege——DISABLE_MAX_PRIVILEGE 后唯一保留的特权，
/// 必须启用否则文件访问异常（Codex 同样显式 enable）
fn enable_change_notify(token: HANDLE) {
    let mut luid = LUID { LowPart: 0, HighPart: 0 };
    let name = wide("SeChangeNotifyPrivilege");
    let ok = unsafe { LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut luid) };
    if ok == 0 {
        return;
    }
    let mut tp = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    let _ = unsafe {
        AdjustTokenPrivileges(token, 0, &mut tp, 0, ptr::null_mut(), ptr::null_mut())
    };
}

/// 转为 primary 令牌（CreateProcessWithTokenW 需要 TOKEN_ASSIGN_PRIMARY 访问权）
fn duplicate_primary(token: HANDLE) -> Result<HANDLE, String> {
    let mut out: HANDLE = ptr::null_mut();
    let ok = unsafe {
        DuplicateTokenEx(
            token,
            TOKEN_ALL_ACCESS,
            ptr::null::<SECURITY_ATTRIBUTES>(),
            SecurityImpersonation,
            TokenPrimary,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(err("DuplicateTokenEx 失败"));
    }
    Ok(out)
}

/// 受限令牌构建结果
pub struct RestrictedToken {
    pub handle: HANDLE,
    /// full | reduced | basic
    pub level: &'static str,
}

/// 构建受限令牌（逐级降级）。全部失败返回 Err（调用方回退 job-only）
pub fn build_restricted(base: HANDLE) -> Result<RestrictedToken, String> {
    let attempts: &[(u32, &'static str)] = &[
        (DISABLE_MAX_PRIVILEGE | LUA_TOKEN, "full"),
        (DISABLE_MAX_PRIVILEGE, "reduced"),
    ];
    let mut last: Option<String> = None;
    for (flags, level) in attempts {
        match create_restricted(base, *flags) {
            Ok(t) => {
                enable_change_notify(t);
                // 受限令牌是全新令牌：补默认 DACL（防子进程 0xC0000142）
                crate::user::ensure_default_dacl(t);
                return duplicate_primary(t).map(|handle| RestrictedToken { handle, level });
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| "CreateRestrictedToken 全等级失败".to_string()))
}

pub fn close(h: HANDLE) {
    unsafe { CloseHandle(h) };
}
