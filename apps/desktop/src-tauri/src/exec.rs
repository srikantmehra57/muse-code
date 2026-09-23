//! Executable identity for the SEC-02 trust boundary.
//!
//! Every binary the app spawns — the bridge sidecar, `muse`, and ACP agent
//! CLIs — resolves here: the path is canonicalized (symlinks resolved, so a
//! non-temp symlink to a temp executable cannot bypass the temp check),
//! required to be a regular executable file outside temporary directories,
//! and pinned by SHA-256 digest. A same-path replacement or retarget between
//! spawns fails closed; a first sighting records its digest and proceeds.
//!
//! ACP agents additionally pin across restarts in the OS keyring: the app
//! never silently switches to a newly shadowing PATH entry — an identity
//! change fails the call until the user confirms the new binary.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// In-process digest pins: canonical path -> SHA-256 hex. First sighting
/// records; later spawns re-hash and fail on mismatch.
pub struct ExecPins {
    inner: Mutex<HashMap<PathBuf, String>>,
}

impl ExecPins {
    pub fn new() -> Self {
        ExecPins { inner: Mutex::new(HashMap::new()) }
    }

    /// Record the digest on first sighting, or verify it matches. Fails
    /// closed when the file cannot be read or its bytes changed.
    pub fn check(&self, canonical: &Path, what: &str) -> Result<(), String> {
        let digest = sha256_file(canonical)?;
        let mut pins = self.inner.lock().map_err(|err| err.to_string())?;
        match pins.get(canonical) {
            Some(pinned) if pinned == &digest => Ok(()),
            Some(_) => Err(format!("{what} was replaced on disk since it was first used. Restart the app to use the new binary.")),
            None => {
                pins.insert(canonical.to_path_buf(), digest);
                Ok(())
            }
        }
    }
}

/// SHA-256 hex digest of a file, streamed so large binaries stay cheap.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| "That executable is not available.".to_string())?;
    let mut reader = std::io::BufReader::new(file);
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk).map_err(|_| "That executable could not be read.".to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn in_temp_dir(canonical: &Path) -> bool {
    let lowered = canonical.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    lowered.starts_with("/tmp/")
        || lowered.starts_with("/var/tmp/")
        || lowered.starts_with("/private/tmp/")
        || lowered.contains("/appdata/local/temp/")
        || std::env::temp_dir().canonicalize().is_ok_and(|tmp| canonical.starts_with(tmp))
}

#[cfg(unix)]
fn has_exec_bit(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn has_exec_bit(path: &Path) -> bool {
    path.is_file()
}

/// Canonicalize `raw`, require a regular executable file outside temporary
/// directories whose file name satisfies `allowed_name`, and return the
/// canonical path. All checks run against the canonical target, so a symlink
/// cannot smuggle a temp or misnamed executable past validation.
pub fn validate_exec(raw: &str, allowed_name: &dyn Fn(&str) -> bool, what: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err(format!("{what} is not available."));
    }
    let canonical = PathBuf::from(raw)
        .canonicalize()
        .map_err(|_| format!("{what} is not available."))?;
    if in_temp_dir(&canonical) {
        return Err(format!("{what} must live outside temporary directories."));
    }
    let name = canonical.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !allowed_name(name) {
        return Err(format!("{what} has an unexpected file name."));
    }
    let meta = std::fs::symlink_metadata(&canonical).map_err(|_| format!("{what} is not available."))?;
    if !meta.is_file() || !has_exec_bit(&canonical) {
        return Err(format!("{what} is not an executable file."));
    }
    Ok(canonical)
}

pub fn muse_name_allowed(name: &str) -> bool {
    name == "muse" || name == "muse.exe" || name.starts_with("muse-bin-")
}

/// Agent binaries from `agents.ts`, mirrored natively so resolution never
/// trusts the bridge's PATH walk: (agent id, display name, binary names,
/// extra install dirs under $HOME).
pub struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub bins: &'static [&'static str],
    pub dirs: &'static [&'static str],
}

