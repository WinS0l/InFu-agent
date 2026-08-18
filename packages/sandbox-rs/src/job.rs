//! Job Object——进程树约束（借鉴 Codex utils/pty job.rs + 红队清单增强）
//!
//! 与 Docker 档参数对齐：--memory 2g / --pids-limit 256 的本地等价物
//!   - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：进程树与沙箱生命周期绑定，超时/崩溃不留孤儿
//!   - JOB_OBJECT_LIMIT_ACTIVE_PROCESS：防 fork bomb
//!   - JOB_OBJECT_LIMIT_PROCESS_MEMORY / JOB_MEMORY：防内存炸弹
//!   - 刻意不设 BREAKAWAY_OK：子进程无法脱离约束（Job 逃逸只丢资源限制，令牌限制仍在）

use std::mem::size_of;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, SetInformationJobObject, TerminateJobObject,
};

pub struct Job {
    pub handle: HANDLE,
}

/// 创建 Job Object。
/// v4.0 审计修复（H3）：job 句柄**不**可继承——原 bInheritHandle=1 使子进程及全部后代
/// 继承句柄，KILL_ON_JOB_CLOSE「最后一个句柄关闭时杀光 job 内进程」因后代持有的继承句柄
/// 永不触发：宿主崩溃/正常收尾（job.close() 只关父侧）后 `start /b` 分离进程可永久存活，
/// 「超时/崩溃不留孤儿」承诺失效。挂载由父进程 AssignProcessToJobObject 完成，子进程
/// 不需要 job 句柄；不继承后关闭父侧句柄即触发 KILL_ON_JOB_CLOSE，收尾自动杀残留。
pub fn create(process_memory_mb: u32, job_memory_mb: u32, active_process_limit: u32) -> Result<Job, String> {
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 0,
    };
    let h = unsafe { CreateJobObjectW(&mut sa, ptr::null()) };
    if h.is_null() {
        return Err(format!("CreateJobObjectW 失败（WinError {}）", unsafe { GetLastError() }));
    }
    // 双保险：即使 SECURITY_ATTRIBUTES 被未来改动放开，也显式清除继承标志
    if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) } == 0 {
        unsafe { CloseHandle(h) };
        return Err(format!("SetHandleInformation 失败（WinError {}）", unsafe { GetLastError() }));
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let basic: &mut JOBOBJECT_BASIC_LIMIT_INFORMATION = &mut info.BasicLimitInformation;
    basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    basic.ActiveProcessLimit = active_process_limit;
    info.ProcessMemoryLimit = process_memory_mb as usize * 1024 * 1024;
    info.JobMemoryLimit = job_memory_mb as usize * 1024 * 1024;

    let ok = unsafe {
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        unsafe { CloseHandle(h) };
        return Err(format!("SetInformationJobObject 失败（WinError {}）", unsafe { GetLastError() }));
    }
    Ok(Job { handle: h })
}

/// 挂载进程。失败不阻断（Win8+ 嵌套 job 下一般成功；失败时令牌限制仍然有效）
/// 返回是否成功挂载（供日志/审计使用）
pub fn assign(handle: HANDLE, process: HANDLE) -> bool {
    unsafe { AssignProcessToJobObject(handle, process) != 0 }
}

/// 终止整个进程树（超时/中止时调用）
pub fn terminate(handle: HANDLE) -> bool {
    unsafe { TerminateJobObject(handle, 1) != 0 }
}

pub fn close(handle: HANDLE) {
    unsafe { CloseHandle(handle) };
}
