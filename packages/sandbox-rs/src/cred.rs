//! DPAPI 加解密（当前用户作用域）——沙箱专用账号密码的密文存储
//!
//! 安全边界：CryptProtectData 的密文只对本机当前用户可解（DPAPI 基于用户主密钥），
//! 提权安装（UAC）后的进程与普通进程同属一个用户 SID，可相互解密。
//! 明文密码只存在于本模块的调用栈内，不落盘、不进 Node 层。

use std::ptr;

use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

/// 附加熵：即使拿到密文，无此熵也无法在其它程序里解密（防拿文件去别的工具解）
const ENTROPY: &[u8] = b"InFu sandbox-net v1";

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

/// CRYPT_INTEGER_BLOB 即 wincrypt 的 DATA_BLOB（windows-sys 统一命名为前者）
fn to_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

fn blob_to_vec(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = unsafe {
        std::slice::from_raw_parts(blob.pbData as *const u8, blob.cbData as usize)
    };
    let out = bytes.to_vec();
    if !blob.pbData.is_null() {
        unsafe { LocalFree(blob.pbData as _) };
    }
    out
}

pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut entropy = to_blob(ENTROPY);
    let mut input = to_blob(plain);
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            ptr::null(),       // 描述（不加密）
            &mut entropy,
            ptr::null(),       // 保留
            ptr::null(),       // 保留
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(format!("CryptProtectData 失败（WinError {}）", last_error()));
    }
    Ok(blob_to_vec(&out))
}

pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    let mut entropy = to_blob(ENTROPY);
    let mut input = to_blob(blob);
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            &mut entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(format!(
            "CryptUnprotectData 失败（WinError {}）——DPAPI 密文与当前用户不匹配或已损坏",
            last_error()
        ));
    }
    Ok(blob_to_vec(&out))
}