pub const AGENTS: &[AgentSpec] = &[
    AgentSpec { id: "muse", name: "Muse", bins: &["muse"], dirs: &[] },
    AgentSpec { id: "opencode", name: "OpenCode", bins: &["opencode"], dirs: &[".opencode/bin"] },
    AgentSpec { id: "grok", name: "Grok", bins: &["grok"], dirs: &[".grok/bin"] },
    AgentSpec { id: "gemini", name: "Gemini CLI", bins: &["gemini"], dirs: &[] },
    AgentSpec { id: "qwen", name: "Qwen Code", bins: &["qwen"], dirs: &[] },
    AgentSpec { id: "goose", name: "Goose", bins: &["goose"], dirs: &[] },
];

pub fn agent_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|spec| spec.id == id)
}

fn agent_search_dirs(spec: &AgentSpec) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for extra in spec.dirs {
            dirs.push(home.join(extra));
        }
        for common in [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin", ".asdf/shims", ".nvm/current/bin"] {
            dirs.push(home.join(common));
        }
    }
    for well_known in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(well_known));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs
}

/// Canonical names a resolved agent binary may carry. Vendor installers keep
/// versioned downloads behind a stable symlink (`grok` -> `downloads/
/// grok-1.0.40-macos-aarch64`), so a `-`-suffixed variant of a launch name is
/// still the agent — but `grokhelper` or a foreign target stays rejected.
fn agent_name_allowed<'a>(names: &'a [String]) -> impl Fn(&str) -> bool + 'a {
    move |file| {
        names.iter().any(|allowed| {
            file.strip_prefix(allowed.as_str())
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
        })
    }
}

/// Resolve an ACP agent binary exactly like the bridge does (extra dirs, then
/// well-known dirs, then PATH), and validate the winner. Returns the canonical
/// path; shadowing entries never surface without going through identity check.
pub fn resolve_agent_bin(spec: &AgentSpec) -> Result<PathBuf, String> {
    let mut names: Vec<String> = Vec::new();
    for bin in spec.bins {
        #[cfg(windows)]
        for suffixed in [format!("{bin}.exe"), format!("{bin}.cmd"), bin.to_string()] {
            names.push(suffixed);
        }
        #[cfg(not(windows))]
        names.push(bin.to_string());
    }
    for dir in agent_search_dirs(spec) {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                let what = format!("The {} CLI", spec.name);
                let is_bin = agent_name_allowed(&names);
                return validate_exec(&candidate.to_string_lossy(), &is_bin, &what);
            }
        }
    }
    Err(format!("{} is not installed. Install it, then choose Rescan.", spec.name))
}

