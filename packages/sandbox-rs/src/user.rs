//! 沙箱专用账号：创建/删除/登录 + SID 获取 + 目录 ACL 授权
//!
//! 借鉴 OpenAI Codex elevated 模式的核心理由（官方工程文章结论）：
//! Windows 防火墙无法按"受限令牌的非主体身份"匹配规则——程序路径规则只匹配启动器，
//! 用户规则匹配的是真实用户而非受限子进程。因此沙箱命令必须以**专用账号**运行，
//! 防火墙按该账号 SID 拦截出站（offline 账号被拦截 / online 账号放行）。
//!
//! 本模块职责：
//!   - 账号生命周期：NetUserAdd / NetUserDel / NetUserSetInfo(重置密码)，仅提权时调用
//!   - 登录：LogonUserW(LOGON32_LOGON_BATCH)——运行时非提权，凭据来自 DPAPI 密文
//!   - 目录授权：SetEntriesInAclW + SetNamedSecurityInfoW（当前用户拥有目录，无需提权）
//!     · 工作区：两账号 Modify（含继承）
//!     · 工作区祖先路径：仅 Traverse（不能读/列目录内容，避免 Codex 的 ACL 泛滥问题）

use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER,
    GetLastError, HANDLE, LocalFree,
};
use windows_sys::Win32::NetworkManagement::NetManagement::{
    NetApiBufferFree, NetUserAdd, NetUserDel, NetUserGetInfo, NetUserSetInfo, NERR_UserNotFound,
    UF_DONT_EXPIRE_PASSWD, UF_NORMAL_ACCOUNT, UF_SCRIPT, USER_INFO_1, USER_INFO_1003,
    USER_PRIV_USER,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, GRANT_ACCESS,
    NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID,
    TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows_sys::Win32::Security::{
    CopySid, GetLengthSid, GetTokenInformation, ImpersonateLoggedOnUser, LookupAccountNameW, LogonUserW,
    LOGON32_LOGON_BATCH, LOGON32_LOGON_INTERACTIVE, RevertToSelf, TOKEN_DUPLICATE, TOKEN_USER,
    TokenUser, ACL,
    DACL_SECURITY_INFORMATION, PSID, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
};
use windows_sys::Win32::Security::Authentication::Identity::{
    LsaAddAccountRights, LsaClose, LsaOpenPolicy, LSA_HANDLE, LSA_OBJECT_ATTRIBUTES,
    LSA_UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
    FILE_TRAVERSE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub const OFFLINE_USER: &str = "infu-sandbox-offline";
pub const ONLINE_USER: &str = "infu-sandbox-online";

/// LOGON32_PROVIDER_DEFAULT（winbase.h，windows-sys 未导出）
const LOGON32_PROVIDER_DEFAULT: u32 = 0;

/// 工作区授权：Modify（读写执行 + 删除，含继承给子项）
pub const WORKSPACE_ACCESS: u32 =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
/// 祖先路径授权：仅 Traverse + 读属性（不能列出/读取内容）
pub const TRAVERSE_ACCESS: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;

pub fn last_error() -> u32 {
    unsafe { GetLastError() }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn err(msg: &str) -> String {
    format!("{msg}（WinError {}）", last_error())
}

/// 账号类型标识 → 账号名（"offline" / "online"）
pub fn account_name(kind: &str) -> Option<&'static str> {
    match kind {
        "offline" => Some(OFFLINE_USER),
        "online" => Some(ONLINE_USER),
        _ => None,
    }
}

/// 当前进程令牌是否提权（UAC TokenElevation）
pub fn is_elevated() -> bool {
    let mut h: HANDLE = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut h) } == 0 {
        return false;
    }
    let mut te: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
    let mut len: u32 = 0;
    let ok = unsafe {
        GetTokenInformation(
            h,
            TokenElevation,
            &mut te as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    };
    unsafe { CloseHandle(h) };
    ok != 0 && te.TokenIsElevated != 0
}

/// 随机强密码（BCryptGenRandom，字符集避开引号/空格/反斜杠）
fn random_password() -> Result<String, String> {
    const CHARSET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=";
    let mut bytes = [0u8; 24];
    let rc = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if rc != 0 {
        return Err(format!("BCryptGenRandom 失败（NTSTATUS {rc:#x}）"));
    }
    Ok(bytes
        .iter()
        .map(|b| CHARSET[*b as usize % CHARSET.len()] as char)
        .collect())
}

/// 账号是否存在（NetUserGetInfo level 0，少量缓冲区用完即释放）
pub fn account_exists(name: &str) -> Result<bool, String> {
    let name_w = wide(name);
    let mut buf: *mut u8 = ptr::null_mut();
    let rc = unsafe { NetUserGetInfo(ptr::null(), name_w.as_ptr(), 0, &mut buf) };
    if rc == 0 {
        unsafe { NetApiBufferFree(buf as _) };
        Ok(true)
    } else if rc == NERR_UserNotFound {
        Ok(false)
    } else if rc == ERROR_ACCESS_DENIED {
        Err(format!("NetUserGetInfo({name}) 拒绝访问（查询账号需相应权限）"))
    } else {
        Err(format!("NetUserGetInfo({name}) 失败（WinError {rc}）"))
    }
}

/// 创建账号；已存在则重置密码（固定名幂等重装）
/// 仅提权进程可调用（创建本地账号需管理员）。
pub fn create_or_reset_account(name: &str) -> Result<String, String> {
    let password = random_password()?;
    let name_w = wide(name);
    let pw_w = wide(&password);
    let comment = wide("InFu sandbox account — managed by infu sandbox-net");

    if account_exists(name).unwrap_or(false) {
        let mut info: USER_INFO_1003 = unsafe { std::mem::zeroed() };
        info.usri1003_password = pw_w.as_ptr() as _;
        let rc = unsafe {
            NetUserSetInfo(ptr::null(), name_w.as_ptr(), 1003, &info as *const _ as *const u8, ptr::null_mut())
        };
        if rc != 0 {
            return Err(format!("NetUserSetInfo({name}, 重置密码) 失败（WinError {rc}）"));
        }
        return Ok(password);
    }

    let mut info: USER_INFO_1 = unsafe { std::mem::zeroed() };
    info.usri1_name = name_w.as_ptr() as _;
    info.usri1_password = pw_w.as_ptr() as _;
    info.usri1_priv = USER_PRIV_USER;
    info.usri1_comment = comment.as_ptr() as _;
    info.usri1_flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_NORMAL_ACCOUNT;
    let rc = unsafe {
        NetUserAdd(ptr::null(), 1, &info as *const _ as *const u8, ptr::null_mut())
    };
    if rc != 0 && rc != ERROR_ALREADY_EXISTS {
        return Err(format!("NetUserAdd({name}) 失败（WinError {rc}）"));
    }
    Ok(password)
}

/// 删除账号（不存在时静默成功）
pub fn delete_account(name: &str) -> Result<(), String> {
    let name_w = wide(name);
    let rc = unsafe { NetUserDel(ptr::null(), name_w.as_ptr()) };
    if rc != 0 && rc != NERR_UserNotFound {
        return Err(format!("NetUserDel({name}) 失败（WinError {rc}）"));
    }
    Ok(())
}

/// 账号登录（BATCH 登录类型：不加载用户档案，返回 primary 令牌）
pub fn logon_user(name: &str, password: &str) -> Result<HANDLE, String> {
    let name_w = wide(name);
    let pw_w = wide(password);
    let mut h: HANDLE = ptr::null_mut();
    let logon_type = if std::env::var("INFU_SANDBOX_LOGON_INTERACTIVE").is_ok() {
        LOGON32_LOGON_INTERACTIVE as u32
    } else {
        LOGON32_LOGON_BATCH as u32
    };
    let ok = unsafe {
        LogonUserW(
            name_w.as_ptr(),
            wide(".").as_ptr(), // 本地机器
            pw_w.as_ptr(),
            logon_type,
            LOGON32_PROVIDER_DEFAULT,
            &mut h,
        )
    };
    if ok == 0 {
        return Err(err(&format!("LogonUserW({name}) 失败")));
    }
    // 无用户档案的 BATCH 登录令牌默认 DACL 为空 → 子进程 DLL 初始化失败（0xC0000142）
    ensure_default_dacl(h);
    Ok(h)
}

/// 确保令牌有默认 DACL（user + SYSTEM + Administrators 完全控制）。
/// 无档案账号的登录令牌 DefaultDacl 常为 NULL，导致 CreateProcess 出的子进程
/// 加载器初始化失败（STATUS_DLL_INIT_FAILED 0xC0000142）。
pub fn ensure_default_dacl(token: HANDLE) {
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, InitializeAcl, SetTokenInformation,
        TOKEN_DEFAULT_DACL, TOKEN_USER, TokenDefaultDacl, TokenUser,
    };
    const GENERIC_ALL: u32 = 0x1000_0000;
    const ACL_REVISION_2: u32 = 2; // ACL_REVISION 的类型可能不同，统一用值

    // 已有默认 DACL → 不动
    let mut len: u32 = 0;
    unsafe { GetTokenInformation(token, TokenDefaultDacl, ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return;
    }
    let mut buf = vec![0u8; len as usize];
    if unsafe { GetTokenInformation(token, TokenDefaultDacl, buf.as_mut_ptr() as *mut _, len, &mut len) } == 0 {
        return;
    }
    let td = unsafe { &*(buf.as_ptr() as *const TOKEN_DEFAULT_DACL) };
    if !td.DefaultDacl.is_null() {
        return;
    }

    // 用户 SID（来自令牌自身）
    let mut ulen: u32 = 0;
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut ulen) };
    let mut ubuf = vec![0u8; ulen as usize];
    if unsafe { GetTokenInformation(token, TokenUser, ubuf.as_mut_ptr() as *mut _, ulen, &mut ulen) } == 0 {
        return;
    }
    let tu = unsafe { &*(ubuf.as_ptr() as *const TOKEN_USER) };

    // SYSTEM S-1-5-18、Administrators S-1-5-32-544（固定字节，SID 无对齐要求）
    let system_sid: [u8; 12] = [1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
    let admin_sid: [u8; 20] = [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0, 0, 0, 0, 0];

    let mut acl_buf = [0u8; 256];
    let acl_ptr = acl_buf.as_mut_ptr() as *mut windows_sys::Win32::Security::ACL;
    if unsafe { InitializeAcl(acl_ptr, acl_buf.len() as u32, ACL_REVISION_2) } == 0 {
        return;
    }
    unsafe {
        AddAccessAllowedAce(acl_ptr, ACL_REVISION_2, GENERIC_ALL, tu.User.Sid);
        AddAccessAllowedAce(acl_ptr, ACL_REVISION_2, GENERIC_ALL, system_sid.as_ptr() as PSID);
        AddAccessAllowedAce(acl_ptr, ACL_REVISION_2, GENERIC_ALL, admin_sid.as_ptr() as PSID);
    }
    let mut out = TOKEN_DEFAULT_DACL {
        DefaultDacl: acl_ptr,
    };
    unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            &mut out as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
        );
    }
}

