# InFu 提权辅助：授予当前用户所需特权（SeAssignPrimaryToken 等）
# 由提权的 setup 子进程调用（P/Invoke 直调 LSA，避免本机策略/工具差异）
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LsaGrant {
    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
    [DllImport("advapi32.dll")]
    public static extern uint LsaOpenPolicy(IntPtr SystemName, ref LSA_OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
    [DllImport("advapi32.dll")]
    public static extern uint LsaAddAccountRights(IntPtr PolicyHandle, IntPtr AccountSid, LSA_UNICODE_STRING[] UserRights, uint CountOfRights);
    [DllImport("advapi32.dll")]
    public static extern uint LsaClose(IntPtr PolicyHandle);
}
"@

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sidBytes = New-Object byte[] $sid.BinaryLength
$sid.GetBinaryForm($sidBytes, 0)
$sidPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sidBytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($sidBytes, 0, $sidPtr, $sidBytes.Length)

$oa = New-Object LsaGrant+LSA_OBJECT_ATTRIBUTES
$oa.Length = [System.Runtime.InteropServices.Marshal]::SizeOf([type][LsaGrant+LSA_OBJECT_ATTRIBUTES])
$policy = [IntPtr]::Zero
$log = "start $(Get-Date -Format HH:mm:ss)"
$st = [LsaGrant]::LsaOpenPolicy([IntPtr]::Zero, [ref]$oa, 0xF01FF, [ref]$policy)
$log += "`nLsaOpenPolicy: 0x$($st.ToString('X'))"
if ($st -ne 0) { throw "LsaOpenPolicy failed: 0x$($st.ToString('X'))" }

$names = @("SeAssignPrimaryTokenPrivilege", "SeImpersonatePrivilege", "SeIncreaseQuotaPrivilege", "SeBatchLogonRight")
foreach ($name in $names) {
    $buf = [System.Text.Encoding]::Unicode.GetBytes($name + "`0")
    $bufPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($buf.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $bufPtr, $buf.Length)
    $r = New-Object LsaGrant+LSA_UNICODE_STRING
    $r.Length = $buf.Length - 2
    $r.MaximumLength = $buf.Length
    $r.Buffer = $bufPtr
    $single = New-Object LsaGrant+LSA_UNICODE_STRING[] 1
    $single[0] = $r
    $st = [LsaGrant]::LsaAddAccountRights($policy, $sidPtr, $single, 1)
    $log += "`nLsaAddAccountRights($name): 0x$($st.ToString('X'))"
    if ($st -ne 0) { throw "LsaAddAccountRights($name) failed: 0x$($st.ToString('X'))" }
}
[LsaGrant]::LsaClose($policy) | Out-Null
$log += "`nrights granted"
$log | Set-Content -Path "$env:TEMP\grant-rights-result.txt" -Encoding UTF8
