//! Process-tree supervision and a minimal child environment (SEC-03/04/05).

use std::collections::HashSet;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

const BASE_ENV: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "USERNAME",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE", "TERM", "COLORTERM", "TZ",
    "SHELL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
    "EDITOR", "VISUAL",
    "HOMEBREW_PREFIX", "HOMEBREW_CELLAR",
    "NODE_NO_WARNINGS",
];

const PROVIDER_PREFIXES: &[&str] = &[
    "OPENCODE_", "ANTHROPIC_", "OPENAI_", "OPENROUTER_",
    "GROK_", "GEMINI_", "QWEN_", "DASHSCOPE_", "GOOSE_", "MUSE_",
];

const PROVIDER_KEYS: &[&str] = &[
    "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY",
    "DASHSCOPE_API_KEY", "QWEN_API_KEY",
];

fn keep_env_key(key: &str) -> bool {
    if key == "NODE_OPTIONS" || key == "META_API_KEY" {
        return false;
    }
    BASE_ENV.iter().any(|allowed| *allowed == key)
        || PROVIDER_KEYS.iter().any(|allowed| *allowed == key)
        || PROVIDER_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

/// Clear inherited secrets, then keep PATH/HOME and known provider keys.
pub fn apply_minimal_env(cmd: &mut Command) {
    cmd.env_clear();
    let mut kept = HashSet::new();
    for (key, value) in std::env::vars() {
        if keep_env_key(&key) && kept.insert(key.clone()) {
            cmd.env(key, value);
        }
    }
    cmd.env("NODE_NO_WARNINGS", "1");
}

pub fn isolate_command(cmd: &mut Command) {
    apply_minimal_env(cmd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Win32 `JOBOBJECT_BASIC_LIMIT_INFORMATION`. Layout is checked on 64-bit hosts.
/// Only constructed on Windows; the definition stays on every target so the
/// layout assertions in the tests run cross-host.
#[repr(C)]
#[cfg_attr(not(windows), allow(dead_code))]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
mod winjob {
    use super::JobObjectBasicLimitInformation;
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_BASIC_LIMIT_INFORMATION: u32 = 2;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub struct Job(Handle);
    unsafe impl Send for Job {}

    impl Job {
        pub fn assign_child(child: &Child) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info = std::mem::zeroed::<JobObjectBasicLimitInformation>();
                info.limit_flags = KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JOB_OBJECT_BASIC_LIMIT_INFORMATION,
                    &info as *const JobObjectBasicLimitInformation as *const c_void,
                    std::mem::size_of::<JobObjectBasicLimitInformation>() as u32,
                );
                if configured == 0 {
                    CloseHandle(job);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, child.as_raw_handle() as Handle);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }

        pub fn terminate(&self) {
            unsafe { TerminateJobObject(self.0, 1); }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0); }
        }
    }
}

#[cfg(windows)]
static JOBS: std::sync::Mutex<std::collections::HashMap<u32, winjob::Job>> = std::sync::Mutex::new(std::collections::HashMap::new());

/// Put a freshly spawned bridge in a kill-on-close job so grandchildren die
/// when the app drops the handle. No-op off Windows, and a no-op when the
/// platform refuses the assignment (shutdown then falls back to taskkill).
pub fn track_child(child: &Child) {
    #[cfg(windows)]
    if let Some(job) = winjob::Job::assign_child(child) {
        if let Ok(mut jobs) = JOBS.lock() {
            jobs.insert(child.id(), job);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

fn release_job(pid: u32, terminate: bool) {
    #[cfg(windows)]
    if let Ok(mut jobs) = JOBS.lock() {
        if let Some(job) = jobs.remove(&pid) {
            if terminate {
                job.terminate();
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, terminate);
    }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn kill_tree_hard(pid: u32) {
    #[cfg(windows)]
    {
        kill_tree(pid);
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Close stdin (EOF), wait, then end the process tree.
///
/// On Windows the bridge is assigned to a Job Object at spawn. Closing that
/// job (`KILL_ON_JOB_CLOSE`) reaps grandchildren after a clean exit; a child
/// that ignores EOF is ended with `TerminateJobObject` instead of `taskkill`.
pub fn shutdown_tree(mut child: Child, stdin: ChildStdin, grace: Duration) {
    drop(stdin);
    let pid = child.id();
    let started = Instant::now();
    while started.elapsed() < grace {
        match child.try_wait() {
            Ok(Some(_)) => {
                release_job(pid, false);
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    #[cfg(windows)]
    {
        let tracked = JOBS.lock().map(|jobs| jobs.contains_key(&pid)).unwrap_or(false);
        if tracked {
            release_job(pid, true);
            let _ = child.wait();
            return;
        }
    }
    kill_tree(pid);
    let escalate = Instant::now();
    while escalate.elapsed() < Duration::from_millis(800) {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    kill_tree_hard(pid);
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_filter_drops_unrelated_secrets() {
        assert!(!keep_env_key("META_API_KEY"));
        assert!(!keep_env_key("AWS_SECRET_ACCESS_KEY"));
        assert!(!keep_env_key("GITHUB_TOKEN"));
        assert!(!keep_env_key("NODE_OPTIONS"));
        assert!(keep_env_key("PATH"));
        assert!(keep_env_key("HOME"));
        assert!(keep_env_key("XAI_API_KEY"));
        assert!(keep_env_key("OPENCODE_TOKEN"));
    }

    #[test]
    fn job_limit_struct_matches_the_64bit_win32_layout() {
        if cfg!(target_pointer_width = "64") {
            assert_eq!(std::mem::size_of::<JobObjectBasicLimitInformation>(), 64);
            assert_eq!(std::mem::align_of::<JobObjectBasicLimitInformation>(), 8);
        }
    }
}
