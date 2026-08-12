//! AppContainer 网络隔离（M6 断网强制层）
//!
//! 背景：Windows 11 25H2（build 26200）的 WFP ALE_USER_ID 与 New-NetFirewallRule
//! -LocalUser 均被引擎拒绝（实测 12 种值编码全部 FWP_E_TYPE_MISMATCH / 参数无效），
//! 而 AppContainer 的"无网络能力 = 出站全断（含 DNS）"由 OS 自带的过滤器强制
//! （ALE_PACKAGE_ID 条件，实测引擎接受）——这是本机唯一可用的 OS 级按进程断网机制。
//!
//! 实现：
//!   - setup：创建 AppContainer 档案（无任何能力 → 包进程天然断网）
//!   - 离线执行：CreateAppContainerToken 把受限令牌包成低盒令牌（用户 SID 保留，
//!     现有工作区/工具目录授权继续生效；regular AppContainer 的用户 SID 参与访问检查）
//!   - 工作区标 Low 完整性级别（Low IL 进程可写；Medium 宿主读写不受影响）

use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
};
use windows_sys::Win32::Security::{CopySid, GetLengthSid, PSID, SID_AND_ATTRIBUTES};

/// AppContainer 档案名（每个 Windows 用户一份）
pub const PROFILE_NAME: &str = "InFuSandbox";

// NtCreateLowBoxToken（ntdll，未文档化但稳定——Chrome 等所有 AppContainer 沙箱都用它；
// SDK 无公开的"创建低盒令牌"API）。返回 NTSTATUS，0 = STATUS_SUCCESS。
#[link(name = "ntdll")]
extern "system" {
    fn NtCreateLowBoxToken(
        token_handle: *mut HANDLE,
        existing_token_handle: HANDLE,
        access_mask: u32,
        object_attribute: *const core::ffi::c_void,
        app_container_sid: PSID,
        capability_count: u32,
        capabilities: *const SID_AND_ATTRIBUTES,
        handle_count: u32,
        handles: *const HANDLE,
    ) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

/// 创建（或重建）AppContainer 档案，返回包 SID 原始字节。
/// 幂等策略：先删后建（setup 时无 AppContainer 进程在跑，删除必然成功）。
pub fn create_profile() -> Result<Vec<u8>, String> {
    let name = wide(PROFILE_NAME);
    let display = wide("InFu Sandbox");
    let desc = wide("InFu 沙箱离线执行包（无网络能力 = 出站全断，OS 强制）");
    unsafe { DeleteAppContainerProfile(name.as_ptr()) };
    let mut sid: PSID = ptr::null_mut();
    let hr = unsafe {
        CreateAppContainerProfile(name.as_ptr(), display.as_ptr(), desc.as_ptr(), ptr::null(), 0, &mut sid)
    };
    if hr != 0 {
        return Err(format!("CreateAppContainerProfile 失败（HRESULT {hr:#x}）"));
    }
    let len = unsafe { GetLengthSid(sid) };
    let mut out = vec![0u8; len as usize];
    unsafe { CopySid(len, out.as_mut_ptr() as _, sid) };
    Ok(out)
}

/// 删除 AppContainer 档案（不存在时静默成功）
pub fn delete_profile() -> Result<(), String> {
    let name = wide(PROFILE_NAME);
    let hr = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
    // S_OK=0；HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)=0x80070002（i32 表示）
    const HRESULT_FILE_NOT_FOUND: i32 = -2_147_024_894;
    if hr != 0 && hr != HRESULT_FILE_NOT_FOUND {
        return Err(format!("DeleteAppContainerProfile 失败（HRESULT {hr:#x}）"));
    }
    Ok(())
}

/// 低盒令牌：base（primary 受限令牌）包裹包 SID，无任何能力 → 无网络。
pub fn create_lowbox(base: HANDLE, package_sid: &[u8]) -> Result<HANDLE, String> {
    const TOKEN_ALL_ACCESS: u32 = 0xF01FF;
    let mut out: HANDLE = ptr::null_mut();
    let status = unsafe {
        NtCreateLowBoxToken(
            &mut out,
            base,
            TOKEN_ALL_ACCESS,
            ptr::null(),
            package_sid.as_ptr() as PSID,
            0, // 无能力 → 无 internetClient → 出站全断（含 DNS）
            ptr::null(),
            0,
            ptr::null(),
        )
    };
    if status != 0 {
        return Err(format!("NtCreateLowBoxToken 失败（NTSTATUS {status:#x}）"));
    }
    // 低盒令牌是全新令牌：补默认 DACL（无档案账号的令牌默认 DACL 为空会导致子进程 0xC0000142）
    crate::user::ensure_default_dacl(out);
    Ok(out)
}

/// 从状态文件取包 SID 并创建低盒令牌（runner 用；明文只在本模块内）
pub fn lowbox_from_state(base: HANDLE) -> Result<HANDLE, String> {
    let state = crate::state::load_state()?.ok_or_else(|| {
        "沙箱联网未配置——请先运行 `infu sandbox-net setup`（或去掉沙箱账号参数走当前用户受限沙箱）".to_string()
    })?;
    let sid = crate::state::b64_decode(&state.package_sid)
        .map_err(|e| format!("包 SID 解析失败: {e}"))?;
    create_lowbox(base, &sid)
}

/// 目录标 Low 完整性级别（icacls /setintegritylevel Low）：
/// Low IL 的 AppContainer 进程可写；Medium 宿主读写不受影响（写降级合法）。
pub fn set_dir_low_integrity(path: &str) -> Result<(), String> {
    let out = std::process::Command::new("icacls")
        .args([path, "/setintegritylevel", "Low"])
        .output()
        .map_err(|e| format!("调用 icacls 失败: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stdout)
            .trim()
            .to_string();
        return Err(format!("icacls /setintegritylevel Low 失败: {detail}"));
    }
    Ok(())
}

/// 包 SID 有效性检查（档案是否存在）：用当前进程令牌尝试创建低盒令牌
pub fn profile_ok(package_sid: &[u8]) -> bool {
    match crate::token::open_current_token() {
        Ok(base) => {
            let r = create_lowbox(base, package_sid);
            if let Ok(t) = r {
                unsafe { CloseHandle(t) };
            }
            unsafe { CloseHandle(base) };
            r.is_ok()
        }
        Err(_) => false,
    }
}
