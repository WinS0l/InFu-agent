//! 沙箱联网状态文件：~/.infu/sandbox-net.json
//!
//! 存放两账号的 DPAPI 密文（明文密码只存在于 Rust 调用栈，不进 Node 层）与元数据。
//! 提权安装（setup）时写入，运行时（LogonUser）与 status 读取。
//! 文件权限与 ~/.infu 一致（API Key 同目录，0600 语义）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const STATE_FILE: &str = "sandbox-net.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct AccountCreds {
    pub name: String,
    /// DPAPI 密文（base64）
    pub password_dpapi: String,
}

#[derive(Serialize, Deserialize)]
pub struct SandboxNetState {
    pub version: u32,
    pub offline: AccountCreds,
    pub online: AccountCreds,
    /// AppContainer 包 SID（base64 原始字节）——离线断网的 OS 级强制标识
    pub package_sid: String,
    pub created_at: String,
}

pub fn state_path() -> PathBuf {
    let profile = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(profile).join(".infu").join(STATE_FILE)
}

pub fn load_state() -> Result<Option<SandboxNetState>, String> {
    let p = state_path();
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("读取状态文件失败（{}）: {e}", p.display()))?;
    let state: SandboxNetState = serde_json::from_str(&raw)
        .map_err(|e| format!("解析状态文件失败（{}）: {e}", p.display()))?;
    Ok(Some(state))
}

pub fn save_state(state: &SandboxNetState) -> Result<(), String> {
    let p = state_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建 ~/.infu 失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(state)
        .map_err(|e| format!("序列化状态失败: {e}"))?;
    std::fs::write(&p, raw).map_err(|e| format!("写入状态文件失败（{}）: {e}", p.display()))
}

pub fn delete_state() -> Result<(), String> {
    let p = state_path();
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("删除状态文件失败（{}）: {e}", p.display()))?;
    }
    Ok(())
}

/// 最小 base64（标准字母表 + padding；无依赖实现，仅用于状态文件字段）
pub fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(T[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.chars() {
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            '=' => break,
            _ => return Err(format!("base64 非法字符: {c:?}")),
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}