/// 授予账号一组用户权利（SeBatchLogonRight 等）。仅提权时调用；幂等（重复授予成功）。
pub fn grant_user_rights(name: &str, rights: &[&str]) -> Result<(), String> {
    const POLICY_ALL_ACCESS: u32 = 0xF01FF;
    let sid = lookup_user_sid(name)?;
    // Length 必须正确初始化（zeroed 的 Length=0 会导致 LsaAddAccountRights 返回
    // STATUS_INVALID_SECURITY_DESCR 0xC0000060——P/Invoke 对照实验证实）
    let mut obj_attrs: LSA_OBJECT_ATTRIBUTES = unsafe { std::mem::zeroed() };
    obj_attrs.Length = std::mem::size_of::<LSA_OBJECT_ATTRIBUTES>() as u32;
    let mut policy: LSA_HANDLE = 0;
    let status = unsafe { LsaOpenPolicy(ptr::null(), &obj_attrs, POLICY_ALL_ACCESS, &mut policy) };
    if status != 0 {
        return Err(format!("LsaOpenPolicy 失败（NTSTATUS {status:#x}）"));
    }
    let mut lsas: Vec<LSA_UNICODE_STRING> = Vec::new();
    let mut bufs: Vec<Vec<u16>> = Vec::new();
    for r in rights {
        let w = wide(r);
        bufs.push(w); // 保持缓冲区存活（指针必须指向存活内存）
        let buf = bufs.last().unwrap();
        lsas.push(LSA_UNICODE_STRING {
            Length: ((buf.len() - 1) * 2) as u16, // 不含结尾 NUL
            MaximumLength: (buf.len() * 2) as u16,
            Buffer: buf.as_ptr() as _,
        });
    }
    let status = unsafe { LsaAddAccountRights(policy, sid.as_ptr() as PSID, lsas.as_ptr(), lsas.len() as u32) };
    unsafe { LsaClose(policy) };
    if status != 0 {
        return Err(format!("LsaAddAccountRights({name}) 失败（NTSTATUS {status:#x}）"));
    }
    Ok(())
}

