/**
 * Windows Job Object supervisor (SEC-04).
 *
 * Node has no Job Object API. A single PowerShell process holds the kernel
 * handles for the life of the bridge: `assign` nests a child in a job with
 * `KILL_ON_JOB_CLOSE`, and `kill` calls `TerminateJobObject`. Closing the
 * supervisor (bridge exit) closes those handles, so grandchildren die with
 * the job instead of surviving `taskkill`.
 */

import { spawn, type ChildProcess } from "node:child_process";

export const WINDOWS_JOB_SUPERVISOR = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MuseJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, ref BasicLimit lpJobObjectInformation, uint cbJobObjectInformationLength);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimit {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  public static bool Configure(IntPtr job) {
    var info = new BasicLimit();
    info.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    return SetInformationJobObject(job, 2, ref info, (uint)Marshal.SizeOf(typeof(BasicLimit)));
  }
}
"@
$jobs = @{}
function Reply([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  $split = $line.Split(' ', 2)
  $procId = 0
  if ($split.Length -lt 2 -or -not [int]::TryParse($split[1], [ref]$procId)) { Reply 'no'; continue }
  $key = "$procId"
  if ($split[0] -eq 'assign') {
    $job = [MuseJob]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero -or -not [MuseJob]::Configure($job)) { if ($job -ne [IntPtr]::Zero) { [void][MuseJob]::CloseHandle($job) }; Reply 'no'; continue }
    $proc = [MuseJob]::OpenProcess(0x101, $false, $procId)
    $assigned = $proc -ne [IntPtr]::Zero -and [MuseJob]::AssignProcessToJobObject($job, $proc)
    if ($proc -ne [IntPtr]::Zero) { [void][MuseJob]::CloseHandle($proc) }
    if (-not $assigned) { [void][MuseJob]::CloseHandle($job); Reply 'no'; continue }
    $jobs[$key] = $job
    Reply 'ok'
  } elseif ($split[0] -eq 'kill' -and $jobs.ContainsKey($key)) {
    $job = $jobs[$key]
    [void][MuseJob]::TerminateJobObject($job, 1)
    [void][MuseJob]::CloseHandle($job)
    [void]$jobs.Remove($key)
    Reply 'ok'
  } else { Reply 'no' }
}
`;

let supervisor: ChildProcess | null = null;
let buffer = "";
const pending: Array<(ok: boolean) => void> = [];
const assigns = new Map<number, Promise<boolean>>();
let hooked = false;

function failPending() {
  const waiters = pending.splice(0);
  for (const waiter of waiters) waiter(false);
}

function ensureSupervisor(): ChildProcess | null {
  if (process.platform !== "win32") return null;
  if (supervisor && supervisor.exitCode == null && !supervisor.killed) return supervisor;
  const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_JOB_SUPERVISOR, "utf16le").toString("base64")], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  supervisor = proc;
  buffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      pending.shift()?.(line === "ok");
      newline = buffer.indexOf("\n");
    }
  });
  proc.on("exit", () => {
    supervisor = null;
    failPending();
  });
  if (!hooked) {
    hooked = true;
    process.once("exit", () => { try { supervisor?.kill(); } catch { /* already gone */ } });
  }
  return proc;
}

function send(line: string): Promise<boolean> {
  const proc = ensureSupervisor();
  const stdin = proc?.stdin;
  if (!proc || !stdin) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* supervisor is wedged */ }
      finish(false);
    }, 8_000);
    pending.push(finish);
    try {
      stdin.write(`${line}\n`);
    } catch {
      pending.pop();
      finish(false);
    }
  });
}

/** Nest `pid` in a kill-on-close job. No-op off Windows. */
export function assignWindowsJob(pid: number): Promise<boolean> {
  if (process.platform !== "win32" || !pid) return Promise.resolve(false);
  const task = send(`assign ${pid}`);
  assigns.set(pid, task);
  void task.finally(() => { if (assigns.get(pid) === task) assigns.delete(pid); });
  return task;
}

/** Terminate the job created for `pid`. False when no supervisor confirmed it. */
export async function killWindowsJob(pid: number): Promise<boolean> {
  if (process.platform !== "win32" || !pid) return false;
  const assigned = assigns.get(pid);
  if (assigned) await assigned;
  return send(`kill ${pid}`);
}