/// Run `bin --version` with a bounded wait; a hung binary is killed and
/// reports no version instead of hanging the caller.
pub fn probe_version(bin: &Path) -> Option<String> {
    let mut child = std::process::Command::new(bin)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let mut waited = 0;
    let output = loop {
        match child.try_wait() {
            Ok(Some(_)) => break child.wait_with_output().ok()?,
            Ok(None) => {
                waited += 1;
                if waited >= 30 {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return None,
        }
    };
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(160).collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPin {
    pub path: String,
    pub version: Option<String>,
    pub sha256: String,
}

/// Cross-restart ACP identity pins, persisted in the OS keyring next to the
/// workspace grants (renderer-readable, never renderer-writable).
pub struct AgentPins {
    inner: Mutex<HashMap<String, AgentPin>>,
}

impl AgentPins {
    pub fn new(pins: HashMap<String, AgentPin>) -> Self {
        AgentPins { inner: Mutex::new(pins) }
    }

    pub fn snapshot(&self) -> HashMap<String, AgentPin> {
        self.inner.lock().map(|pins| pins.clone()).unwrap_or_default()
    }

    /// Bulk-load persisted pins at startup.
    pub fn replace(&self, pins: HashMap<String, AgentPin>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = pins;
        }
    }

    /// Check a freshly resolved binary against its pin. First sighting
    /// records and proceeds; a path or digest change fails until confirmed.
    pub fn check(&self, agent_id: &str, canonical: &Path, version: Option<String>) -> Result<(), String> {
        let digest = sha256_file(canonical)?;
        let path = canonical.to_string_lossy().into_owned();
        let mut pins = self.inner.lock().map_err(|err| err.to_string())?;
        match pins.get(agent_id) {
            None => {
                pins.insert(agent_id.to_string(), AgentPin { path, version, sha256: digest });
                Ok(())
            }
            Some(pinned) if pinned.path == path && pinned.sha256 == digest => {
                // Refresh the display version; identity (path + bytes) matches.
                pins.insert(agent_id.to_string(), AgentPin { path, version, sha256: digest });
                Ok(())
            }
            Some(pinned) => Err(identity_changed(agent_id, &pinned.path, &path)),
        }
    }

    /// Record a user-confirmed binary. The caller must have resolved `path`
    /// itself — the renderer can confirm, never nominate.
    pub fn confirm(&self, agent_id: &str, canonical: &Path, version: Option<String>) -> Result<(), String> {
        let digest = sha256_file(canonical)?;
        let mut pins = self.inner.lock().map_err(|err| err.to_string())?;
        pins.insert(agent_id.to_string(), AgentPin { path: canonical.to_string_lossy().into_owned(), version, sha256: digest });
        Ok(())
    }

    pub fn get(&self, agent_id: &str) -> Option<AgentPin> {
        self.inner.lock().ok()?.get(agent_id).cloned()
    }
}

/// Machine-detectable prefix: the renderer matches `Agent identity changed`
/// to offer the confirm-and-retry flow.
fn identity_changed(agent_id: &str, old: &str, new: &str) -> String {
    let short = |path: &str| {
        let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned()).unwrap_or_default();
        let rel = if !home.is_empty() {
            path.strip_prefix(&home).map(|rest| format!("~{rest}")).unwrap_or_else(|| path.to_string())
        } else {
            path.to_string()
        };
        rel.chars().take(160).collect::<String>()
    };
    let name = agent_spec(agent_id).map(|spec| spec.name).unwrap_or(agent_id);
    format!("Agent identity changed: {} moved from {} to {}. Confirm the new binary in Settings to continue.", name, short(old), short(new))
}

pub fn parse_agent_pins(raw: &str) -> HashMap<String, AgentPin> {
    serde_json::from_str::<HashMap<String, AgentPin>>(raw).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("muse-exec-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    fn write_exec(path: &Path, body: &[u8]) {
        std::fs::write(path, body).expect("fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }

    /// Non-temp scratch space (unit tests run with the package root as cwd,
    /// so `target/` is writable and outside every temp prefix). Absolute, so
    /// symlinks created inside resolve to real targets.
    fn workdir(tag: &str) -> PathBuf {
        let dir = std::env::current_dir()
            .expect("cwd")
            .join("target")
            .join(format!("muse-exec-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn symlink(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(target, link).expect("symlink");
    }

    #[test]
    fn temp_symlink_cannot_smuggle_a_binary() {
        // The SEC-02 bypass: the link lives outside temp and is named `muse`,
        // but its canonical target is a temp executable.
        let work = workdir("link");
        let target = std::env::temp_dir().join(format!("muse-smuggled-{}", std::process::id()));
        write_exec(&target, b"#!/bin/sh\necho hi\n");
        let link = work.join("muse");
        symlink(&target, &link);
        assert!(validate_exec(&link.to_string_lossy(), &muse_name_allowed, "Muse").is_err());
        // A directly named temp binary is rejected too.
        assert!(validate_exec(&target.to_string_lossy(), &muse_name_allowed, "Muse").is_err());
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn canonical_target_decides_the_name_check() {
        let work = workdir("name");
        // Misnamed canonical target behind an innocent link name: rejected.
        let evil = work.join("evil.sh");
        write_exec(&evil, b"#!/bin/sh\necho hi\n");
        let link = work.join("muse-link");
        symlink(&evil, &link);
        assert!(link.read_link().is_ok());
        assert!(validate_exec(&link.to_string_lossy(), &muse_name_allowed, "Muse").is_err());
        // Well-named canonical target behind any link name: accepted.
        let real = work.join("muse");
        write_exec(&real, b"#!/bin/sh\necho hi\n");
        let alias = work.join("totally-not-muse");
        symlink(&real, &alias);
        assert!(validate_exec(&alias.to_string_lossy(), &muse_name_allowed, "Muse").is_ok());
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn agent_links_may_resolve_to_versioned_downloads() {
        // Vendor layout: ~/.grok/bin/grok -> ../downloads/grok-<ver>-<platform>.
        let work = workdir("agent-versioned");
        let names = vec!["grok".to_string()];
        let target = work.join("grok-1.0.40-macos-aarch64");
        write_exec(&target, b"#!/bin/sh\necho hi\n");
        let link = work.join("grok");
        symlink(&target, &link);
        assert!(validate_exec(&link.to_string_lossy(), &agent_name_allowed(&names), "The Grok CLI").is_ok());
        // A same-prefix foreign name and a foreign target still fail.
        let helper = work.join("grokhelper");
        write_exec(&helper, b"#!/bin/sh\necho hi\n");
        let alias = work.join("grok-alias");
        symlink(&helper, &alias);
        assert!(validate_exec(&helper.to_string_lossy(), &agent_name_allowed(&names), "The Grok CLI").is_err());
        assert!(validate_exec(&alias.to_string_lossy(), &agent_name_allowed(&names), "The Grok CLI").is_err());
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn non_files_and_non_executables_are_rejected() {
        let dir = fixture("somedir");
        let _ = std::fs::create_dir_all(&dir);
        assert!(validate_exec(&dir.to_string_lossy(), &|_| true, "Thing").is_err());
        let plain = fixture("plain.txt");
        std::fs::write(&plain, b"nope").expect("fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).expect("chmod");
            assert!(validate_exec(&plain.to_string_lossy(), &|_| true, "Thing").is_err());
        }
        assert!(validate_exec("", &|_| true, "Thing").is_err());
        assert!(validate_exec("/definitely/not/here-12345", &|_| true, "Thing").is_err());
        let _ = std::fs::remove_file(&plain);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn digest_pins_detect_replacement() {
        let bin = fixture("pinned-bin");
        write_exec(&bin, b"version one");
        let canon = bin.canonicalize().expect("canon");
        let pins = ExecPins::new();
        assert!(pins.check(&canon, "Thing").is_ok());
        assert!(pins.check(&canon, "Thing").is_ok());
        write_exec(&bin, b"version two!!");
        let err = pins.check(&canon, "Thing").unwrap_err();
        assert!(err.contains("replaced"), "{err}");
        let _ = std::fs::remove_file(&bin);
    }

    #[test]
    fn sha256_matches_known_vector() {
        let file = fixture("vector.txt");
        std::fs::write(&file, b"abc").expect("fixture");
        assert_eq!(
            sha256_file(&file).expect("digest"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn agent_pins_record_first_sighting_and_flag_changes() {
        let one = fixture("agent-one");
        let two = fixture("agent-two");
        write_exec(&one, b"one");
        write_exec(&two, b"two");
        let pins = AgentPins::new(HashMap::new());
        let canon_one = one.canonicalize().expect("canon");
        assert!(pins.check("opencode", &canon_one, Some("1.0".into())).is_ok());
        // Same binary again: fine, version refreshes.
        assert!(pins.check("opencode", &canon_one, Some("1.1".into())).is_ok());
        assert_eq!(pins.get("opencode").and_then(|pin| pin.version), Some("1.1".into()));
        // A newly shadowing entry (different path) fails with the detectable prefix.
        let canon_two = two.canonicalize().expect("canon");
        let err = pins.check("opencode", &canon_two, Some("1.1".into())).unwrap_err();
        assert!(err.starts_with("Agent identity changed"), "{err}");
        // Same path, replaced bytes: also flagged.
        write_exec(&one, b"one!!!");
        let err = pins.check("opencode", &canon_one, Some("1.1".into())).unwrap_err();
        assert!(err.starts_with("Agent identity changed"), "{err}");
        // Confirming the resolver's binary re-pins and proceeds.
        pins.confirm("opencode", &canon_two, Some("2.0".into())).expect("confirm");
        assert!(pins.check("opencode", &canon_two, Some("2.0".into())).is_ok());
        let _ = std::fs::remove_file(&one);
        let _ = std::fs::remove_file(&two);
    }

    #[test]
    fn corrupt_pin_store_loads_empty() {
        assert!(parse_agent_pins("not json").is_empty());
        assert!(parse_agent_pins("{}").is_empty());
    }

    #[test]
    fn version_probe_times_out_on_hung_binaries() {
        #[cfg(unix)]
        {
            let hung = fixture("hung-bin");
            write_exec(&hung, b"#!/bin/sh\nsleep 30\n");
            assert!(probe_version(&hung).is_none());
            let _ = std::fs::remove_file(&hung);
        }
    }
}