/// 授予账号"批处理登录权"（SeBatchLogonRight）——LogonUserW(BATCH) 必需
pub fn grant_batch_logon(name: &str) -> Result<(), String> {
    grant_user_rights(name, &["SeBatchLogonRight"])
}

/// 按账号类型登录沙箱账号（状态文件 → DPAPI 解密 → LogonUser）
/// kind: "offline" / "online"；明文密码只在调用栈内，不进 Node 层。
pub fn logon_sandbox_user(kind: &str) -> Result<HANDLE, String> {
    account_name(kind)
        .ok_or_else(|| format!("未知沙箱账号类型: {kind}（仅支持 offline / online）"))?;
    let state = crate::state::load_state()?.ok_or_else(|| {
        "沙箱联网未配置——请先运行 `infu sandbox-net setup`（或去掉沙箱账号参数走当前用户受限沙箱）".to_string()
    })?;
    let creds = match kind {
        "offline" => &state.offline,
        _ => &state.online,
    };
    let blob = crate::state::b64_decode(&creds.password_dpapi)
        .map_err(|e| format!("账号密文解析失败（{kind}）: {e}"))?;
    let pw = unprotect_sandbox_password(&blob)
        .map_err(|e| format!("账号密码解密失败（{kind}）: {e}"))?;
    let pw_str = String::from_utf8(pw).map_err(|_| "账号密码解密结果非法".to_string())?;
    logon_user(&creds.name, &pw_str)
}

/// 解密沙箱账号密码。helper 以 SYSTEM 运行时 DPAPI 主密钥按用户存储，
/// 需先模拟交互用户（explorer.exe 所在会话）再解密，完事还原。
pub fn unprotect_sandbox_password(blob: &[u8]) -> Result<Vec<u8>, String> {
    // 普通身份（交互用户）：直接解
    if !is_system() {
        if let Ok(r) = crate::cred::unprotect(blob) {
            return Ok(r);
        }
        // S4U 等无凭据登录令牌解不开 DPAPI → 模拟交互用户重试
    }
    let user_token = interactive_user_token()?;
    let ok = unsafe { ImpersonateLoggedOnUser(user_token) };
    unsafe { CloseHandle(user_token) };
    if ok == 0 {
        return Err(err("ImpersonateLoggedOnUser 失败"));
    }
    let r = crate::cred::unprotect(blob);
    unsafe { RevertToSelf() };
    r
}

/// 当前进程是否以 SYSTEM 身份运行
fn is_system() -> bool {
    match crate::token::open_current_token() {
        Ok(h) => {
            let r = token_user_sid_string(h).map(|s| s == "S-1-5-18").unwrap_or(false);
            crate::token::close(h);
            r
        }
        Err(_) => false,
    }
}

fn token_user_sid_string(token: HANDLE) -> Result<String, String> {
    let mut len: u32 = 0;
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len) };
    let mut buf = vec![0u8; len as usize];
    if unsafe { GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut _, len, &mut len) } == 0 {
        return Err(err("GetTokenInformation(TokenUser) 失败"));
    }
    let tu = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let sid_len = unsafe { GetLengthSid(tu.User.Sid) };
    let mut sid = vec![0u8; sid_len as usize];
    unsafe { CopySid(sid_len, sid.as_mut_ptr() as _, tu.User.Sid) };
    sid_string(&sid)
}

/// 交互用户的令牌（枚举 explorer.exe 进程，取第一个可打开的）
fn interactive_user_token() -> Result<HANDLE, String> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::OpenProcess;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Err(err("CreateToolhelp32Snapshot 失败"));
    }
    let mut pe: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut result: Option<HANDLE> = None;
    if unsafe { Process32FirstW(snap, &mut pe) } != 0 {
        loop {
            let name: String = pe.szExeFile
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as u8 as char)
                .collect();
            if name.eq_ignore_ascii_case("explorer.exe") {
                let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pe.th32ProcessID) };
                if !h.is_null() {
                    let mut tok: HANDLE = ptr::null_mut();
                    if unsafe { OpenProcessToken(h, TOKEN_DUPLICATE | TOKEN_QUERY, &mut tok) } != 0 {
                        result = Some(tok);
                        unsafe { CloseHandle(h) };
                        break;
                    }
                    unsafe { CloseHandle(h) };
                }
            }
            if unsafe { Process32NextW(snap, &mut pe) } == 0 {
                break;
            }
        }
    }
    unsafe { CloseHandle(snap) };
    match result {
        Some(t) => Ok(t),
        None => Err("未找到交互用户进程（explorer.exe）".to_string()),
    }
}

/// 按账号名查 SID（LookupAccountNameW 两段式）
pub fn lookup_user_sid(name: &str) -> Result<Vec<u8>, String> {
    let name_w = wide(name);
    let mut sid_len: u32 = 0;
    let mut dom_len: u32 = 0;
    let mut use_: i32 = 0;
    let ok = unsafe {
        LookupAccountNameW(
            ptr::null(),
            name_w.as_ptr(),
            ptr::null_mut(),
            &mut sid_len,
            ptr::null_mut(),
            &mut dom_len,
            &mut use_,
        )
    };
    if ok == 0 {
        let e = last_error();
        if e != ERROR_INSUFFICIENT_BUFFER {
            return Err(err(&format!("LookupAccountNameW({name}) 失败")));
        }
    }
    let mut sid = vec![0u8; sid_len as usize];
    let mut dom = vec![0u16; dom_len as usize];
    let ok = unsafe {
        LookupAccountNameW(
            ptr::null(),
            name_w.as_ptr(),
            sid.as_mut_ptr() as _,
            &mut sid_len,
            dom.as_mut_ptr(),
            &mut dom_len,
            &mut use_,
        )
    };
    if ok == 0 {
        return Err(err(&format!("LookupAccountNameW({name}) 失败")));
    }
    Ok(sid)
}

/// SID 原始字节 → 字符串（S-1-5-…）
pub fn sid_string(sid: &[u8]) -> Result<String, String> {
    let mut s: windows_sys::core::PWSTR = ptr::null_mut();
    let ok = unsafe { ConvertSidToStringSidW(sid.as_ptr() as PSID, &mut s) };
    if ok == 0 {
        return Err(err("ConvertSidToStringSidW 失败"));
    }
    let out = unsafe { wide_to_string(s) };
    unsafe { LocalFree(s as _) };
    Ok(out)
}

unsafe fn wide_to_string(p: windows_sys::core::PWSTR) -> String {
    let mut out = String::new();
    let mut i = 0usize;
    loop {
        let c = *p.add(i);
        if c == 0 {
            break;
        }
        out.push(char::from_u32(c as u32).unwrap_or('\u{FFFD}'));
        i += 1;
    }
    out
}

/// 对目录追加授权：sids 获得 access 权限（inherit 控制是否被子对象继承）
/// 通过 SetEntriesInAclW 与现有 DACL 合并（不覆盖已有 ACE，不阻断继承）。
pub fn grant_dir(path: &str, sids: &[Vec<u8>], access: u32, inherit: bool) -> Result<(), String> {
    let path_w = wide(path);

    // 现有 DACL（无显式 DACL 时为 null → SetEntriesInAclW 按空处理）
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut sd: *mut core::ffi::c_void = ptr::null_mut();
    let rc = unsafe {
        GetNamedSecurityInfoW(
            path_w.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut sd,
        )
    };
    if rc != 0 {
        return Err(format!("GetNamedSecurityInfoW({path}) 失败（WinError {rc}）"));
    }

    let mut entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: access,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: if inherit { 3 } else { 0 }, // SUB_CONTAINERS_AND_OBJECTS_INHERIT
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.as_ptr() as _,
            },
        })
        .collect();

    let mut new_acl: *mut ACL = ptr::null_mut();
    let rc = unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_mut_ptr(), dacl, &mut new_acl) };
    if rc != 0 {
        return Err(format!("SetEntriesInAclW({path}) 失败（WinError {rc}）"));
    }

    let rc = unsafe {
        SetNamedSecurityInfoW(
            path_w.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            new_acl,
            ptr::null_mut(),
        )
    };
    unsafe {
        if !new_acl.is_null() {
            LocalFree(new_acl as _);
        }
        if !sd.is_null() {
            LocalFree(sd as _);
        }
    }
    if rc != 0 {
        return Err(format!("SetNamedSecurityInfoW({path}) 失败（WinError {rc}）"));
    }
    Ok(())
}

/// 工作区授权：root Modify（继承）+ 祖先路径 Traverse（不继承）
/// 返回授权过的目录列表（供审计/展示）。
/// 宽容模式：祖先授权失败（如盘符根 E:\ 的受保护 ACL）跳过并记录，不阻断工作区授权。
pub fn grant_workspace(root: &str, sids: &[Vec<u8>]) -> Result<Vec<String>, String> {
    let mut granted = Vec::new();
    let mut skipped = Vec::new();

    // 祖先路径 Traverse（不含 root 本身；到盘符根为止）
    let mut cur = std::path::Path::new(root).parent();
    while let Some(p) = cur {
        let s = p.to_string_lossy().into_owned();
        if s.is_empty() || s.ends_with(':') {
            break; // 盘符根（C:\）或空
        }
        if std::path::Path::new(&s).exists() {
            match grant_dir(&s, sids, TRAVERSE_ACCESS, false) {
                Ok(()) => granted.push(format!("{s}（Traverse）")),
                Err(e) => skipped.push(format!("{s}（{e}）")),
            }
        }
        cur = p.parent();
    }

    // 工作区 Modify（继承）
    grant_dir(root, sids, WORKSPACE_ACCESS, true)?;
    granted.push(format!("{root}（Modify）"));

    if !skipped.is_empty() {
        granted.push(format!("跳过 {} 个祖先目录: {}", skipped.len(), skipped.join("; ")));
    }
    Ok(granted)
}

/// PATH 中存在的目录 → 两账号 Read+Execute（继承），供工具链（node/git/python 等）读取。
/// System32 / Program Files 等 Users 组本就可读，重复授权无害；关键是覆盖
/// 用户级安装目录（如 %USERPROFILE%\AppData\Local\Programs）——那是默认不共享的。
/// 宽容模式：个别目录授权失败（如 System32 受保护 DACL）跳过并记录，不阻断安装。
pub fn grant_tool_dirs(sids: &[Vec<u8>]) -> Result<Vec<String>, String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let mut granted = Vec::new();
    let mut skipped = Vec::new();
    for entry in path.split(';') {
        let entry = entry.trim();
        if entry.is_empty() || !std::path::Path::new(entry).exists() {
            continue;
        }
        match grant_dir(entry, sids, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, true) {
            Ok(()) => granted.push(entry.to_string()),
            Err(e) => skipped.push(format!("{entry}（{e}）")),
        }
    }
    if !skipped.is_empty() {
        granted.push(format!("跳过 {} 个受保护目录: {}", skipped.len(), skipped.join("; ")));
    }
    Ok(granted)
}
