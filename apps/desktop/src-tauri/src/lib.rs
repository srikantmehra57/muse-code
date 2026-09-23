use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

mod credentials;
mod dto;
mod exec;
mod framing;
mod process;

static SECURITY_AUDIT: OnceLock<PathBuf> = OnceLock::new();
static APP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

fn write_security_audit(line: &str) -> Result<(), String> {
    let path = SECURITY_AUDIT.get().ok_or("Security audit log is unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("Could not create audit directory: {err}"))?;
    }
    use std::fs::OpenOptions;
    let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(|err| format!("Could not open audit log: {err}"))?;
    let safe = redact_log_detail(line).replace(['\n', '\r'], " ");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs().to_string())
        .unwrap_or_else(|_| "0".into());
    writeln!(file, "{timestamp}\t{safe}").map_err(|err| format!("Could not write audit log: {err}"))
}

struct Bridge {
    child: Child,
    stdin: ChildStdin,
}

struct AppState {
    bridge: Mutex<Option<Bridge>>,
    /// Native workspace grants: id -> canonical root. Minted ONLY by the
    /// native folder picker (or loaded from the keyring entry the renderer
    /// cannot write); the renderer can reference an id but never create or
    /// widen one.
    grants: Mutex<HashMap<String, PathBuf>>,
    /// Live session bindings: MSP/ACP session id -> grant id. Learned ONLY by
    /// snooping bridge responses for calls the native side authorized, so a
    /// renderer-nominated session id outside every grant stays unusable.
    sessions: Mutex<HashMap<String, String>>,
    /// Live approval ownership: approval id -> (session id, grant id).
    /// Snooped from `approval` events; `decideApproval` must present the
    /// owning session, since the bridge itself ignores the session field.
    approvals: Mutex<HashMap<String, (String, String)>>,
    /// In-flight bridge calls awaiting a response, for grant attribution.
    pending: Mutex<HashMap<String, PendingCall>>,
    dropped_paths: Mutex<HashSet<PathBuf>>,
    /// One-time install authorizations: folders the USER chose in a native
    /// picker. `skill_install` / `plugin_install` accept exactly these paths
    /// and consume them, so a compromised renderer can reference a pick but
    /// never nominate an arbitrary directory to install from.
    picked_installs: Mutex<HashSet<PathBuf>>,
    /// SHA-256 pins for every spawned executable (sidecar, muse, agent CLIs).
    exec_pins: exec::ExecPins,
    /// Cross-restart ACP identity pins (path + digest per agent).
    agent_pins: exec::AgentPins,
}

impl AppState {
    fn new() -> Self {
        AppState {
            bridge: Mutex::new(None),
            grants: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            dropped_paths: Mutex::new(HashSet::new()),
            picked_installs: Mutex::new(HashSet::new()),
            exec_pins: exec::ExecPins::new(),
            agent_pins: exec::AgentPins::new(HashMap::new()),
        }
    }
}

struct PendingCall {
    method: String,
    grant_id: Option<String>,
    sent_at: Instant,
}

const BRIDGE_METHODS: &[&str] = &[
    "ping",
    "detect",
    "status",
    "startHost",
    "stopHost",
    "listSessions",
    "listModels",
    "startSession",
    "resumeSession",
    "forkSession",
    "compactSession",
    "readSession",
    "pageHistory",
    "listSkills",
    "mcpServers",
    "userShell",
    "readOutput",
    "setReasoningEffort",
    "subagentControl",
    "taskControl",
    "workflowControl",
    "goalControl",
    "sendTurn",
    "steerTurn",
    "unqueueTurn",
    "cancelTurn",
    "respondUserInput",
    "decideApproval",
    "setApprovalMode",
    "setModel",
    "listAgents",
    "setSessionOption",
    "usage",
    "startLogin",
    "cancelLogin",
    "renameSession",
];

const DIFF_LIMIT: usize = 1_500_000;
const APP_LOG_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_PENDING_CALLS: usize = 512;

/// Unguessable grant handle: `wg-` + a v4 UUID from the OS CSPRNG.
fn mint_grant_id() -> String {
    format!("wg-{}", uuid::Uuid::new_v4().simple())
}

fn valid_grant_id(id: &str) -> bool {
    id.len() == 35 && id.starts_with("wg-") && id[3..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredGrants {
    #[serde(default)]
    grants: Vec<StoredGrant>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredGrant {
    id: String,
    path: String,
}

fn parse_grants(raw: &str) -> HashMap<String, PathBuf> {
    let Ok(stored) = serde_json::from_str::<StoredGrants>(raw) else {
        return HashMap::new();
    };
    stored
        .grants
        .into_iter()
        .filter(|grant| valid_grant_id(&grant.id))
        .filter_map(|grant| {
            let root = PathBuf::from(&grant.path);
            // Re-canonicalize on load: stale entries (deleted folders, broken
            // links) fail closed instead of authorizing a ghost path.
            root.canonicalize().ok().map(|canon| (grant.id, canon))
        })
        .collect()
}

fn render_grants(grants: &HashMap<String, PathBuf>) -> Result<String, String> {
    let stored = StoredGrants {
        grants: grants.iter().map(|(id, root)| StoredGrant { id: id.clone(), path: root.to_string_lossy().into_owned() }).collect(),
    };
    serde_json::to_string(&stored).map_err(|err| err.to_string())
}

fn load_grants() -> HashMap<String, PathBuf> {
    match credentials::grants_value() {
        Ok(Some(raw)) => parse_grants(&raw),
        Ok(None) => HashMap::new(),
        Err(err) => {
            eprintln!("workspace grants unavailable: {err}");
            HashMap::new()
        }
    }
}

/// Returns the failure reason when the grant table could not reach the keyring;
/// callers surface it, because an unpersisted grant dies with the process.
fn persist_grants(grants: &HashMap<String, PathBuf>) -> Option<String> {
    match render_grants(grants).and_then(|raw| credentials::grants_store(&raw)) {
        Ok(()) => None,
        Err(err) => {
            eprintln!("could not persist workspace grants: {err}");
            Some(err)
        }
    }
}

/// Resolve a grant id to its canonical root. Unknown or malformed ids fail
/// closed, as do roots that vanished since grant time.
fn grant_root(state: &AppState, grant_id: &str) -> Result<PathBuf, String> {
    if !valid_grant_id(grant_id) {
        return Err("Unknown workspace grant. Re-open the folder to restore access.".into());
    }
    let grants = state.grants.lock().map_err(|err| err.to_string())?;
    let root = grants.get(grant_id).cloned().ok_or_else(|| "Unknown workspace grant. Re-open the folder to restore access.".to_string())?;
    if !root.exists() {
        return Err("Workspace folder no longer exists. Re-open the folder to restore access.".into());
    }
    Ok(root)
}

/// Containment of `path` within one grant's root. Canonicalizes the candidate
/// so `..` segments and symlinks cannot escape the granted root.
fn path_within_grant(state: &AppState, grant_id: &str, path: &Path) -> Result<bool, String> {
    let root = grant_root(state, grant_id)?;
    let Ok(canon) = path.canonicalize() else {
        return Ok(false);
    };
    Ok(canon.starts_with(&root))
}

/// Session verbs take a renderer-nominated id; only bound ids may proceed.
fn require_session(state: &AppState, session_id: &str) -> Result<String, String> {
    if !valid_session_id(session_id) {
        return Err("That session reference is not valid.".into());
    }
    let sessions = state.sessions.lock().map_err(|err| err.to_string())?;
    sessions.get(session_id).cloned().ok_or_else(|| "That session is not connected to an open workspace. Reselect the workspace to reconnect.".to_string())
}

/// Record an in-flight call for response attribution. Returns false when the
/// id is already pending: ids are renderer-chosen, and a collision would
/// misattribute the response (and its session bindings) to the wrong grant.
fn track_pending(state: &AppState, id: &str, method: &str, grant_id: Option<String>) -> bool {
    let Ok(mut pending) = state.pending.lock() else { return false };
    if pending.len() >= MAX_PENDING_CALLS {
        pending.retain(|_, call| call.sent_at.elapsed() < Duration::from_secs(150));
    }
    if pending.contains_key(id) {
        return false;
    }
    pending.insert(id.to_string(), PendingCall { method: method.to_string(), grant_id, sent_at: Instant::now() });
    true
}

/// Attribute one bridge response line to its authorized call and bind any
/// sessions it carries. Best-effort by design: a malformed line must never
/// break the event relay, and a missing attribution binds nothing.
/// Lock order is grants -> sessions everywhere (see `remove_grant`), so the
/// liveness check and the insert below are atomic against revocation.
fn snoop_bridge_response(state: &AppState, value: &Value) {
    let (Some(id), Some(ok)) = (value.get("id").and_then(Value::as_str), value.get("ok").and_then(Value::as_bool)) else { return };
    let call = state.pending.lock().ok().and_then(|mut pending| pending.remove(id));
    let Some(call) = call else { return };
    let Some(grant_id) = call.grant_id else { return };
    if !ok {
        return;
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let mut session_ids = Vec::new();
    match call.method.as_str() {
        "startSession" | "resumeSession" | "forkSession" => {
            if let Some(session_id) = result.get("sessionId").and_then(Value::as_str) {
                session_ids.push(session_id.to_string());
            }
        }
        "listSessions" => {
            if let Some(rows) = result.get("sessions").and_then(Value::as_array) {
                for row in rows {
                    if let Some(session_id) = row.get("sessionId").and_then(Value::as_str) {
                        session_ids.push(session_id.to_string());
                    }
                }
            }
        }
        _ => return,
    }
    if session_ids.is_empty() {
        return;
    }
    let Ok(grants) = state.grants.lock() else { return };
    if !grants.contains_key(&grant_id) {
        return;
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        for session_id in session_ids.into_iter().filter(|id| valid_session_id(id)) {
            sessions.insert(session_id, grant_id.clone());
        }
    }
}

/// Track and prune approval ownership from bridge events. The bridge forwards
/// `decideApproval` by approval id alone, so native ownership is the only
/// thing stopping a cross-session (or post-revocation) decision.
fn snoop_bridge_event(state: &AppState, value: &Value) {
    let (Some(kind), Some(event)) = (value.get("type").and_then(Value::as_str), value.get("event").and_then(Value::as_str)) else { return };
    if kind != "event" {
        return;
    }
    match event {
        "approval" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let (Some(approval_id), Some(session_id)) = (
                payload.get("approvalId").and_then(Value::as_str),
                payload.get("sessionId").and_then(Value::as_str),
            ) else { return };
            if !valid_session_id(session_id) {
                return;
            }
            let bound = state.sessions.lock().ok().and_then(|sessions| sessions.get(session_id).cloned());
            if let (Some(grant_id), Ok(mut approvals)) = (bound, state.approvals.lock()) {
                approvals.insert(approval_id.to_string(), (session_id.to_string(), grant_id));
            }
        }
        "approvalAudit" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let approval_id = payload.get("approvalId").and_then(Value::as_str).unwrap_or("");
            let session_id = payload.get("sessionId").and_then(Value::as_str).unwrap_or("");
            let outcome = payload.get("outcome").and_then(Value::as_str).unwrap_or("decided");
            let choice_id = payload.get("choiceId").and_then(Value::as_str).unwrap_or("");
            if !approval_id.is_empty() {
                let _ = write_security_audit(&format!(
                    "approval\t{session_id}\t{approval_id}\t{outcome}\t{choice_id}"
                ));
            }
        }
        "approvalResolved" | "approvalError" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            if let (Some(approval_id), Ok(mut approvals)) = (payload.get("approvalId").and_then(Value::as_str), state.approvals.lock()) {
                approvals.remove(approval_id);
            }
        }
        "turnCompleted" | "turnError" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            if let (Some(session_id), Ok(mut approvals)) = (payload.get("sessionId").and_then(Value::as_str), state.approvals.lock()) {
                approvals.retain(|_, (owner, _)| owner != session_id);
            }
        }
        "hostStopping" | "hostExit" | "bridgeExit" | "connectionError" => {
            // Bridge-side waiter maps do not survive a host death; neither do ours.
            if let Ok(mut approvals) = state.approvals.lock() {
                approvals.clear();
            }
        }
        _ => {}
    }
}

/// Drop every binding owned (directly or via its session) by a revoked grant.
/// Called after the grant leaves the map; the snoop path holds the grants
/// lock across its check+insert, so a response racing revocation either lands
/// first (and is dropped here) or sees the grant gone (and binds nothing).
fn drop_grant_bindings(state: &AppState, grant_id: &str) {
    let Ok(sessions) = state.sessions.lock() else { return };
    let owned: Vec<String> = sessions.iter().filter(|(_, bound)| bound.as_str() == grant_id).map(|(id, _)| id.clone()).collect();
    drop(sessions);
    if owned.is_empty() {
        return;
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        for id in &owned {
            sessions.remove(id);
        }
    }
    if let Ok(mut approvals) = state.approvals.lock() {
        approvals.retain(|_, (owner, _)| !owned.contains(owner));
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub branch: String,
    pub dirty: bool,
    pub files: Vec<GitFile>,
    pub diff: String,
    pub truncated: bool,
}

/// GUI-launched apps do not inherit the user's shell PATH, so Homebrew,
/// ~/.local/bin, nvm, and similar installs are invisible to a bare `which`.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.extend([
            home.join(".local/bin"),
            home.join(".muse/bin"),
            home.join(".volta/bin"),
            home.join(".asdf/shims"),
            home.join(".nodenv/shims"),
            home.join(".nvm/current/bin"),
            home.join(".local/share/mise/shims"),
            home.join(".local/share/fnm/aliases/default/bin"),
            home.join("AppData/Local/muse"),
            home.join("AppData/Local/Programs/muse"),
            home.join("AppData/Local/Programs/nodejs"),
            home.join("AppData/Roaming/npm"),
            home.join("scoop/shims"),
        ]);
    }
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/opt/node/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/opt/node/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
    ]);
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(root) = std::env::var(key) {
            dirs.push(PathBuf::from(root).join("nodejs"));
        }
    }
    dirs
}

fn augmented_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = extra_bin_dirs().into_iter().filter(|path| path.is_dir()).collect();
    if let Some(current) = std::env::var_os("PATH") {
        for part in std::env::split_paths(&current) {
            if !part.as_os_str().is_empty() && !dirs.contains(&part) {
                dirs.push(part);
            }
        }
    }
    std::env::join_paths(&dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", augmented_path());
    cmd
}

/// Resolve the Muse CLI to a canonical pinned path. Custom paths validate the
/// canonical target (name, temp, regular executable file); an empty request
/// searches the augmented PATH. Every winner pins its SHA-256 digest, so a
/// same-path replacement between spawns fails closed.
fn resolve_muse_bin(state: &AppState, requested: &str) -> Result<PathBuf, String> {
    let found = if !requested.trim().is_empty() {
        PathBuf::from(requested)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        which::which_in("muse", Some(augmented_path()), cwd)
            .map_err(|_| "Muse CLI was not found. Install it or set its path in Settings.".to_string())?
    };
    let canonical = exec::validate_exec(&found.to_string_lossy(), &exec::muse_name_allowed, "The Muse CLI")?;
    state.exec_pins.check(&canonical, "The Muse CLI")?;
    Ok(canonical)
}

/// Resolve the Muse binary natively and overwrite the renderer string with the
/// canonical pinned path. A custom path validates or fails the call; an absent
/// path resolves via the augmented PATH and injects when found, otherwise the
/// bridge reports "not found" itself as before.
fn inject_muse_bin(state: &AppState, params: &mut Value) -> Result<(), String> {
    let requested = params.get("museBin").and_then(Value::as_str).unwrap_or("").to_string();
    let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
    if !requested.trim().is_empty() {
        let canonical = resolve_muse_bin(state, &requested)?;
        object.insert("museBin".into(), Value::String(canonical.to_string_lossy().into_owned()));
        return Ok(());
    }
    match resolve_muse_bin(state, "") {
        Ok(canonical) => {
            object.insert("museBin".into(), Value::String(canonical.to_string_lossy().into_owned()));
        }
        Err(_) => {
            object.remove("museBin");
        }
    }
    Ok(())
}

/// Resolve an ACP agent binary natively, verify its pinned identity, and
/// inject the canonical path for the bridge to spawn. The bridge never
/// resolves agent paths itself when this field is present, so a newly
/// shadowing PATH entry cannot redirect a spawn without confirmation.
fn inject_agent_bin(state: &AppState, params: &mut Value) -> Result<(), String> {
    let agent_id = params.get("agentId").and_then(Value::as_str).unwrap_or("").to_string();
    if agent_id.is_empty() || agent_id == "muse" {
        return Ok(());
    }
    if !credentials::acp_consent_value().unwrap_or(false) {
        return Err("Third-party agents run without an OS sandbox. Confirm that in Settings → Agents before using them.".into());
    }
    let spec = exec::agent_spec(&agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    let canonical = exec::resolve_agent_bin(spec)?;
    state.exec_pins.check(&canonical, &format!("The {} CLI", spec.name))?;
    let version = exec::probe_version(&canonical);
    state.agent_pins.check(&agent_id, &canonical, version)?;
    persist_agent_pins(state);
    let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
    object.insert("agentBin".into(), Value::String(canonical.to_string_lossy().into_owned()));
    Ok(())
}

fn load_agent_pins() -> HashMap<String, exec::AgentPin> {
    match credentials::agent_pins_value() {
        Ok(Some(raw)) => exec::parse_agent_pins(&raw),
        Ok(None) => HashMap::new(),
        Err(err) => {
            eprintln!("agent pins unavailable: {err}");
            HashMap::new()
        }
    }
}

fn persist_agent_pins(state: &AppState) {
    let snapshot = state.agent_pins.snapshot();
    match serde_json::to_string(&snapshot) {
        Ok(raw) => {
            if let Err(err) = credentials::agent_pins_store(&raw) {
                eprintln!("could not persist agent pins: {err}");
            }
        }
        Err(err) => eprintln!("could not persist agent pins: {err}"),
    }
}

/// Debug builds run the bridge from the working tree through the developer's
/// Node; release builds never touch an ambient runtime (SEC-02).
#[cfg(debug_assertions)]
fn node_bin() -> Result<PathBuf, String> {
    which::which("node")
        .or_else(|_| {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            which::which_in("node", Some(augmented_path()), cwd)
        })
        .map_err(|_| {
            "Node.js 20+ is required to run the Muse protocol bridge in development. Install Node and restart the app."
                .to_string()
        })
}

#[cfg(debug_assertions)]
fn bridge_script<R: Runtime>(_app: &AppHandle<R>) -> Result<PathBuf, String> {
    // Test seam (debug builds only): integration tests point the bridge at a
    // fixture script. Release builds resolve the digest-verified resource and
    // never consult this variable.
    if let Ok(custom) = std::env::var("MUSE_BRIDGE_SCRIPT") {
        let path = PathBuf::from(&custom);
        if path.is_file() {
            return Ok(path);
        }
    }
    let dev =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/muse-bridge/dist/index.js");
    if dev.exists() {
        return Ok(dev);
    }
    Err("Bridge script missing: run `npm run build:bridge` first.".into())
}

/// Release resolves the packaged resource and verifies it against the digest
/// baked at compile time, so a swapped script fails before it ever runs.
#[cfg(not(debug_assertions))]
fn bridge_script<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let script = app
        .path()
        .resolve("muse-bridge/index.js", BaseDirectory::Resource)
        .map_err(|err| err.to_string())?;
    verify_bridge_script(&script)?;
    Ok(script)
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn verify_bridge_script(script: &Path) -> Result<(), String> {
    const BAKED: &str = env!("BRIDGE_SCRIPT_SHA256");
    if BAKED == "none" {
        return Err("Bridge script digest missing from this build. Reinstall the app.".into());
    }
    let digest = exec::sha256_file(script).map_err(|_| "The Muse bridge script is missing from the installation. Reinstall the app.".to_string())?;
    if digest != BAKED {
        return Err("The Muse bridge script does not match this installation. Reinstall the app.".into());
    }
    Ok(())
}

/// Tauri strips the target triple from externalBin when installing a bundle.
/// The staging file has a target suffix; the runtime beside the app does not.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn sidecar_file_name() -> &'static str {
    if cfg!(target_os = "windows") { "muse-node.exe" } else { "muse-node" }
}

/// Locate the bundled bridge runtime next to the app binary and validate it:
/// a real executable file (never a symlink planted beside the app), pinned by
/// digest for the process lifetime. Bundle signing/notarization is the outer
/// integrity layer; this check is the inner one.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn sidecar_path(state: &AppState) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| format!("Could not locate the app binary: {err}"))?;
    let dir = exe.parent().ok_or("Could not locate the app binary directory")?;
    let candidate = dir.join(sidecar_file_name());
    let name = sidecar_file_name();
    let canonical = exec::validate_exec(
        &candidate.to_string_lossy(),
        &|file| file == name,
        "The Muse bridge runtime",
    )
    .map_err(|_| format!("The Muse bridge runtime is missing from the installation ({}). Reinstall the app.", sidecar_file_name()))?;
    state.exec_pins.check(&canonical, "The Muse bridge runtime")?;
    Ok(canonical)
}

fn spawn_bridge_stdio<R: Runtime>(mut child: Child, app: &AppHandle<R>) -> Result<Bridge, String> {
    let stdout = child.stdout.take().ok_or("Bridge stdout missing")?;
    let stderr = child.stderr.take().ok_or("Bridge stderr missing")?;
    let stdin = child.stdin.take().ok_or("Bridge stdin missing")?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(line)) = framing::read_line(&mut reader, framing::MAX_FRAME_BYTES, false) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                snoop_bridge_response(&handle.state::<AppState>(), &value);
                snoop_bridge_event(&handle.state::<AppState>(), &value);
                let _ = handle.emit("bridge-line", value);
            }
        }
        let _ = handle.emit("bridge-line", json!({ "type": "event", "event": "bridgeExit", "payload": {} }));
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut private_key = false;
        while let Ok(Some(line)) = framing::read_line(&mut reader, framing::MAX_LOG_BYTES, true) {
            if let Some(safe) = redact_stderr_line(&line, &mut private_key) {
                eprintln!("[muse-bridge] {safe}");
            }
        }
    });
    Ok(Bridge { child, stdin })
}

fn spawn_bridge<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<Bridge, String> {
    #[cfg(debug_assertions)]
    {
        let _ = state;
        let node = node_bin()?;
        let script = bridge_script(app)?;
        let mut cmd = command(node);
        cmd.arg(script);
        process::isolate_command(&mut cmd);
        cmd.env("PATH", augmented_path());
        let child = cmd.spawn().map_err(|err| format!("Failed to start Muse bridge: {err}"))?;
        process::track_child(&child);
        return spawn_bridge_stdio(child, app);
    }
    #[cfg(not(debug_assertions))]
    {
        // Release: the bundled runtime + verified script only. No ambient
        // Node lookup anywhere on this path.
        let runtime = sidecar_path(state)?;
        let script = bridge_script(app)?;
        let mut cmd = command(runtime);
        cmd.arg(script);
        process::isolate_command(&mut cmd);
        cmd.env("PATH", augmented_path());
        let child = cmd.spawn().map_err(|err| format!("Failed to start Muse bridge: {err}"))?;
        process::track_child(&child);
        return spawn_bridge_stdio(child, app);
    }
}

fn ensure_bridge<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<(), String> {
    let mut guard = state.bridge.lock().map_err(|err| err.to_string())?;
    let exited = if let Some(bridge) = guard.as_mut() { bridge.child.try_wait().map_err(|err| err.to_string())?.is_some() } else { false };
    if exited { *guard = None; }
    if guard.is_none() { *guard = Some(spawn_bridge(app, state)?); }
    Ok(())
}

#[tauri::command]
fn bridge_request<R: Runtime>(app: AppHandle<R>, state: State<AppState>, id: String, method: String, params: Value) -> Result<Value, String> {
    if !BRIDGE_METHODS.contains(&method.as_str()) {
        return Err(format!("Unsupported bridge method: {method}"));
    }
    // Typed boundary (SEC-01): reject malformed params before any grant check
    // or bridge spawn, and forward only the canonical shape from here on.
    dto::validate_request_id(&id)?;
    let mut params = dto::validate_params(&method, &params)?;
    // Executable identity (SEC-02): the native side resolves every binary and
    // overwrites renderer strings with canonical pinned paths before the
    // bridge spawns anything.
    if matches!(method.as_str(), "detect" | "listAgents" | "status" | "startHost" | "startLogin") {
        inject_muse_bin(&state, &mut params)?;
    }
    if matches!(
        method.as_str(),
        "startHost"
            | "stopHost"
            | "listSessions"
            | "listModels"
            | "startSession"
            | "resumeSession"
            | "forkSession"
            | "compactSession"
            | "readSession"
            | "pageHistory"
            | "listSkills"
            | "mcpServers"
            | "readOutput"
            | "setReasoningEffort"
            | "subagentControl"
            | "taskControl"
            | "workflowControl"
            | "goalControl"
            | "sendTurn"
            | "steerTurn"
            | "unqueueTurn"
            | "cancelTurn"
            | "setModel"
            | "setSessionOption"
    ) {
        inject_agent_bin(&state, &mut params)?;
    }
    if matches!(method.as_str(), "detect" | "status" | "startHost") {
        let key = credentials::credential_value()?.unwrap_or_default();
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("museApiKey".into(), Value::String(key));
    }
    // Trust boundary: session verbs carry renderer-nominated ids/paths, so the
    // native side resolves every grant itself and injects the canonical root.
    // A grant that cannot be resolved fails the call before the bridge spawns.
    let mut call_grant: Option<String> = None;
    if method == "startSession" {
        let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string();
        let root = grant_root(&state, &grant_id)?;
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
        call_grant = Some(grant_id);
    }
    // `listSessions` without a grant lists every workspace (metadata only,
    // like the CLI picker); the rows bind to no grant, so opening one still
    // requires a grant-scoped listing first.
    if method == "listSessions" {
        let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string();
        if !grant_id.is_empty() {
            let root = grant_root(&state, &grant_id)?;
            let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
            object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
            call_grant = Some(grant_id);
        }
    }
    if method == "resumeSession" {
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let grant_id = require_session(&state, session_id)?;
        // ACP resume takes a workspace root for its cwd: always substitute the
        // bound grant's root, so a nominated path can never widen the resume
        // and a missing one can never silently empty the cwd. (Muse resume
        // ignores the extra field.)
        let root = grant_root(&state, &grant_id)?;
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
        call_grant = Some(grant_id);
    }
    if method == "decideApproval" {
        // The bridge routes by approval id alone, so the native side must tie
        // the approval to the presented session: otherwise any bound session
        // could decide any other session's approval — including approvals from
        // workspaces whose grant was already revoked.
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let approval_id = params.get("approvalId").and_then(Value::as_str).unwrap_or("");
        let grant_id = require_session(&state, session_id)?;
        let approvals = state.approvals.lock().map_err(|err| err.to_string())?;
        match approvals.get(approval_id) {
            Some((owner, grant)) if owner == session_id && grant == &grant_id => {}
            _ => return Err("That approval does not belong to this session.".into()),
        }
    }
    if matches!(method.as_str(), "forkSession" | "compactSession" | "readSession" | "pageHistory" | "listSkills" | "userShell" | "readOutput" | "setReasoningEffort" | "subagentControl" | "taskControl" | "workflowControl" | "goalControl" | "sendTurn" | "steerTurn" | "unqueueTurn" | "cancelTurn" | "respondUserInput" | "setApprovalMode" | "setModel" | "setSessionOption" | "renameSession") {
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        require_session(&state, session_id)?;
    }
    if method == "listModels" {
        if let Some(session_id) = params.get("sessionId").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            require_session(&state, session_id)?;
        }
    }
    if method == "forkSession" {
        // The fork inherits its source's workspace: bind the new session id
        // to the source's grant when the response lands.
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        call_grant = Some(require_session(&state, session_id)?);
    }
    if matches!(method.as_str(), "startSession" | "resumeSession" | "forkSession" | "listSessions") {
        if !track_pending(&state, &id, &method, call_grant) {
            return Err("Duplicate in-flight request id. Retry the call.".into());
        }
    }
    ensure_bridge(&app, &state)?;
    dto::strip_native_fields(&method, &mut params);
    let deadline_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64 + 120_000)
        .unwrap_or(0);
    let payload = json!({ "id": id, "method": method, "params": params, "deadlineMs": deadline_ms }).to_string();
    if payload.len() > framing::MAX_FRAME_BYTES {
        state.pending.lock().map_err(|err| err.to_string())?.remove(&id);
        return Err("Request exceeds the protocol byte limit. Reduce attachments and retry.".into());
    }
    {
        let mut guard = state.bridge.lock().map_err(|err| err.to_string())?;
        let bridge = guard.as_mut().ok_or("Bridge is not running")?;
        writeln!(bridge.stdin, "{payload}").map_err(|err| err.to_string())?;
        bridge.stdin.flush().map_err(|err| err.to_string())?;
    }
    Ok(json!({ "id": id }))
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// `git` with piped stdin (for `git apply`); the patch always comes from a
/// fresh `git diff` the native side ran itself, never from the renderer.
fn run_git_stdin(cwd: &Path, args: &[&str], input: &str) -> Result<String, String> {
    use std::io::Write;
    let mut child = command("git")
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("git failed: {err}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "git failed: stdin unavailable".to_string())?
        .write_all(input.as_bytes())
        .map_err(|err| format!("git failed: {err}"))?;
    let output = child.wait_with_output().map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_numstat_z(raw: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut counts = std::collections::HashMap::<String, (u32, u32)>::new();
    let parts: Vec<&str> = raw.split('\0').filter(|part| !part.is_empty()).collect();
    let mut index = 0;
    while index < parts.len() {
        let line = parts[index];
        let mut tabs = line.splitn(3, '\t');
        let added = tabs.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        let removed = tabs.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        let mut path = tabs.next().unwrap_or("").to_string();
        if path.is_empty() && index + 2 < parts.len() {
            path = parts[index + 2].to_string();
            index += 2;
        }
        if let Some((_, next)) = path.split_once(" => ") {
            path = next.to_string();
        }
        counts.insert(path.trim_matches('"').to_string(), (added, removed));
        index += 1;
    }
    counts
}

/// `git status --porcelain -z` entries as (path, status). Renames and copies are
/// followed by an extra NUL-separated entry holding the original path, which is skipped.
fn parse_porcelain_z(raw: &str) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut entries = raw.split('\0');
    while let Some(line) = entries.next() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let path = line[3..].to_string();
        if status.contains('R') || status.contains('C') {
            entries.next();
        }
        files.push((path, status));
    }
    files
}

#[tauri::command]
fn git_snapshot(state: State<AppState>, grant_id: String) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    git_snapshot_for(&cwd)
}

fn git_snapshot_for(cwd: &Path) -> Result<GitSnapshot, String> {
    if !cwd.exists() {
        return Err("Workspace folder no longer exists".into());
    }
    let porcelain = run_git(&cwd, &["status", "--porcelain", "-z"])?;
    let branch = run_git(&cwd, &["symbolic-ref", "--short", "HEAD"])
        .or_else(|_| run_git(&cwd, &["rev-parse", "--short", "HEAD"]))?
        .trim().to_string();
    let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let numstat = if has_head { run_git(&cwd, &["diff", "--numstat", "-z", "HEAD"])? } else { run_git(&cwd, &["diff", "--numstat", "-z", "--cached"])? };
    let mut diff = if has_head { run_git(&cwd, &["diff", "HEAD"])? } else { format!("{}{}", run_git(&cwd, &["diff", "--cached"])?, run_git(&cwd, &["diff"])?) };
    let truncated = diff.len() > DIFF_LIMIT;
    if truncated {
        diff.truncate(DIFF_LIMIT);
        diff.push_str("\n…truncated");
    }
    let counts = parse_numstat_z(&numstat);
    let mut files = Vec::new();
    for (file_path, status) in parse_porcelain_z(&porcelain) {
        let (added, removed) = counts.get(&file_path).copied().unwrap_or((0, 0));
        files.push(GitFile {
            path: file_path,
            status,
            added,
            removed,
        });
    }
    Ok(GitSnapshot {
        dirty: !files.is_empty(),
        files,
        diff,
        truncated,
        branch: if branch.is_empty() { "HEAD".into() } else { branch },
    })
}

const FILE_INDEX_LIMIT: usize = 20_000;
/// Dirs the fallback walk never descends into: VCS metadata, dependency and
/// build outputs, tooling caches, and every dot-directory.
const FILE_INDEX_SKIP: &[&str] = &[".git", "node_modules", "target", "dist", ".tooling"];

/// Repo-relative forward-slash paths for @-mentions: `git ls-files` (tracked +
/// untracked-but-not-ignored) when the grant is a repo, else a bounded walk.
#[tauri::command]
fn list_workspace_files(state: State<AppState>, grant_id: String) -> Result<Vec<String>, String> {
    let root = grant_root(&state, &grant_id)?;
    workspace_files_for(&root)
}

fn workspace_files_for(root: &Path) -> Result<Vec<String>, String> {
    if !root.exists() {
        return Err("Workspace folder no longer exists".into());
    }
    if let Ok(listed) = run_git(root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"]) {
        let mut files: Vec<String> = listed.split('\0').filter(|entry| !entry.is_empty()).take(FILE_INDEX_LIMIT).map(str::to_string).collect();
        files.sort();
        return Ok(files);
    }
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') || FILE_INDEX_SKIP.contains(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if let Ok(relative) = entry.path().strip_prefix(root) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
                if files.len() >= FILE_INDEX_LIMIT {
                    files.sort();
                    return Ok(files);
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

const DISCARD_PATH_LIMIT: usize = 200;
const DISCARD_PATH_LEN: usize = 1024;

/// Confine a renderer-supplied discard path to the granted repo: it must be a
/// short repo-relative path with no `..` escape. Existing files additionally
/// resolve canonically so a symlink inside the repo cannot redirect the
/// discard outside it; deleted files (which cannot canonicalize) rely on the
/// lexical check plus git's own pathspec confinement to the repo.
fn discard_path(cwd: &Path, raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > DISCARD_PATH_LEN || raw.contains('\0') {
        return Err("That file path is not valid for discard.".into());
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute()
        || candidate.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)))
    {
        return Err("That file path is not valid for discard.".into());
    }
    let joined = cwd.join(candidate);
    if joined.symlink_metadata().is_ok() {
        let canon = joined.canonicalize().map_err(|_| "That file is no longer available.".to_string())?;
        if !canon.starts_with(cwd) {
            return Err("Discarding files is limited to the current workspace.".into());
        }
    }
    Ok(raw.to_string())
}

/// Discard working-tree changes for listed repo-relative paths: tracked files
/// restore from HEAD (unstaging first), untracked files are removed, ignored
/// files are never touched. Unchanged paths are a silent no-op. Returns a
/// fresh snapshot so the dock re-renders from truth.
#[tauri::command]
fn git_discard_files(state: State<AppState>, grant_id: String, paths: Vec<String>) -> Result<GitSnapshot, String> {
    git_discard_files_inner(&state, &grant_id, paths)
}

fn git_discard_files_inner(state: &AppState, grant_id: &str, paths: Vec<String>) -> Result<GitSnapshot, String> {
    let cwd = grant_root(state, grant_id)?;
    if paths.is_empty() || paths.len() > DISCARD_PATH_LIMIT {
        return Err("Choose between 1 and 200 files to discard.".into());
    }
    let mut confined = Vec::with_capacity(paths.len());
    for raw in &paths {
        confined.push(discard_path(&cwd, raw)?);
    }
    // Literal pathspecs: a file literally named `*.txt` must not glob-match
    // its siblings. (Leading `-` names are already stopped by `--`.)
    let literal = |path: &str| format!(":(literal){path}");
    let scoped: Vec<String> = confined.iter().map(|path| literal(path)).collect();
    let mut status_args = vec!["status", "--porcelain", "-z", "--"];
    status_args.extend(scoped.iter().map(String::as_str));
    let porcelain = run_git(&cwd, &status_args)?;
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    let mut added_no_head = Vec::new();
    let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    for (file_path, status) in parse_porcelain_z(&porcelain) {
        if status == "??" {
            untracked.push(file_path);
        } else if !has_head && status == "A" {
            // Unborn HEAD: staged-new files have no HEAD version to restore.
            added_no_head.push(file_path);
        } else {
            tracked.push(file_path);
        }
    }
    if !tracked.is_empty() {
        let mut restore_args = if has_head { vec!["restore", "--staged", "--worktree", "--"] } else { vec!["restore", "--worktree", "--"] };
        let scoped: Vec<String> = tracked.iter().map(|path| literal(path)).collect();
        restore_args.extend(scoped.iter().map(String::as_str));
        run_git(&cwd, &restore_args)?;
    }
    for file_path in &added_no_head {
        let scoped = literal(file_path);
        run_git(&cwd, &["rm", "--cached", "-q", "--", scoped.as_str()])?;
        let target = cwd.join(file_path);
        if target.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
            std::fs::remove_file(&target).map_err(|err| format!("Could not discard {file_path}: {err}"))?;
        }
    }
    if !untracked.is_empty() {
        let mut clean_args = vec!["clean", "-fd", "--"];
        let scoped: Vec<String> = untracked.iter().map(|path| literal(path)).collect();
        clean_args.extend(scoped.iter().map(String::as_str));
        run_git(&cwd, &clean_args)?;
    }
    eprintln!("git discard: {} file(s) in grant {grant_id}", tracked.len() + untracked.len() + added_no_head.len());
    git_snapshot_for(&cwd)
}

/// Discard every uncommitted change in the granted repo (tracked restores,
/// untracked removals, ignored files preserved). The UI confirms before
/// invoking; this command performs no further prompting.
#[tauri::command]
fn git_discard_all(state: State<AppState>, grant_id: String) -> Result<GitSnapshot, String> {
    git_discard_all_inner(&state, &grant_id)
}

fn git_discard_all_inner(state: &AppState, grant_id: &str) -> Result<GitSnapshot, String> {
    let cwd = grant_root(state, grant_id)?;
    let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    if has_head {
        run_git(&cwd, &["restore", "--staged", "--worktree", "--", "."])?;
    } else {
        // Unborn HEAD: empty the index so staged-new files become untracked,
        // then clean removes them with the rest. Ignored files survive.
        run_git(&cwd, &["read-tree", "--empty"])?;
    }
    run_git(&cwd, &["clean", "-fd", "--", "."])?;
    eprintln!("git discard-all in grant {grant_id}");
    git_snapshot_for(&cwd)
}

/// Extract the `hunk`-th `@@` block (0-based, matching the renderer's
/// grouping) plus the file header as a standalone reverse-appliable patch.
/// `\ No newline` trailers stay with their hunk; a missing hunk fails with
/// a refresh hint instead of touching the tree.
fn single_hunk_patch(diff: &str, hunk: u32) -> Result<String, String> {
    let mut header: Vec<&str> = Vec::new();
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunks.push(vec![line]);
        } else if let Some(last) = hunks.last_mut() {
            last.push(line);
        } else {
            header.push(line);
        }
    }
    let picked = hunks.get(hunk as usize).ok_or_else(|| "That hunk is no longer available. Refresh the diff and retry.".to_string())?;
    let mut patch = header.join("\n");
    patch.push('\n');
    patch.push_str(&picked.join("\n"));
    patch.push('\n');
    Ok(patch)
}

/// Discard one hunk of a tracked file: unstage the file so the worktree
/// diff matches the dock's `git diff HEAD` view, then reverse-apply the
/// hunk the native side re-derived. Returns a fresh snapshot.
#[tauri::command]
fn git_discard_hunk(state: State<AppState>, grant_id: String, path: String, hunk: u32) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    let rel = discard_path(&cwd, &path)?;
    let scoped = format!(":(literal){rel}");
    let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    if has_head {
        run_git(&cwd, &["reset", "-q", "HEAD", "--", scoped.as_str()])?;
    }
    let diff = run_git(&cwd, &["diff", "-U3", "--", scoped.as_str()])?;
    let patch = single_hunk_patch(&diff, hunk)?;
    run_git_stdin(&cwd, &["apply", "-R", "--unidiff-zero", "--"], &patch)?;
    eprintln!("git discard-hunk {rel}#{hunk} in grant {grant_id}");
    git_snapshot_for(&cwd)
}

/// Stage or unstage paths. Unstaging on an unborn HEAD removes the paths
/// from the empty-tree index instead of resetting to a missing commit.
#[tauri::command]
fn git_stage(state: State<AppState>, grant_id: String, paths: Vec<String>, stage: bool) -> Result<GitSnapshot, String> {
    if paths.is_empty() {
        return Err("Pick at least one file.".into());
    }
    let cwd = grant_root(&state, &grant_id)?;
    let scoped: Vec<String> = paths.iter().map(|path| discard_path(&cwd, path).map(|rel| format!(":(literal){rel}"))).collect::<Result<_, _>>()?;
    let refs: Vec<&str> = scoped.iter().map(String::as_str).collect();
    if stage {
        let mut args = vec!["add", "--"];
        args.extend(refs);
        run_git(&cwd, &args)?;
    } else if run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        let mut args = vec!["reset", "-q", "HEAD", "--"];
        args.extend(refs);
        run_git(&cwd, &args)?;
    } else {
        let mut args = vec!["rm", "--cached", "-q", "--"];
        args.extend(refs);
        run_git(&cwd, &args)?;
    }
    eprintln!("git {} in grant {grant_id}", if stage { "stage" } else { "unstage" });
    git_snapshot_for(&cwd)
}

/// Commit staged changes with a message. Identity/hook failures surface
/// verbatim so the user can fix git config or hooks and retry.
#[tauri::command]
fn git_commit(state: State<AppState>, grant_id: String, message: String) -> Result<GitSnapshot, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Write a commit message first.".into());
    }
    if trimmed.len() > 2000 {
        return Err("Commit messages are limited to 2000 characters.".into());
    }
    let cwd = grant_root(&state, &grant_id)?;
    run_git(&cwd, &["commit", "-m", trimmed])?;
    eprintln!("git commit in grant {grant_id}");
    git_snapshot_for(&cwd)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrustSkill {
    name: String,
    description: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrustRules {
    path: String,
    excerpt: String,
    truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrustPreview {
    skills: Vec<TrustSkill>,
    rules: Option<TrustRules>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnterpriseSource {
    plane: String,
    source_class: String,
    state: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnterpriseStatus {
    generation: Option<String>,
    sources: Vec<EnterpriseSource>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillDetail {
    id: String,
    name: String,
    description: String,
    scope: String,
    activation: String,
    path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillEntry {
    id: String,
    name: String,
    description: String,
    scope: String,
    activation: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginEntry {
    id: String,
    version: Option<String>,
    description: String,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginCapability {
    id: String,
    kind: Option<String>,
    description: String,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginDetail {
    id: String,
    version: Option<String>,
    description: String,
    capabilities: Vec<PluginCapability>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FolderGrant {
    path: String,
    grant_id: String,
    /// None when the grant reached the keyring. Some(reason) when it only
    /// exists in memory, so the renderer can say the access dies on restart
    /// instead of the folder silently going ungranted at next launch.
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

/// Grant-minting core shared by the picker and tests: dedupe by canonical
/// root, mint an id, and persist — a keyring failure becomes a warning, never
/// a failed grant.
fn mint_grant(state: &AppState, canon: PathBuf) -> Result<FolderGrant, String> {
    let existing = state.grants.lock().map_err(|err| err.to_string())?.iter().find(|(_, root)| *root == &canon).map(|(id, _)| id.clone());
    if let Some(id) = existing {
        return Ok(FolderGrant { path: canon.to_string_lossy().into_owned(), grant_id: id, warning: None });
    }
    let id = mint_grant_id();
    let failed = {
        let mut grants = state.grants.lock().map_err(|err| err.to_string())?;
        grants.insert(id.clone(), canon.clone());
        persist_grants(&grants)
    };
    let warning = failed.map(|err| format!("{err} This folder works until you quit, then it has to be opened again."));
    Ok(FolderGrant { path: canon.to_string_lossy().into_owned(), grant_id: id, warning })
}

/// The ONLY minting point for workspace grants: a successful native folder
/// selection. Re-picking a granted root returns its existing id.
#[tauri::command]
async fn pick_folder(app: AppHandle, window: tauri::WebviewWindow) -> Result<Option<FolderGrant>, String> {
    let folder = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open a workspace")
        .blocking_pick_folder();
    let Some(path) = folder.and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    let canon = path.canonicalize().map_err(|err| format!("That folder cannot be opened: {err}"))?;
    let state = app.state::<AppState>();
    Ok(Some(mint_grant(&state, canon)?))
}

#[derive(Debug, Deserialize)]
struct GrantCheck {
    id: String,
    path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GrantVerdict {
    id: String,
    ok: bool,
    /// Canonical root, returned only for ids the caller already holds — lets
    /// the renderer heal a stale non-canonical path without a grant listing.
    path: Option<String>,
}

/// Verify-only reconciliation: the renderer submits the (id, path) pairs it
/// holds and learns which are live. There is deliberately no grant listing —
/// enumerating every id+path would hand any renderer script all capabilities.
#[tauri::command]
fn verify_grants(state: State<AppState>, entries: Vec<GrantCheck>) -> Result<Vec<GrantVerdict>, String> {
    let grants = state.grants.lock().map_err(|err| err.to_string())?;
    Ok(entries.into_iter().take(256).map(|entry| {
        // Compare canonically: a stale-but-same-directory path still verifies,
        // and the returned canonical root lets the renderer heal its string.
        let canon = PathBuf::from(&entry.path).canonicalize().ok();
        let root = grants.get(&entry.id);
        let ok = match (root, canon) {
            (Some(root), Some(canon)) => &canon == root,
            _ => false,
        };
        GrantVerdict { id: entry.id, ok, path: if ok { root.map(|root| root.to_string_lossy().into_owned()) } else { None } }
    }).collect())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentIdentity {
    agent_id: String,
    name: String,
    /// Canonical binary on disk, if installed.
    path: Option<String>,
    version: Option<String>,
    /// Whether an identity pin exists for this agent.
    pinned: bool,
    /// Pinned, but the binary on disk drifted (path or bytes changed).
    changed: bool,
}

fn agent_identity(state: &AppState, spec: &exec::AgentSpec) -> AgentIdentity {
    let resolved = exec::resolve_agent_bin(spec).ok();
    let version = resolved.as_deref().and_then(exec::probe_version);
    let digest = resolved.as_deref().and_then(|path| exec::sha256_file(path).ok());
    let pinned = state.agent_pins.get(spec.id);
    let changed = match (&pinned, &resolved, &digest) {
        (Some(pin), Some(path), Some(digest)) => {
            pin.path != path.to_string_lossy() || pin.sha256 != *digest
        }
        _ => false,
    };
    AgentIdentity {
        agent_id: spec.id.to_string(),
        name: spec.name.to_string(),
        path: resolved.map(|path| path.to_string_lossy().into_owned()),
        version,
        pinned: pinned.is_some(),
        changed,
    }
}

/// Display-only agent identities for Settings: canonical path, version, and
/// pin/drift state. Resolves without recording — first sighting pins when the
/// agent is actually used.
#[tauri::command]
fn agent_identities(state: State<AppState>) -> Result<Vec<AgentIdentity>, String> {
    Ok(exec::AGENTS
        .iter()
        .filter(|spec| spec.id != "muse")
        .map(|spec| agent_identity(&state, spec))
        .collect())
}

/// Confirm a drifted (or new) agent binary after the user reviewed its path.
/// The binary is resolved fresh from disk — the renderer confirms, never
/// nominates — then pinned and returned for display.
#[tauri::command]
fn confirm_agent_bin(state: State<AppState>, agent_id: String) -> Result<AgentIdentity, String> {
    let spec = exec::agent_spec(&agent_id).filter(|spec| spec.id != "muse").ok_or("Unknown agent.")?;
    let canonical = exec::resolve_agent_bin(spec)?;
    state.exec_pins.check(&canonical, &format!("The {} CLI", spec.name))?;
    let version = exec::probe_version(&canonical);
    state.agent_pins.confirm(&agent_id, &canonical, version)?;
    persist_agent_pins(&state);
    Ok(agent_identity(&state, spec))
}

/// Revoke a grant and drop every session and approval bound to it.
#[tauri::command]
fn remove_grant(state: State<AppState>, grant_id: String) -> Result<(), String> {
    if !valid_grant_id(&grant_id) {
        return Err("Unknown workspace grant.".into());
    }
    eprintln!("workspace grant revoked: {grant_id}");
    {
        let mut grants = state.grants.lock().map_err(|err| err.to_string())?;
        grants.remove(&grant_id);
        let _ = persist_grants(&grants);
    }
    drop_grant_bindings(&state, &grant_id);
    Ok(())
}

fn export_file_name(title: &str) -> String {
    let stem: String = title
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    format!("{}.json", if stem.is_empty() { "muse-session" } else { &stem })
}

/// Export uses Muse's canonical offline exporter. The destination comes from a
/// native save dialog inside this command, so the renderer never receives a
/// generic write-to-path primitive.
#[tauri::command]
async fn export_session(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    muse_bin: String,
    redacted: bool,
) -> Result<Option<String>, String> {
    if !valid_session_id(&session_id) {
        return Err("The session identifier is not valid for export.".into());
    }
    // Only sessions bound to a live grant may be exported: the id alone must
    // not reach into workspaces the user never opened (or already removed).
    require_session(&state, &session_id)?;
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(if redacted { "Export share-safe Muse session" } else { "Export raw Muse session" })
        .set_file_name(export_file_name(&title))
        .add_filter("Muse session export", &["json"])
        .blocking_save_file();
    let Some(path) = selected.and_then(|value| value.into_path().ok()) else {
        return Ok(None);
    };
    export_to_path(&state, &session_id, &path.to_string_lossy(), &muse_bin, redacted).map(Some)
}

/// The post-dialog half of `export_session`: session-binding gate, canonical
/// pinned binary, then `muse export`. Separated so tests exercise it without
/// a save dialog.
fn export_to_path(state: &AppState, session_id: &str, out: &str, muse_bin: &str, redacted: bool) -> Result<String, String> {
    if !valid_session_id(session_id) {
        return Err("The session identifier is not valid for export.".into());
    }
    // Only sessions bound to a live grant may be exported: the id alone must
    // not reach into workspaces the user never opened (or already removed).
    require_session(state, session_id)?;
    let bin = resolve_muse_bin(state, muse_bin)?;
    let mut args = vec!["export", "--session", session_id, "--out", out];
    if redacted {
        args.push("--redacted");
    }
    let output = command(bin)
        .args(args)
        .output()
        .map_err(|err| format!("Could not start Muse export: {err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.lines().next().unwrap_or("Muse export failed").trim();
        return Err(format!("Muse could not export this session: {detail}"));
    }
    Ok(out.to_string())
}

/// Full tool output the viewer offers to save: large enough for several
/// `item/readOutput` pages, small enough to keep one dialog write sane.
const OUTPUT_SAVE_LIMIT: usize = 32 * 1024 * 1024;

/// Trusted-content preview for the workspace trust decision: the project
/// skills the host would load plus the workspace rules file. Grant-gated
/// and read-only; both halves are best-effort (an unreadable side yields
/// an empty list, never a half-invented one).
#[tauri::command]
async fn trust_preview(
    state: State<'_, AppState>,
    grant_id: String,
    muse_bin: String,
) -> Result<TrustPreview, String> {
    let root = grant_root(&state, &grant_id)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let listed = command(bin)
        .args([
            "skills",
            "list",
            "--source",
            "project",
            "--workspace",
        ])
        .arg(root.as_os_str())
        .args(["--trust-workspace", "--json"])
        .output()
        .map_err(|err| format!("Could not list project skills: {err}"))?;
    if !listed.status.success() {
        let detail = String::from_utf8_lossy(&listed.stderr);
        let detail = detail.lines().next().unwrap_or("skill listing failed").trim();
        return Err(format!("Muse could not list project skills: {detail}"));
    }
    let stdout = String::from_utf8_lossy(&listed.stdout);
    let skills = parse_skill_list(&stdout);
    let rules_path = root.join("AGENTS.md");
    let rules = match std::fs::read(&rules_path) {
        Ok(bytes) if !bytes.is_empty() => {
            let text = String::from_utf8_lossy(&bytes);
            let excerpt: String = text.chars().take(2000).collect();
            let truncated = text.len() > excerpt.len();
            Some(TrustRules {
                path: "AGENTS.md".into(),
                excerpt,
                truncated,
            })
        }
        _ => None,
    };
    Ok(TrustPreview { skills, rules })
}

/// Validate a CLI-side identifier the renderer nominates (MCP server name,
/// skill id, plugin id): plain keys, never flags or paths.
fn check_cli_name(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || value.starts_with('-')
        || value.contains(|ch: char| ch.is_whitespace() || ch == '/' || ch == '\\')
    {
        return Err(format!("That {field} is not valid."));
    }
    Ok(())
}

/// Run a Muse CLI command to completion, bounding its wait. OAuth logins
/// wait on the user's browser, so callers pick the ceiling.
fn run_cli(bin: &Path, args: &[&str], cwd: Option<&Path>, timeout: std::time::Duration) -> Result<std::process::Output, String> {
    let mut cmd = command(bin);
    process::apply_minimal_env(&mut cmd);
    cmd.env("PATH", augmented_path());
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("Could not start Muse: {err}"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    rx.recv_timeout(timeout)
        .map_err(|_| "Muse took too long. Try again.".to_string())?
        .map_err(|err| format!("Muse failed: {err}"))
}

fn cli_failure(what: &str, output: &std::process::Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.lines().next().unwrap_or(what).trim();
    format!("{what}: {}", redact_log_detail(detail))
}

/// Authorize an MCP server with OAuth: the CLI opens the browser and serves
/// the loopback callback itself; the desktop waits for it to finish.
#[tauri::command]
async fn mcp_login(state: State<'_, AppState>, server: String, muse_bin: String) -> Result<(), String> {
    check_cli_name("server name", &server)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["mcp", "login", server.as_str()], None, std::time::Duration::from_secs(900))?;
    if !output.status.success() {
        return Err(cli_failure("MCP sign-in failed", &output));
    }
    Ok(())
}

/// Drop an MCP server's OAuth credential.
#[tauri::command]
async fn mcp_logout(state: State<'_, AppState>, server: String, muse_bin: String) -> Result<(), String> {
    check_cli_name("server name", &server)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["mcp", "logout", server.as_str()], None, std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("MCP sign-out failed", &output));
    }
    Ok(())
}

/// Remove the saved Meta credential (API key or account login).
#[tauri::command]
async fn cli_logout(state: State<'_, AppState>, muse_bin: String) -> Result<(), String> {
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["logout"], None, std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("Sign-out failed", &output));
    }
    Ok(())
}

/// Scaffold agent config (`AGENTS.md`) in a granted workspace. Dry runs
/// return the would-be file text for preview instead of writing.
#[tauri::command]
async fn project_init(state: State<'_, AppState>, grant_id: String, muse_bin: String, dry_run: bool, force: bool) -> Result<String, String> {
    let root = grant_root(&state, &grant_id)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let mut args = vec!["init"];
    if dry_run {
        args.push("--dry-run");
    }
    if force {
        args.push("--force");
    }
    let output = run_cli(&bin, &args, Some(root.as_path()), std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("Project setup failed", &output));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.chars().take(8000).collect())
}

/// Read enterprise configuration status: the policy generation plus each
/// plane's source and state, so managed locks are visible, not silent.
#[tauri::command]
async fn enterprise_status(state: State<'_, AppState>, muse_bin: String) -> Result<EnterpriseStatus, String> {
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["config", "status"], None, std::time::Duration::from_secs(30))?;
    if !output.status.success() {
        return Err(cli_failure("Could not read enterprise configuration", &output));
    }
    Ok(parse_enterprise_status(&String::from_utf8_lossy(&output.stdout)))
}

/// List CLI skills for lifecycle management: the global inventory plus the
/// open workspace's project skills when a grant is given. Listing never
/// loads skill bodies, so no trust flag is needed.
#[tauri::command]
async fn skill_list(state: State<'_, AppState>, muse_bin: String, grant_id: String) -> Result<Vec<SkillEntry>, String> {
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["skills", "list", "--json"], None, std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("Could not list skills", &output));
    }
    let mut entries = parse_skill_inventory(&String::from_utf8_lossy(&output.stdout));
    if !grant_id.is_empty() {
        let root = grant_root(&state, &grant_id)?;
        let scoped = command(&bin)
            .args(["skills", "list", "--source", "project", "--workspace"])
            .arg(root.as_os_str())
            .arg("--json")
            .output()
            .map_err(|err| format!("Could not start Muse: {err}"))?;
        if !scoped.status.success() {
            return Err(cli_failure("Could not list project skills", &scoped));
        }
        for entry in parse_skill_inventory(&String::from_utf8_lossy(&scoped.stdout)) {
            if !entries.iter().any(|known| known.id == entry.id) {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

/// Install a skill bundle from a folder (`skills install --scope user`).
/// Naming and force-overwrite stay CLI-side; CLI errors surface verbatim.
#[tauri::command]
async fn skill_install(state: State<'_, AppState>, muse_bin: String, path: String) -> Result<String, String> {
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    if !PathBuf::from(&path).is_dir() {
        return Err("Pick the skill's folder to install it.".into());
    }
    let picked = take_picked_install(&state, &path)?;
    // `--` keeps a folder whose name starts with `-` from being read as a flag.
    let output = run_cli(&bin, &["skills", "install", "--", picked.as_str(), "--scope", "user", "--json"], None, std::time::Duration::from_secs(120))?;
    if !output.status.success() {
        return Err(cli_failure("Could not install the skill", &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).chars().take(2000).collect())
}

/// Import skills from another agent (`skills import --from claude|codex`).
/// Dry runs return the would-be result for preview instead of importing.
#[tauri::command]
async fn skill_import(state: State<'_, AppState>, muse_bin: String, from: String, dry_run: bool) -> Result<String, String> {
    if !["claude", "codex"].contains(&from.as_str()) {
        return Err("Import source must be claude or codex.".into());
    }
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let mut args = vec!["skills", "import", "--from", from.as_str(), "--scope", "user"];
    if dry_run {
        args.push("--dry-run");
    }
    args.push("--json");
    let output = run_cli(&bin, &args, None, std::time::Duration::from_secs(120))?;
    if !output.status.success() {
        return Err(cli_failure("Could not import skills", &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).chars().take(8000).collect())
}

/// Ask the native folder picker for a skill bundle directory. The choice is
/// recorded natively as a one-time install authorization, so `skill_install`
/// accepts only exactly this folder (see `take_picked_install`).
#[tauri::command]
async fn pick_skill_source(app: AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Pick a skill folder")
        .blocking_pick_folder();
    let Some(path) = selected.and_then(|value| value.into_path().ok()) else { return Ok(None); };
    if let Ok(canonical) = path.canonicalize() {
        if let Ok(mut picked) = state.picked_installs.lock() {
            picked.insert(canonical);
        }
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Inspect one skill (`skills inspect`): identity, scope, activation, and
/// the on-disk path, so enable/disable decisions have provenance.
#[tauri::command]
async fn skill_inspect(state: State<'_, AppState>, muse_bin: String, skill: String) -> Result<SkillDetail, String> {
    check_cli_name("skill", &skill)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["skills", "inspect", skill.as_str(), "--json"], None, std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("Could not inspect the skill", &output));
    }
    Ok(parse_skill_detail(&skill, &String::from_utf8_lossy(&output.stdout)))
}

/// Uninstall a skill by id (`skills uninstall`). Bundled skills are not
/// offered in the UI; the CLI validates the rest.
#[tauri::command]
async fn skill_uninstall(state: State<'_, AppState>, muse_bin: String, skill: String) -> Result<String, String> {
    check_cli_name("skill", &skill)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["skills", "uninstall", skill.as_str(), "--json"], None, std::time::Duration::from_secs(120))?;
    if !output.status.success() {
        return Err(cli_failure("Could not uninstall the skill", &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).chars().take(2000).collect())
}

/// Enable or disable a skill in one scope. Project scope resolves its root
/// from the grant, like every other workspace operation.
#[tauri::command]
async fn skill_set(state: State<'_, AppState>, skill: String, scope: String, enabled: bool, grant_id: String, muse_bin: String) -> Result<(), String> {
    check_cli_name("skill", &skill)?;
    if !["user", "project", "built-in", "plugin"].contains(&scope.as_str()) {
        return Err("That skill scope is not valid.".into());
    }
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let root = if scope == "project" {
        Some(grant_root(&state, &grant_id)?)
    } else {
        None
    };
    let mut args = vec!["skills", if enabled { "enable" } else { "disable" }, skill.as_str(), "--scope", scope.as_str()];
    let output = match root.as_ref() {
        Some(dir) => {
            args.push("--workspace");
            let mut cmd = command(&bin);
            cmd.args(&args).arg(dir.as_os_str()).args(["--trust-workspace", "--json"]);
            cmd.output().map_err(|err| format!("Could not start Muse: {err}"))?
        }
        None => {
            args.push("--json");
            run_cli(&bin, &args, None, std::time::Duration::from_secs(60))?
        }
    };
    if !output.status.success() {
        return Err(cli_failure(if enabled { "Could not enable the skill" } else { "Could not disable the skill" }, &output));
    }
    Ok(())
}

/// List installed plugins (or marketplace-available ones) for management.
#[tauri::command]
async fn plugin_list(state: State<'_, AppState>, muse_bin: String, available: bool) -> Result<Vec<PluginEntry>, String> {
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let mut args = vec!["plugins", "list"];
    if available {
        args.push("--available");
    }
    args.push("--json");
    let output = run_cli(&bin, &args, None, std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("Could not list plugins", &output));
    }
    Ok(parse_plugin_list(&String::from_utf8_lossy(&output.stdout)))
}

/// Inspect one installed plugin: metadata plus its runtime capabilities.
#[tauri::command]
async fn plugin_inspect(state: State<'_, AppState>, muse_bin: String, id: String) -> Result<PluginDetail, String> {
    check_cli_name("plugin id", &id)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(&bin, &["plugins", "inspect", id.as_str(), "--json"], None, std::time::Duration::from_secs(60))?;
    if !output.status.success() {
        return Err(cli_failure("Could not inspect the plugin", &output));
    }
    Ok(parse_plugin_detail(&id, &String::from_utf8_lossy(&output.stdout)))
}

/// Trust review: approve (enable) or reject (disable) a plugin's current
/// runtime capability definitions.
#[tauri::command]
async fn plugin_review(state: State<'_, AppState>, muse_bin: String, id: String, approve: bool) -> Result<(), String> {
    check_cli_name("plugin id", &id)?;
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let output = run_cli(
        &bin,
        &[ "plugins", if approve { "approve" } else { "reject" }, id.as_str(), "--json"],
        None,
        std::time::Duration::from_secs(60),
    )?;
    if !output.status.success() {
        return Err(cli_failure(if approve { "Could not approve the plugin" } else { "Could not reject the plugin" }, &output));
    }
    Ok(())
}

/// Install a local plugin bundle from a user-picked directory.
#[tauri::command]
async fn plugin_install(state: State<'_, AppState>, muse_bin: String, path: String) -> Result<(), String> {
    let bin = resolve_muse_bin(&state, &muse_bin)?;
    let candidate = PathBuf::from(&path);
    if !candidate.is_dir() {
        return Err("Pick the plugin bundle's folder to install it.".into());
    }
    let picked = take_picked_install(&state, &path)?;
    let output = run_cli(&bin, &["plugins", "install", "--", picked.as_str(), "--json"], None, std::time::Duration::from_secs(300))?;
    if !output.status.success() {
        return Err(cli_failure("Could not install the plugin", &output));
    }
    Ok(())
}

/// Ask the native folder picker for a plugin bundle directory. The choice is
/// recorded natively as a one-time install authorization (see
/// `take_picked_install`), so `plugin_install` accepts only this folder.
#[tauri::command]
async fn pick_plugin_bundle(app: AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Pick a plugin bundle folder")
        .blocking_pick_folder();
    let Some(path) = selected.and_then(|value| value.into_path().ok()) else { return Ok(None); };
    if let Ok(canonical) = path.canonicalize() {
        if let Ok(mut picked) = state.picked_installs.lock() {
            picked.insert(canonical);
        }
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Parse `muse skills list --json` leniently: the envelope may be
/// `{ skills: [...] }` or a bare array, and entries name themselves with
/// any of several keys. Unknown shapes yield no skills rather than guesses.
fn parse_skill_list(stdout: &str) -> Vec<TrustSkill> {
    let value: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.get("skills").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let name = ["selector", "displayName", "name", "id"]
                .iter()
                .filter_map(|key| object.get(*key)?.as_str())
                .next()?
                .to_string();
            if name.is_empty() {
                return None;
            }
            let description = object
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(280)
                .collect();
            Some(TrustSkill { name, description })
        })
        .take(100)
        .collect()
}

/// Save fetched full output through a native save dialog. The renderer
/// supplies the bytes and a suggested file name; the destination always
/// comes from the dialog, so this is not a write-to-path primitive.
/// `base64` selects binary payloads (non-text media); otherwise `content`
/// is written as UTF-8 text.
#[tauri::command]
async fn save_output_text(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file_name: String,
    content: String,
    base64: bool,
) -> Result<Option<String>, String> {
    let bytes = if base64 {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(content.as_bytes())
            .map_err(|_| "That output is not valid base64.".to_string())?
    } else {
        content.into_bytes()
    };
    if bytes.len() > OUTPUT_SAVE_LIMIT {
        return Err("That output is too large to save (over 32 MiB).".into());
    }
    let stem: String = file_name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(80)
        .collect();
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save tool output")
        .set_file_name(if stem.is_empty() { "muse-output.txt".to_string() } else { stem })
        .blocking_save_file();
    let Some(path) = selected.and_then(|value| value.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&path, bytes).map_err(|err| format!("Could not save the output: {err}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

const DROP_IMAGE_LIMIT: u64 = 10 * 1024 * 1024;
const DROP_FILE_LIMIT: usize = 20;

fn drop_media_type(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()).as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("avif") => Some("image/avif"),
        Some("bmp") => Some("image/bmp"),
        Some("ico") => Some("image/x-icon"),
        Some("svg") => Some("image/svg+xml"),
        Some("tif" | "tiff") => Some("image/tiff"),
        Some("heic") => Some("image/heic"),
        Some("heif") => Some("image/heif"),
        _ => None,
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DroppedFile {
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    media_type: Option<String>,
    base64_data: Option<String>,
    error: Option<String>,
}

/// Inspect files from a native OS drop. Images at or under the client image
/// limit come back with base64 bytes; everything else is metadata only and the
/// UI attaches it as a file reference. Image failures keep their media type so
/// the UI still references them; only missing files (error, no media type,
/// not a dir) are skipped. Drops are user-initiated, so paths may live
/// outside the open workspaces.
#[tauri::command]
fn inspect_dropped_files(paths: Vec<String>) -> Result<Vec<DroppedFile>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut out = Vec::new();
    for raw in paths.into_iter().take(DROP_FILE_LIMIT) {
        let path = PathBuf::from(&raw);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or(&raw).to_string();
        let meta = std::fs::metadata(&path);
        let Ok(meta) = meta else {
            out.push(DroppedFile { path: raw, name, is_dir: false, size: 0, media_type: None, base64_data: None, error: Some("File no longer exists.".into()) });
            continue;
        };
        if meta.is_dir() {
            out.push(DroppedFile { path: raw, name, is_dir: true, size: 0, media_type: None, base64_data: None, error: None });
            continue;
        }
        let size = meta.len();
        let media_type = drop_media_type(&path).map(str::to_string);
        if media_type.is_none() {
            out.push(DroppedFile { path: raw, name, is_dir: false, size, media_type: None, base64_data: None, error: None });
            continue;
        }
        if size == 0 {
            out.push(DroppedFile { path: raw, name, is_dir: false, size, media_type, base64_data: None, error: Some("Image is empty; attached as a file reference instead.".into()) });
            continue;
        }
        if size > DROP_IMAGE_LIMIT {
            out.push(DroppedFile { path: raw, name, is_dir: false, size, media_type, base64_data: None, error: Some("Image is larger than 10 MB; attached as a file reference instead.".into()) });
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) => out.push(DroppedFile { path: raw, name, is_dir: false, size, media_type, base64_data: Some(engine.encode(bytes)), error: None }),
            Err(err) => out.push(DroppedFile { path: raw, name, is_dir: false, size, media_type, base64_data: None, error: Some(format!("Could not read file: {err}")) }),
        }
    }
    Ok(out)
}

/// Consume a one-time picker authorization for an install path. Mirrors
/// `read_dropped_files`: the path must have been minted by a native picker in
/// this process and is single-use, so a renderer cannot replay or invent one.
fn take_picked_install(state: &State<'_, AppState>, path: &str) -> Result<String, String> {
    let mut picked = state.picked_installs.lock().map_err(|err| err.to_string())?;
    take_picked_install_in(&mut picked, path)
}

fn take_picked_install_in(picked: &mut HashSet<PathBuf>, path: &str) -> Result<String, String> {
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "That folder is no longer available. Pick it again.".to_string())?;
    if !picked.remove(&canonical) {
        return Err("Installing needs a folder chosen with this app's picker. Pick it again.".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_dropped_files(state: State<AppState>, paths: Vec<String>) -> Result<Vec<DroppedFile>, String> {
    let mut grants = state.dropped_paths.lock().map_err(|err| err.to_string())?;
    let mut authorized = Vec::new();
    for raw in paths.into_iter().take(DROP_FILE_LIMIT) {
        let canonical = PathBuf::from(&raw).canonicalize().map_err(|_| "A dropped file is no longer available")?;
        if !grants.remove(&canonical) {
            return Err("File inspection requires a fresh operating-system drop event.".into());
        }
        authorized.push(canonical.to_string_lossy().into_owned());
    }
    drop(grants);
    inspect_dropped_files(authorized)
}

#[tauri::command]
fn open_path(app: AppHandle, state: State<AppState>, path: String, grant_id: String) -> Result<(), String> {
    grant_root(&state, &grant_id)?;
    let Ok(canon) = PathBuf::from(&path).canonicalize() else {
        return Err("That file is no longer available.".into());
    };
    if !path_within_grant(&state, &grant_id, &canon)? {
        return Err("Opening files is limited to the current workspace.".into());
    }
    // Open exactly what was authorized, closing any swap window on the original string.
    app.opener()
        .open_path(canon.to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}

/// Only remote http(s) links may leave the app: no `file:`, custom-scheme,
/// or protocol-relative targets. Matching is case-sensitive on purpose —
/// `HTTP://` is rejected rather than normalized into an allowed URL.
fn url_open_allowed(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Keep PEM body lines out of OS logs as well as the labelled header.
fn redact_stderr_line(line: &str, private_key: &mut bool) -> Option<String> {
    let upper = line.to_ascii_uppercase();
    let begins = upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY-----");
    let ends = upper.contains("-----END") && upper.contains("PRIVATE KEY-----");
    if begins { *private_key = true; }
    if *private_key {
        if ends { *private_key = false; }
        return begins.then(|| "[redacted sensitive fields]".into());
    }
    if line.ends_with(" [truncated]") { return Some("[diagnostic omitted: size limit]".into()); }
    Some(redact_log_detail(line))
}

/// Serialized-size bound for an IPC body before any DTO runs. Tauri parses the
/// webview's postMessage body ahead of the invoke handler, so this is the
/// earliest point native code can refuse a bloated request: it bounds the
/// retained tree ahead of `validate_params`, canonical re-serialization, and
/// the bridge write. Raw bodies arrive unparsed, so their bytes cap directly.
/// The largest legitimate payload is `sendTurn` (32 MiB images + 1 MiB text +
/// JSON overhead); 48 MiB leaves headroom under the 64 MiB frame budget.
const IPC_BODY_LIMIT: usize = 48 * 1024 * 1024;
/// Bounds walk work and structural abuse (millions of tiny nodes).
const IPC_NODE_LIMIT: usize = 1_000_000;

fn ipc_body_oversized(body: &tauri::ipc::InvokeBody) -> bool {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.len() > IPC_BODY_LIMIT,
        tauri::ipc::InvokeBody::Json(value) => json_size_exceeded(value),
    }
}

enum Pending<'a> {
    Values(std::slice::Iter<'a, Value>),
    Entries(serde_json::map::Iter<'a>),
}

/// Depth-bounded walk: the stack holds one iterator per level, so a wide
/// payload cannot turn the walk itself into a second large allocation.
fn json_size_exceeded(root: &Value) -> bool {
    let mut bytes = 0usize;
    let mut nodes = 0usize;
    let mut stack = vec![Pending::Values(std::slice::from_ref(root).iter())];
    while let Some(top) = stack.last_mut() {
        let next = match top {
            Pending::Values(iter) => iter.next(),
            Pending::Entries(iter) => iter.next().map(|(key, value)| {
                bytes += key.len();
                value
            }),
        };
        let Some(value) = next else {
            stack.pop();
            continue;
        };
        nodes += 1;
        bytes += match value {
            Value::String(text) => text.len(),
            Value::Number(number) => number.to_string().len(),
            Value::Array(items) => {
                stack.push(Pending::Values(items.iter()));
                items.len()
            }
            Value::Object(map) => {
                stack.push(Pending::Entries(map.iter()));
                map.len()
            }
            _ => 1,
        };
        if bytes > IPC_BODY_LIMIT || nodes > IPC_NODE_LIMIT {
            return true;
        }
    }
    false
}

fn redact_log_detail(detail: &str) -> String {
    let lowered = detail.to_ascii_lowercase();
    if ["meta_api_key", "api_key", "apikey", "authorization", "password", "token", "bearer ", "basic ", "private key", "private_key", "privatekey", "secret", "cookie", "passwd", "sk-", "ghp_", "github_pat_", "?code=", "&code=", "?sig=", "&sig=", "signature="]
        .iter()
        .any(|marker| lowered.contains(marker))
        || lowered.split_once("://").map(|(_, rest)| rest.split('/').next().unwrap_or("").contains('@')).unwrap_or(false)
        || unlabelled_secret(detail)
    {
        "[redacted sensitive fields]".into()
    } else {
        detail.chars().take(8_000).collect()
    }
}

/// Token characters for unlabelled credential scans (`-`/`_` are valid inside
/// JWT, Slack, GitLab and age formats; `.` joins dotted compounds).
fn credential_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.'
}

/// `body` chars followed by a non-credential boundary: mirrors the trailing
/// `\b` in the JS-side formats so a longer run is not clipped into a match.
fn counted_token(run: &str, prefix: &str, body: &dyn Fn(u8) -> bool, min: usize, max: usize) -> bool {
    let Some(rest) = run.strip_prefix(prefix) else { return false };
    let count = rest.bytes().take_while(|b| body(*b)).count();
    if count < min || count > max { return false; }
    match rest.as_bytes().get(count) {
        None => true,
        Some(&b) => !credential_char(b),
    }
}

/// Dotted compounds tried at every `.` boundary in a run — a leading `\b`
/// lets `SG.`/`eyJ` match mid-run the same way the JS-side patterns do.
fn dotted_secret(parts: &[&str]) -> bool {
    let is_part = |part: &str, min: usize| {
        part.len() >= min && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    let exact = |part: &str, n: usize| part.len() == n && is_part(part, n);
    for i in 0..parts.len() {
        // JWT: `eyJ` opens base64 `{"`; three parts, no fixed tail lengths.
        if parts[i].starts_with("eyJ") && is_part(parts[i], 11)
            && parts.get(i + 1).is_some_and(|p| is_part(p, 8))
            && parts.get(i + 2).is_some_and(|p| is_part(p, 8)) {
            return true;
        }
        // SendGrid: `SG.` + 22 + `.` + 43.
        if parts[i] == "SG"
            && parts.get(i + 1).is_some_and(|p| exact(p, 22))
            && parts.get(i + 2).is_some_and(|p| exact(p, 43)) {
            return true;
        }
        // Doppler: `dp.pt.` + 20.
        if parts[i] == "dp" && parts.get(i + 1) == Some(&"pt")
            && parts.get(i + 2).is_some_and(|p| is_part(p, 20)) {
            return true;
        }
    }
    false
}

/// Credential formats that need no label: fixed prefixes or shapes make a bare
/// occurrence safe to suppress. Pure-hex hashes, UUIDs and fingerprints fall
/// through on purpose — common diagnostic content, not credentials.
fn unlabelled_secret(detail: &str) -> bool {
    let bytes = detail.as_bytes();
    let base64url = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let alnum = |b: u8| b.is_ascii_alphanumeric();
    let upper = |b: u8| b.is_ascii_uppercase() || b.is_ascii_digit();
    let hexd = |b: u8| b.is_ascii_hexdigit();
    let slack = |b: u8| b.is_ascii_alphanumeric() || b == b'-';

    let mut start = 0;
    while start < bytes.len() {
        while start < bytes.len() && !credential_char(bytes[start]) { start += 1; }
        let mut end = start;
        while end < bytes.len() && credential_char(bytes[end]) { end += 1; }
        if end > start {
            let run = &detail[start..end];
            let parts: Vec<&str> = run.split('.').collect();
            // Dotted compounds first: a JWT's `eyJ` segment would otherwise be
            // examined alone once the run splits on `.`.
            if parts.len() > 1 && dotted_secret(&parts) { return true; }
            for &piece in &parts {
                if counted_token(piece, "AKIA", &upper, 16, 16)
                    || counted_token(piece, "ASIA", &upper, 16, 16)
                    || counted_token(piece, "ABIA", &upper, 16, 16)
                    || counted_token(piece, "ACCA", &upper, 16, 16)
                    || counted_token(piece, "npm_", &alnum, 36, 36)
                    || counted_token(piece, "AIza", &base64url, 35, 35)
                    || counted_token(piece, "sk_live_", &alnum, 16, usize::MAX)
                    || counted_token(piece, "rk_live_", &alnum, 16, usize::MAX)
                    || counted_token(piece, "pk_live_", &alnum, 16, usize::MAX)
                    || counted_token(piece, "shpat_", &hexd, 32, 32)
                    || counted_token(piece, "shpca_", &hexd, 32, 32)
                    || counted_token(piece, "shppa_", &hexd, 32, 32)
                    || counted_token(piece, "lin_api_", &alnum, 20, usize::MAX)
                    || counted_token(piece, "glpat-", &base64url, 20, usize::MAX)
                    || counted_token(piece, "pypi-", &base64url, 16, usize::MAX)
                    || counted_token(piece, "AGE-SECRET-KEY-1", &alnum, 20, usize::MAX)
                {
                    return true;
                }
                // Slack: `xox` + one of b/a/p/r/s + `-` + 10+.
                if piece.starts_with("xox")
                    && piece.len() > 14
                    && matches!(piece.as_bytes().get(3), Some(b'b' | b'a' | b'p' | b'r' | b's'))
                    && piece.as_bytes().get(4) == Some(&b'-')
                    && counted_token(piece, &piece[..5], &slack, 10, usize::MAX)
                {
                    return true;
                }
                // High-entropy runs the formats above miss: 45+ token chars
                // mixing upper, lower and digit classes. Single-case hex and
                // short ids stay visible.
                if piece.len() >= 45 {
                    let (mut lo, mut up, mut di) = (false, false, false);
                    for &b in piece.as_bytes() {
                        if b.is_ascii_lowercase() { lo = true; }
                        else if b.is_ascii_uppercase() { up = true; }
                        else if b.is_ascii_digit() { di = true; }
                    }
                    if lo && up && di && piece.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return true; }
                }
            }
        }
        start = end.max(start + 1);
    }
    false
}

/// Cap on the persisted settings document, matching the IPC body budget.
const STORE_DOCUMENT_LIMIT: usize = 64 * 1024 * 1024;

/// The store document path, resolved exactly as `tauri-plugin-store` resolves it
/// (its `store.rs` uses `BaseDirectory::AppData`), so the atomic writer below
/// and the plugin's reader always agree on one file.
fn store_document_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("muse-desktop.json", BaseDirectory::AppData)
        .map_err(|err| format!("Could not resolve the settings path: {err}"))
}

fn write_fsync(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::File::create(path).map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    file.write_all(bytes).map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    file.sync_all().map_err(|err| format!("Could not flush {}: {err}", path.display()))?;
    Ok(())
}

fn store_document_is_valid(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|value| value.is_object())
        .unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreRepair {
    /// `ok` | `restored` | `quarantined` | `empty`.
    status: String,
    restored_from: Option<String>,
    quarantined_to: Option<String>,
}

/// Make the store document safe to read before hydration. A file that will not
/// parse is preserved as `muse-desktop.json.corrupt` rather than overwritten —
/// the next save must never silently replace a damaged file with defaults —
/// and the newest complete fallback is restored in its place.
fn repair_store_files(target: &Path) -> Result<StoreRepair, String> {
    let dir = target.parent().ok_or_else(|| "Invalid settings path.".to_string())?;
    let mut repaired = StoreRepair { status: "ok".into(), restored_from: None, quarantined_to: None };
    if store_document_is_valid(target) {
        return Ok(repaired);
    }
    if target.exists() {
        let quarantine = dir.join("muse-desktop.json.corrupt");
        let _ = std::fs::remove_file(&quarantine);
        if std::fs::rename(target, &quarantine).is_ok() {
            repaired.quarantined_to = Some("muse-desktop.json.corrupt".to_string());
        }
    }
    // `.tmp` is newer than `.bak` (it is the write that was interrupted), so it
    // wins when both are complete.
    let fallbacks = [(dir.join("muse-desktop.json.tmp"), "muse-desktop.json.tmp"), (dir.join("muse-desktop.json.bak"), "muse-desktop.json.bak")];
    for (candidate, label) in fallbacks {
        if !store_document_is_valid(&candidate) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&candidate) else { continue; };
        if write_fsync(target, &bytes).is_ok() {
            repaired.status = "restored".into();
            repaired.restored_from = Some(label.to_string());
            return Ok(repaired);
        }
    }
    repaired.status = if repaired.quarantined_to.is_some() { "quarantined".into() } else { "empty".into() };
    Ok(repaired)
}

/// Persist the settings document atomically: temp file, fsync, rename, keeping
/// the previous good copy as `muse-desktop.json.bak`. `tauri-plugin-store`'s own
/// `save()` is a bare `fs::write`, which a crash can leave truncated.
#[tauri::command]
fn persist_store_atomic(app: AppHandle, json: String) -> Result<(), String> {
    if json.len() > STORE_DOCUMENT_LIMIT {
        return Err("Settings are too large to save.".into());
    }
    let parsed: Value = serde_json::from_str(&json).map_err(|_| "Refusing to save an unparseable settings document.".to_string())?;
    if !parsed.is_object() {
        return Err("Settings document must be a JSON object.".into());
    }
    let target = store_document_path(&app)?;
    let dir = target.parent().ok_or_else(|| "Invalid settings path.".to_string())?;
    std::fs::create_dir_all(dir).map_err(|err| format!("Could not create the settings directory: {err}"))?;
    let tmp = dir.join("muse-desktop.json.tmp");
    let backup = dir.join("muse-desktop.json.bak");
    write_fsync(&tmp, json.as_bytes())?;
    // Rotate the previous copy aside before replacing, so a crash between the
    // two renames still leaves one complete document for `repair_store_files`.
    if target.exists() {
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(&target, &backup);
    }
    std::fs::rename(&tmp, &target).map_err(|err| format!("Could not save settings: {err}"))?;
    Ok(())
}

#[tauri::command]
fn repair_store_document(app: AppHandle) -> Result<StoreRepair, String> {
    repair_store_files(&store_document_path(&app)?)
}

fn app_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("Could not create log directory: {err}"))?;
    Ok(dir.join("muse-desktop.log"))
}

fn append_log_line(path: &Path, level: &str, event: &str, detail: &str) -> Result<(), String> {
    use std::fs::OpenOptions;
    if path.metadata().map(|meta| meta.len() >= APP_LOG_LIMIT).unwrap_or(false) {
        let previous = path.with_file_name("muse-desktop.previous.log");
        let _ = std::fs::remove_file(&previous);
        std::fs::rename(path, previous).map_err(|err| format!("Could not rotate log: {err}"))?;
    }
    let level = match level { "debug" | "info" | "warn" | "error" => level, _ => "info" };
    let event: String = redact_log_detail(event).chars().filter(|ch| !ch.is_control()).take(160).collect();
    // Control characters become spaces so a renderer-supplied detail cannot
    // forge extra TSV columns in the log (8 KiB cap).
    let detail: String = redact_log_detail(detail).chars().map(|ch| if ch.is_control() { ' ' } else { ch }).take(8192).collect();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(|err| format!("Could not open app log: {err}"))?;
    writeln!(file, "{timestamp}\t{level}\t{event}\t{detail}").map_err(|err| format!("Could not write app log: {err}"))
}

#[tauri::command]
fn append_app_log(app: AppHandle, level: String, event: String, detail: String) -> Result<(), String> {
    let path = app_log_path(&app)?;
    append_log_line(&path, &level, &event, &detail)
}

#[tauri::command]
fn open_log_folder(app: AppHandle) -> Result<String, String> {
    let path = app_log_path(&app)?;
    if !path.exists() {
        std::fs::write(&path, "").map_err(|err| format!("Could not create app log: {err}"))?;
    }
    let folder = path.parent().ok_or("Log directory is unavailable")?;
    app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url_open_allowed(&url) {
        return Err("Only http(s) links can be opened.".into());
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|err| err.to_string())
}

fn shutdown_bridge(state: &AppState) {
    if let Ok(mut guard) = state.bridge.lock() {
        if let Some(bridge) = guard.take() {
            // EOF first: the bridge treats stdin end as all-host shutdown,
            // which reaps ACP process groups before the Node process exits.
            process::shutdown_tree(bridge.child, bridge.stdin, Duration::from_secs(2));
        }
    }
}

/// Trackpad haptic tick (macOS Force Touch). `kind`: "alignment" for detents,
/// "level" for tier changes, anything else for a generic tap. No-op elsewhere.
#[tauri::command]
fn haptic(app: AppHandle, kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime, NSHapticFeedbackPerformer};
        let pattern = match kind.as_str() {
            "alignment" => NSHapticFeedbackPattern::Alignment,
            "level" => NSHapticFeedbackPattern::LevelChange,
            _ => NSHapticFeedbackPattern::Generic,
        };
        app.run_on_main_thread(move || {
            let performer = NSHapticFeedbackManager::defaultPerformer();
            performer.performFeedbackPattern_performanceTime(pattern, NSHapticFeedbackPerformanceTime::Now);
        })
        .map_err(|err| err.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, kind);
    Ok(())
}

/// Application menu. Custom items carry stable ids; `on_menu_event` forwards
/// them to the renderer as `app-menu` events that map to the same store
/// actions as the JS keydown shortcuts. Generic over the runtime so tests can
/// build it under `MockRuntime` without a window server.
fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let item = |id: &str, text: &str, accelerator: &str| {
        MenuItemBuilder::with_id(id, text).accelerator(accelerator).build(app)
    };
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-thread", "New Thread", "CmdOrCtrl+N")?)
        .item(&item("open-workspace", "Open Workspace…", "CmdOrCtrl+P")?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle-sidebar", "Toggle Sidebar", "CmdOrCtrl+B")?)
        .item(&item("toggle-changes", "Toggle Changes", "CmdOrCtrl+I")?)
        .item(&item("command-palette", "Command Palette", "CmdOrCtrl+K")?)
        .item(&item("search-threads", "Search Threads", "CmdOrCtrl+F")?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    #[allow(unused_mut)]
    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Muse Code")
            .item(&PredefinedMenuItem::about(app, Some("About Muse Code"), None)?)
            .separator()
            .item(&item("settings", "Settings…", "CmdOrCtrl+,")?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file).item(&edit).item(&view).item(&window).build()
}

/// Renderer-facing ids emitted as `app-menu`; anything else keeps its native behavior.
const APP_MENU_IDS: &[&str] = &[
    "settings",
    "new-thread",
    "open-workspace",
    "toggle-sidebar",
    "toggle-changes",
    "command-palette",
    "search-threads",
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic reports join the same redacted channel as every other diagnostic:
    // the default hook writes raw text to stderr, which lands in the OS log
    // outside the redactor on packaged builds. The app-log append below is
    // best-effort — panics before `setup` still reach stderr redacted.
    std::panic::set_hook(Box::new(|info| {
        let message = info.payload().downcast_ref::<&str>().copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("panic");
        let location = info.location()
            .map(|loc| format!(" at {}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_default();
        let safe = redact_log_detail(&format!("{message}{location}"));
        eprintln!("[muse-desktop] panic: {safe}");
        if let Some(path) = APP_LOG_PATH.get() {
            let _ = append_log_line(path, "error", "panic", &safe);
        }
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            bridge_request,
            verify_grants,
            remove_grant,
            agent_identities,
            confirm_agent_bin,
            git_snapshot,
            list_workspace_files,
            git_discard_files,
            git_discard_all,
            git_discard_hunk,
            git_stage,
            git_commit,
            pick_folder,
            export_session,
            save_output_text,
            trust_preview,
            mcp_login,
            mcp_logout,
            cli_logout,
            project_init,
            enterprise_status,
            skill_list,
            skill_set,
            skill_install,
            skill_import,
            skill_inspect,
            skill_uninstall,
            pick_skill_source,
            plugin_list,
            plugin_inspect,
            plugin_review,
            plugin_install,
            pick_plugin_bundle,
            read_dropped_files,
            open_path,
            open_url,
            persist_store_atomic,
            repair_store_document,
            append_app_log,
            open_log_folder,
            haptic,
            credentials::credential_get,
            credentials::credential_set,
            credentials::acp_isolation_consent_get,
            credentials::acp_isolation_consent_set
        ];
            move |invoke| {
                if ipc_body_oversized(invoke.message.payload()) {
                    invoke.resolver.reject("Request exceeds the IPC byte limit.");
                    return true;
                }
                commands(invoke)
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            if let Ok(mut grants) = state.grants.lock() {
                *grants = load_grants();
            }
            state.agent_pins.replace(load_agent_pins());
            if let Ok(dir) = handle.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = SECURITY_AUDIT.set(dir.join("security-audit.log"));
                let _ = APP_LOG_PATH.set(dir.join("muse-desktop.log"));
            }
            if let Err(err) = ensure_bridge(&handle, &state) {
                eprintln!("bridge start deferred: {err}");
            }
            if let Err(err) = build_app_menu(&handle).and_then(|menu| app.set_menu(menu)) {
                eprintln!("menu setup skipped: {err}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id.0.as_str();
            if APP_MENU_IDS.contains(&id) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("app-menu", json!({ "id": id }));
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Ok(mut grants) = window.state::<AppState>().dropped_paths.lock() {
                    grants.clear();
                    grants.extend(paths.iter().filter_map(|path| path.canonicalize().ok()));
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    let state = window.state::<AppState>();
                    shutdown_bridge(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Muse Code Desktop");
}

/// Lenient `plugins list --json` rows: `{ plugins: [...] }` or a bare
/// array, entries named by id, pluginId, or name.
fn parse_plugin_list(stdout: &str) -> Vec<PluginEntry> {
    let value: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.get("plugins").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    fn text(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
        keys.iter().filter_map(|key| object.get(*key)?.as_str()).next().map(str::to_string)
    }
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let id = text(object, &["id", "pluginId", "name"])?;
            if id.is_empty() {
                return None;
            }
            Some(PluginEntry {
                id,
                version: text(object, &["version"]),
                description: text(object, &["description", "summary"]).unwrap_or_default().chars().take(280).collect(),
                enabled: object.get("enabled").and_then(Value::as_bool),
            })
        })
        .take(200)
        .collect()
}

/// Lenient `plugins inspect --json`: metadata plus runtime capabilities.
fn parse_plugin_detail(id: &str, stdout: &str) -> PluginDetail {
    let value: Value = serde_json::from_str(stdout).unwrap_or(Value::Null);
    let object = value.as_object().cloned().unwrap_or_default();
    let text = |keys: &[&str]| -> Option<String> {
        keys.iter().filter_map(|key| object.get(*key)?.as_str()).next().map(str::to_string)
    };
    let capabilities = object
        .get("capabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let cap = entry.as_object()?;
            let cid = ["id", "capabilityId", "stableId", "name"]
                .iter()
                .filter_map(|key| cap.get(*key)?.as_str())
                .next()?;
            if cid.is_empty() {
                return None;
            }
            Some(PluginCapability {
                id: cid.to_string(),
                kind: cap.get("kind").and_then(Value::as_str).map(str::to_string),
                description: cap.get("description").and_then(Value::as_str).unwrap_or("").chars().take(280).collect(),
                enabled: cap.get("enabled").and_then(Value::as_bool),
            })
        })
        .take(200)
        .collect();
    PluginDetail {
        id: text(&["id", "pluginId"]).unwrap_or_else(|| id.to_string()),
        version: text(&["version"]),
        description: text(&["description", "summary"]).unwrap_or_default().chars().take(280).collect(),
        capabilities,
    }
}

/// Lenient `skills list --json` rows: `{ skills: [...] }` or a bare
/// array, identified by id with name/scope/activation alongside.
fn parse_skill_inventory(stdout: &str) -> Vec<SkillEntry> {
    let value: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.get("skills").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let id = object.get("id")?.as_str()?;
            if id.is_empty() {
                return None;
            }
            Some(SkillEntry {
                id: id.to_string(),
                name: object.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
                description: object
                    .get("description")
                    .or_else(|| object.get("short_description"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(280)
                    .collect(),
                scope: object.get("scope").and_then(Value::as_str).unwrap_or("").to_string(),
                activation: object.get("activation").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        })
        .take(200)
        .collect()
}

/// Lenient `config status` text: a `Generation:` line plus `plane=…`
/// source rows. Unknown lines are ignored so new CLI output never breaks
/// the read.
fn parse_enterprise_status(stdout: &str) -> EnterpriseStatus {
    let mut generation = None;
    let mut sources = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Generation:") {
            let value = value.trim();
            if !value.is_empty() {
                generation = Some(value.chars().take(128).collect());
            }
            continue;
        }
        if trimmed.starts_with("plane=") {
            let mut plane = String::new();
            let mut source_class = String::new();
            let mut state = String::new();
            for part in trimmed.split_whitespace() {
                let (key, value) = part.split_once('=').unwrap_or(("", ""));
                match key {
                    "plane" => plane = value.to_string(),
                    "source_class" => source_class = value.to_string(),
                    "state" => state = value.to_string(),
                    _ => {}
                }
            }
            if !plane.is_empty() {
                sources.push(EnterpriseSource { plane, source_class, state });
            }
        }
    }
    EnterpriseStatus { generation, sources: sources.into_iter().take(32).collect() }
}

/// Lenient `skills inspect --json`: a flat object or a `{ skill: … }`
/// envelope, keyed by id with scope/activation/path alongside.
fn parse_skill_detail(fallback_id: &str, stdout: &str) -> SkillDetail {
    let value: Value = serde_json::from_str(stdout).unwrap_or(Value::Null);
    let object = value
        .get("skill")
        .or(Some(&value))
        .and_then(Value::as_object);
    let text = |keys: &[&str]| -> Option<String> {
        object.and_then(|map| keys.iter().find_map(|key| map.get(*key)?.as_str())).map(str::to_string)
    };
    SkillDetail {
        id: text(&["id"]).unwrap_or_else(|| fallback_id.to_string()),
        name: text(&["name"]).unwrap_or_else(|| fallback_id.to_string()),
        description: text(&["description", "short_description"]).unwrap_or_default().chars().take(280).collect(),
        scope: text(&["scope"]).unwrap_or_default(),
        activation: text(&["activation"]).unwrap_or_default(),
        path: text(&["path"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch dir with a store document in it.
    fn store_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("muse-store-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn store_document_is_valid_rejects_a_truncated_document() {
        let dir = store_dir("valid");
        let target = dir.join("muse-desktop.json");
        std::fs::write(&target, "{\"settings\":{},\"sessionMemory\":{}}").expect("write");
        assert!(store_document_is_valid(&target));
        // What a crash part-way through a truncate-and-write leaves behind.
        std::fs::write(&target, "{\"settings\":{").expect("write");
        assert!(!store_document_is_valid(&target), "truncated JSON must not be accepted");
        assert!(!store_document_is_valid(&dir.join("muse-desktop.json.missing")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_truncated_store_is_quarantined_and_restored_from_the_backup() {
        let dir = store_dir("restore");
        let target = dir.join("muse-desktop.json");
        // The atomic writer rotated the last good copy aside before replacing it.
        std::fs::write(dir.join("muse-desktop.json.bak"), "{\"sessionMemory\":{\"version\":1}}").expect("write");
        std::fs::write(&target, "{\"settings\":{").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "restored");
        assert_eq!(repaired.restored_from.as_deref(), Some("muse-desktop.json.bak"));
        assert_eq!(repaired.quarantined_to.as_deref(), Some("muse-desktop.json.corrupt"));
        assert!(store_document_is_valid(&target), "the good copy must be back in place");
        // The damaged original is preserved for forensics rather than overwritten.
        assert!(dir.join("muse-desktop.json.corrupt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_write_prefers_the_newer_tmp_over_the_backup() {
        let dir = store_dir("tmp-wins");
        let target = dir.join("muse-desktop.json");
        // Crash between the two renames: the old copy is already at `.bak` and
        // the interrupted write is a complete `.tmp`.
        std::fs::write(dir.join("muse-desktop.json.bak"), "{\"sessionMemory\":{\"generation\":1}}").expect("write");
        std::fs::write(dir.join("muse-desktop.json.tmp"), "{\"sessionMemory\":{\"generation\":2}}").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "restored");
        assert_eq!(repaired.restored_from.as_deref(), Some("muse-desktop.json.tmp"));
        assert_eq!(
            std::fs::read_to_string(&target).expect("read"),
            "{\"sessionMemory\":{\"generation\":2}}",
            "the interrupted write is newer than the backup and must win"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_store_with_no_fallback_is_quarantined_not_silently_reset() {
        let dir = store_dir("quarantine");
        let target = dir.join("muse-desktop.json");
        std::fs::write(&target, "not json at all").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "quarantined");
        assert_eq!(repaired.restored_from, None, "nothing recoverable, so nothing restored");
        assert!(!target.exists(), "the unreadable file must not be left to poison the next load");
        assert_eq!(
            std::fs::read_to_string(dir.join("muse-desktop.json.corrupt")).expect("read"),
            "not json at all",
            "the damaged file must survive byte-for-byte"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_store_is_a_clean_first_run() {
        let dir = store_dir("first-run");
        let repaired = repair_store_files(&dir.join("muse-desktop.json")).expect("repair");
        assert_eq!(repaired.status, "empty");
        assert_eq!(repaired.restored_from, None);
        assert_eq!(repaired.quarantined_to, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cli_names_reject_flags_paths_and_blanks() {
        assert!(check_cli_name("server name", "acme-tools").is_ok());
        assert!(check_cli_name("server name", "").is_err());
        assert!(check_cli_name("server name", "--json").is_err());
        assert!(check_cli_name("server name", "a/b").is_err());
        assert!(check_cli_name("server name", "a b").is_err());
    }

    #[test]
    fn plugin_parsers_cover_envelopes_details_and_garbage() {
        let listed = parse_plugin_list(r#"{"plugins": [{"id": "acme", "version": "1.2", "description": "Tools", "enabled": true}, {}]}"#);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "acme");
        assert_eq!(listed[0].enabled, Some(true));
        assert!(parse_plugin_list("nope").is_empty());
        let detail = parse_plugin_detail("acme", r#"{"id": "acme", "capabilities": [{"stableId": "s1", "kind": "tool", "description": "Runs shell"}]}"#);
        assert_eq!(detail.capabilities.len(), 1);
        let skills = parse_skill_inventory(r#"{"skills": [{"id": "bundled:git", "name": "git", "description": "Git help", "scope": "bundled", "activation": "on"}, {}]}"#);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "bundled:git");
        assert_eq!(skills[0].activation, "on");
        assert!(parse_skill_inventory("nope").is_empty());
        let enterprise = parse_enterprise_status("Enterprise configuration status\nGeneration: sha256:abc123\nSources:\n  plane=defaults source_class=system_file state=absent\n  plane=policy source_class=macos_managed_preferences state=active\n");
        assert_eq!(enterprise.generation.as_deref(), Some("sha256:abc123"));
        assert_eq!(enterprise.sources.len(), 2);
        assert_eq!(enterprise.sources[1].state, "active");
        assert!(parse_enterprise_status("nothing useful").generation.is_none());
        let flat = parse_skill_detail("bundled:git", r#"{"id": "bundled:git", "name": "git", "scope": "bundled", "activation": "on", "path": "bundled://skills/git/SKILL.md"}"#);
        assert_eq!(flat.path.as_deref(), Some("bundled://skills/git/SKILL.md"));
        let wrapped = parse_skill_detail("x", r#"{"skill": {"id": "user:acme", "scope": "user", "activation": "off"}}"#);
        assert_eq!(wrapped.id, "user:acme");
        assert_eq!(wrapped.activation, "off");
        assert!(parse_skill_detail("x", "nope").path.is_none());
        let diff = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -10,2 +10,2 @@\n x\n-y\n+z\n";
        let patch = single_hunk_patch(diff, 1).expect("second hunk");
        assert!(patch.contains("diff --git a/f.txt b/f.txt"));
        assert!(patch.contains("@@ -10,2 +10,2 @@"));
        assert!(!patch.contains("@@ -1,3"));
        assert!(single_hunk_patch(diff, 2).is_err());
        assert_eq!(detail.capabilities[0].id, "s1");
        let fallback = parse_plugin_detail("acme", "nope");
        assert_eq!(fallback.id, "acme");
        assert!(fallback.capabilities.is_empty());
    }

    #[test]
    fn skill_list_parses_envelopes_and_skips_nameless() {
        let enveloped = parse_skill_list(r#"{"skills": [{"selector": "/review", "description": "Review code"}, {"description": "nameless"}]}"#);
        assert_eq!(enveloped.len(), 1);
        assert_eq!(enveloped[0].name, "/review");
        assert_eq!(enveloped[0].description, "Review code");
        let bare = parse_skill_list(r#"[{"displayName": "Plan", "description": "x"}]"#);
        assert_eq!(bare.len(), 1);
        assert_eq!(bare[0].name, "Plan");
        assert!(parse_skill_list("not json").is_empty());
        assert!(parse_skill_list(r#"{"other": []}"#).is_empty());
    }

    #[test]
    fn extra_bin_dirs_include_user_local_bin() {
        let home = dirs::home_dir().expect("home directory");
        assert!(extra_bin_dirs().contains(&home.join(".local/bin")));
    }

    #[test]
    fn extra_dirs_find_node_without_shell_path() {
        let path = std::env::join_paths(extra_bin_dirs().into_iter().filter(|dir| dir.is_dir()))
            .expect("join extra bin dirs");
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let found = which::which_in("node", Some(path), cwd);
        assert!(found.is_ok(), "node should be in well-known bin dirs: {found:?}");
    }

    #[test]
    fn muse_bin_rejects_missing_temp_and_wrong_names() {
        let state = AppState::new();
        // Nothing exists at these paths (or temp forbids them): all fail.
        assert!(resolve_muse_bin(&state, "/tmp/muse").is_err());
        assert!(resolve_muse_bin(&state, "/tmp/muse-audit-probe.sh").is_err());
        assert!(resolve_muse_bin(&state, "muse").is_err());
        assert!(resolve_muse_bin(&state, "/definitely/not/here").is_err());
        // Canonical validation (temp symlink smuggling, name checks, exec bit)
        // is covered in `exec.rs`; auto-discovery finds a real install or errs.
        let found = resolve_muse_bin(&state, "");
        assert!(found.is_ok() || found.unwrap_err().contains("not found"));
    }

    fn fixture_repo(tag: &str) -> (AppState, String, PathBuf) {
        let dir = std::env::temp_dir().join(format!("muse-discard-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        run_git(&dir, &["init", "-q"]).expect("init");
        run_git(&dir, &["config", "user.email", "test@example.com"]).expect("config");
        run_git(&dir, &["config", "user.name", "Test"]).expect("config");
        run_git(&dir, &["config", "commit.gpgsign", "false"]).expect("config");
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), dir.canonicalize().expect("canon"));
        (state, id, dir)
    }

    fn commit_all(dir: &Path, message: &str) {
        run_git(dir, &["add", "-A"]).expect("add");
        run_git(dir, &["commit", "-qm", message]).expect("commit");
    }

    #[test]
    fn workspace_files_lists_repo_and_plain_trees() {
        // Repo path: tracked + untracked-not-ignored show; ignored entries don't.
        let (_state, _grant, dir) = fixture_repo("fileindex");
        std::fs::write(dir.join(".gitignore"), "ignored.log\nnode_modules/\n").expect("fixture");
        std::fs::create_dir_all(dir.join("src")).expect("fixture");
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");
        std::fs::write(dir.join("ignored.log"), "x\n").expect("fixture");
        std::fs::create_dir_all(dir.join("node_modules/pkg")).expect("fixture");
        std::fs::write(dir.join("node_modules/pkg/index.js"), "x\n").expect("fixture");
        let listed = workspace_files_for(&dir).expect("repo index");
        assert!(listed.iter().any(|p| p == "src/main.rs"));
        assert!(listed.iter().any(|p| p == "loose.txt"), "untracked files list: {listed:?}");
        assert!(!listed.iter().any(|p| p == "ignored.log" || p.starts_with("node_modules/")), "ignored excluded: {listed:?}");
        let _ = std::fs::remove_dir_all(&dir);

        // Plain dir: bounded walk skips dependency, build, and hidden dirs.
        let plain = std::env::temp_dir().join(format!("muse-fileindex-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(plain.join("src")).expect("fixture");
        std::fs::write(plain.join("src/lib.rs"), "x\n").expect("fixture");
        std::fs::create_dir_all(plain.join("node_modules/dep")).expect("fixture");
        std::fs::write(plain.join("node_modules/dep/x.js"), "x\n").expect("fixture");
        std::fs::create_dir_all(plain.join(".cache")).expect("fixture");
        std::fs::write(plain.join(".cache/x"), "x\n").expect("fixture");
        let listed = workspace_files_for(&plain).expect("walk index");
        assert_eq!(listed, vec!["src/lib.rs".to_string()], "walk result: {listed:?}");
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[test]
    fn discard_restores_tracked_and_removes_untracked() {
        let (state, grant, dir) = fixture_repo("files");
        std::fs::write(dir.join("a.txt"), "original\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "edited\n").expect("edit");
        std::fs::write(dir.join("b.txt"), "staged new\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");
        std::fs::write(dir.join("c.txt"), "untracked\n").expect("fixture");
        let snap = git_discard_files_inner(&state, &grant, vec!["a.txt".into(), "c.txt".into()]).expect("discard");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("read"), "original\n");
        assert!(!dir.join("c.txt").exists());
        // b.txt was not selected: still staged.
        assert!(snap.files.iter().any(|file| file.path == "b.txt"));
        // Staged-new files restore to HEAD-absent (unstaged and removed).
        let snap = git_discard_files_inner(&state, &grant, vec!["b.txt".into()]).expect("discard staged");
        assert!(!dir.join("b.txt").exists());
        assert!(!snap.dirty, "tree should be clean: {:?}", snap.files);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_rejects_escapes_limits_and_unknown_grants() {
        let (state, grant, dir) = fixture_repo("escapes");
        std::fs::write(dir.join("a.txt"), "x\n").expect("fixture");
        commit_all(&dir, "one");
        for bad in ["", "/etc/passwd", "../x", "a/../../b", "..", "sub/../../evil", &"x".repeat(1025)] {
            assert!(git_discard_files_inner(&state, &grant, vec![bad.into()]).is_err(), "{bad:?} must fail");
        }
        assert!(git_discard_files_inner(&state, &grant, vec![]).is_err());
        let many: Vec<String> = (0..201).map(|n| format!("f{n}.txt")).collect();
        assert!(git_discard_files_inner(&state, &grant, many).is_err());
        assert!(git_discard_files_inner(&state, "wg-00000000000000000000000000000000", vec!["a.txt".into()]).is_err());
        assert!(git_discard_all_inner(&state, "wg-00000000000000000000000000000000").is_err());
        // Nothing was touched by the rejections.
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("read"), "x\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_symlink_inside_repo_cannot_escape() {
        let (state, grant, dir) = fixture_repo("symlink");
        let outside = std::env::temp_dir().join(format!("muse-discard-outside-{}", std::process::id()));
        std::fs::write(&outside, "precious\n").expect("fixture");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &dir.join("link")).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &dir.join("link")).expect("symlink");
        commit_all(&dir, "one");
        std::fs::write(&outside, "changed\n").expect("edit outside");
        let err = git_discard_files_inner(&state, &grant, vec!["link".into()]).unwrap_err();
        assert!(err.contains("workspace"), "{err}");
        assert_eq!(std::fs::read_to_string(&outside).expect("read"), "changed\n");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn discard_all_cleans_everything_but_ignored() {
        let (state, grant, dir) = fixture_repo("all");
        std::fs::write(dir.join(".gitignore"), "ignored.log\n").expect("fixture");
        std::fs::write(dir.join("a.txt"), "original\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "edited\n").expect("edit");
        std::fs::write(dir.join("b.txt"), "staged\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");
        std::fs::write(dir.join("c.txt"), "untracked\n").expect("fixture");
        std::fs::write(dir.join("ignored.log"), "keep me\n").expect("fixture");
        git_discard_all_inner(&state, &grant).expect("discard all");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("read"), "original\n");
        assert!(!dir.join("b.txt").exists());
        assert!(!dir.join("c.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("ignored.log")).expect("read"), "keep me\n");
        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");
        assert!(!snap.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_handles_unborn_head() {
        let (state, grant, dir) = fixture_repo("unborn");
        std::fs::write(dir.join("new.txt"), "staged\n").expect("fixture");
        run_git(&dir, &["add", "new.txt"]).expect("stage");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");
        let snap = git_discard_files_inner(&state, &grant, vec!["new.txt".into(), "loose.txt".into()]).expect("discard");
        assert!(!dir.join("new.txt").exists());
        assert!(!dir.join("loose.txt").exists());
        assert!(!snap.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bridge_script_verification_rejects_swaps() {
        assert!(verify_bridge_script(Path::new("/definitely/not/here.js")).is_err());
        let swap = std::env::temp_dir().join(format!("muse-script-swap-{}.js", std::process::id()));
        std::fs::write(&swap, b"console.log('evil')").expect("fixture");
        let err = verify_bridge_script(&swap).unwrap_err();
        assert!(err.contains("ridge script"), "{err}");
        let _ = std::fs::remove_file(&swap);
        // The worktree bundle verifies when it exists, proving the baked
        // digest tracks the packaged script.
        let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/muse-bridge/dist/index.js");
        if dist.exists() {
            assert!(verify_bridge_script(&dist).is_ok());
        }
    }

    #[test]
    fn sidecar_name_matches_installed_bundle() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let staged = config["bundle"]["externalBin"][0].as_str().unwrap();
        let base = Path::new(staged).file_name().unwrap().to_str().unwrap();
        let expected = if cfg!(target_os = "windows") { format!("{base}.exe") } else { base.to_string() };
        assert_eq!(sidecar_file_name(), expected);
    }

    #[test]
    fn open_url_allows_only_remote_http() {
        assert!(url_open_allowed("https://muse.ai/docs"));
        assert!(url_open_allowed("http://localhost:3000/preview"));
        assert!(!url_open_allowed("file:///etc/passwd"));
        assert!(!url_open_allowed("muse://session/123"));
        assert!(!url_open_allowed("//evil.example/x"));
        assert!(!url_open_allowed("HTTP://example.com/"));
        assert!(!url_open_allowed("javascript:alert(1)"));
        assert!(!url_open_allowed(""));
    }

    #[test]
    fn persisted_log_details_fail_closed_on_secret_markers() {
        assert_eq!(redact_log_detail(r#"{"apiKey":"secret"}"#), "[redacted sensitive fields]");
        assert_eq!(redact_log_detail("host stopped unexpectedly"), "host stopped unexpectedly");
        assert!(!redact_log_detail(&"x".repeat(9_000)).len() > 8_000);
    }

    #[test]
    fn native_diagnostics_suppress_credentials_and_multiline_keys() {
        for text in [
            "Authorization: Bearer CANARY-BEARER", "Basic CANARY-BASIC",
            "https://user:CANARY-URL@example.invalid/path", "client_secret=CANARY-SECRET",
            "cookie=CANARY-COOKIE", "sk-CANARY-PROVIDER", "https://auth.invalid/?code=CANARY-CODE",
        ] {
            assert!(!redact_log_detail(text).contains("CANARY"));
        }
        let mut private_key = false;
        assert!(redact_stderr_line("-----BEGIN RSA PRIVATE KEY-----", &mut private_key).is_some());
        assert!(redact_stderr_line("CANARY-BODY", &mut private_key).is_none());
        assert!(redact_stderr_line("-----END RSA PRIVATE KEY-----", &mut private_key).is_none());
        assert_eq!(redact_stderr_line("connected", &mut private_key).as_deref(), Some("connected"));
        assert!(!redact_stderr_line("CANARY-PREFIX [truncated]", &mut private_key).unwrap().contains("CANARY"));
    }

    #[test]
    fn unlabelled_credential_formats_redact_without_a_label() {
        for text in [
            "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c end",
            "aws AKIAIOSFODNN7EXAMPLE seen",
            "temp ASIAIOSFODNN7EXAMPLE seen",
            "slack xoxb-1234567890-CANARYTOKENabcd",
            "npm npm_aB1aB1aB1aB1aB1aB1aB1aB1aB1aB1aB1aB1 token",
            "google AIzaSySySySySySySySySySySySySySySySySy1 key",
            "stripe sk_live_CANARYabcdefghijklmnop",
            "sendgrid SG.xxxxxxxxxxxxxxxxxxxxxx.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY tail",
            "age AGE-SECRET-KEY-1qqpqaze9canary9x8gf2tvdw0s3jn54khce6mua7l",
            "shopify shpat_cafecafecafecafecafecafecafecafe",
            "linear lin_api_CANARYabcdefghijklmnopqrstuvwx",
            "gitlab glpat-CANARYabcdefghijklmnop",
            "pypi pypi-CANARYabcdefghijklmnop",
            "doppler dp.pt.CANARYabcdefghijklmnopqrstuvwx",
        ] {
            assert_eq!(redact_log_detail(text), "[redacted sensitive fields]", "{text}");
        }
    }

    #[test]
    fn entropy_runs_redact_but_hashes_and_ids_stay_visible() {
        assert_eq!(redact_log_detail("session Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1"), "[redacted sensitive fields]");
        assert_eq!(redact_log_detail("commit 54d702f8a1b2c3d4e5f60718293a4b5c6d7e8f9a"), "commit 54d702f8a1b2c3d4e5f60718293a4b5c6d7e8f9a");
        assert_eq!(redact_log_detail("session 3f8a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c"), "session 3f8a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c");
    }

    #[test]
    fn ipc_body_budget_rejects_oversized_trees_before_dto() {
        use tauri::ipc::InvokeBody;
        let under = json!({ "method": "sendTurn", "text": "x".repeat(1_000_000), "images": ["a".repeat(32 * 1024 * 1024)] });
        assert!(!ipc_body_oversized(&InvokeBody::Json(under)));
        assert!(ipc_body_oversized(&InvokeBody::Json(json!({ "blob": "x".repeat(IPC_BODY_LIMIT + 1) }))));
        assert!(ipc_body_oversized(&InvokeBody::Json(json!({ ("k".repeat(IPC_BODY_LIMIT)): true }))));
        assert!(ipc_body_oversized(&InvokeBody::Raw(vec![0u8; IPC_BODY_LIMIT + 1])));
        // Wide-but-small and deep structures stay under the node cap.
        let wide: Value = (0..100_000).map(|i| json!({ "k": i })).collect();
        assert!(!ipc_body_oversized(&InvokeBody::Json(wide)));
        let mut deep = json!(1);
        for _ in 0..512 { deep = json!([deep]); }
        assert!(!ipc_body_oversized(&InvokeBody::Json(deep)));
        // Node-count abuse still fails closed.
        let swarm: Value = (0..IPC_NODE_LIMIT + 1).map(|_| json!(0)).collect();
        assert!(ipc_body_oversized(&InvokeBody::Json(swarm)));
    }

    #[test]
    fn export_names_are_safe_and_readable() {
        assert_eq!(export_file_name("Fix auth / retry bug"), "fix-auth-retry-bug.json");
        assert_eq!(export_file_name("  "), "muse-session.json");
        assert!(!export_file_name("../../secret").contains('/'));
    }

    #[test]
    fn picked_install_is_single_use_and_picker_bound() {
        let dir = std::env::temp_dir().join(format!("muse-pick-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let raw = dir.to_string_lossy().into_owned();

        // Unpicked paths are refused, even for a real directory.
        let mut picked = HashSet::new();
        assert!(take_picked_install_in(&mut picked, &raw).is_err());

        // A pick authorizes exactly once: the second install must re-pick.
        picked.insert(dir.canonicalize().unwrap());
        assert!(take_picked_install_in(&mut picked, &raw).is_ok());
        assert!(take_picked_install_in(&mut picked, &raw).is_err());

        // A missing folder is refused before any authorization is consumed.
        picked.insert(dir.canonicalize().unwrap());
        assert!(take_picked_install_in(&mut picked, &format!("{raw}/gone")).is_err());
        assert!(take_picked_install_in(&mut picked, &raw).is_ok());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn porcelain_z_skips_rename_sources() {
        let raw = " M src/a.rs\0R  new name.rs\0old name.rs\0?? notes.txt\0";
        let files = parse_porcelain_z(raw);
        assert_eq!(files, vec![
            ("src/a.rs".to_string(), "M".to_string()),
            ("new name.rs".to_string(), "R".to_string()),
            ("notes.txt".to_string(), "??".to_string()),
        ]);
    }

    #[test]
    fn numstat_z_maps_renames_to_new_path() {
        let raw = "12\t3\0plain.txt\0renamed file.txt\0";
        let counts = parse_numstat_z(raw);
        assert_eq!(counts.get("renamed file.txt").copied(), Some((12, 3)));
    }

    #[test]
    fn drop_media_type_matches_client_table() {
        assert_eq!(drop_media_type(Path::new("shot.PNG")), Some("image/png"));
        assert_eq!(drop_media_type(Path::new("photo.jpeg")), Some("image/jpeg"));
        assert_eq!(drop_media_type(Path::new("anim.gif")), Some("image/gif"));
        assert_eq!(drop_media_type(Path::new("pic.webp")), Some("image/webp"));
        assert_eq!(drop_media_type(Path::new("icon.svg")), Some("image/svg+xml"));
        assert_eq!(drop_media_type(Path::new("scan.tiff")), Some("image/tiff"));
        assert_eq!(drop_media_type(Path::new("live.heic")), Some("image/heic"));
        assert_eq!(drop_media_type(Path::new("notes.txt")), None);
        assert_eq!(drop_media_type(Path::new("Makefile")), None);
        assert_eq!(drop_media_type(Path::new("archive.tar.gz")), None);
    }

    #[test]
    fn read_dropped_files_reports_dirs_and_missing_paths() {
        let dir = std::env::temp_dir().join("muse-drop-test");
        let _ = std::fs::create_dir_all(&dir);
        let missing = dir.join("gone.png");
        let _ = std::fs::remove_file(&missing);
        let files = inspect_dropped_files(vec![dir.to_string_lossy().into_owned(), missing.to_string_lossy().into_owned()]).expect("drop read");
        assert_eq!(files.len(), 2);
        assert!(files[0].is_dir);
        assert!(files[0].error.is_none());
        assert!(files[1].error.is_some());
        assert!(files[1].base64_data.is_none());
    }

    #[test]
    fn read_dropped_files_inlines_small_images() {
        let dir = std::env::temp_dir().join("muse-drop-test");
        let _ = std::fs::create_dir_all(&dir);
        let image = dir.join("tiny.png");
        std::fs::write(&image, [0x89, b'P', b'N', b'G']).expect("write fixture");
        let files = inspect_dropped_files(vec![image.to_string_lossy().into_owned()]).expect("drop read");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].media_type.as_deref(), Some("image/png"));
        assert!(files[0].base64_data.is_some());
        assert!(files[0].error.is_none());
        let _ = std::fs::remove_file(&image);
    }

    #[test]
    fn read_dropped_files_caps_batch_size() {
        let paths: Vec<String> = (0..DROP_FILE_LIMIT + 5).map(|n| format!("/definitely/missing/file-{n}.txt")).collect();
        let files = inspect_dropped_files(paths).expect("drop read");
        assert_eq!(files.len(), DROP_FILE_LIMIT);
    }

    #[test]
    fn grant_ids_are_valid_and_unique() {
        let ids: Vec<String> = (0..500).map(|_| mint_grant_id()).collect();
        assert!(ids.iter().all(|id| valid_grant_id(id)));
        let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), ids.len());
        assert!(!valid_grant_id("wg-short"));
        assert!(!valid_grant_id("wg-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
        assert!(!valid_grant_id(""));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("has space"));
        assert!(!valid_session_id(&"x".repeat(513)));
        assert!(valid_session_id("01a0bcbb-8b53-7df0-8a17-08a6702c9d68"));
    }

    #[test]
    fn grants_serialize_and_drop_stale_entries() {
        let dir = std::env::temp_dir().join(format!("muse-grants-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let live = dir.join("live");
        let _ = std::fs::create_dir_all(&live);
        let mut grants = HashMap::new();
        grants.insert(mint_grant_id(), live.canonicalize().unwrap());
        let loaded = parse_grants(&render_grants(&grants).expect("render"));
        assert_eq!(loaded.len(), 1);
        // Stale roots and malformed ids fail closed on load.
        let mut tampered = grants.clone();
        tampered.insert(mint_grant_id(), dir.join("deleted-folder"));
        tampered.insert("not-an-id".into(), live.canonicalize().unwrap());
        let reloaded = parse_grants(&render_grants(&tampered).expect("render"));
        assert_eq!(reloaded.len(), 1);
        assert!(parse_grants("not json").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grant_containment_checks_escape() {
        let dir = std::env::temp_dir().join(format!("muse-grant-path-{}", std::process::id()));
        let child = dir.join("repo");
        let _ = std::fs::create_dir_all(&child);
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), dir.canonicalize().unwrap());
        assert!(path_within_grant(&state, &id, &child).unwrap());
        assert!(path_within_grant(&state, &id, &dir).unwrap());
        assert!(!path_within_grant(&state, &id, Path::new("/definitely/not/granted")).unwrap());
        assert!(path_within_grant(&state, "wg-00000000000000000000000000000000", &child).is_err());
        assert!(grant_root(&state, "wg-00000000000000000000000000000000").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn containment_rejects_sibling_prefix_and_symlink_escape() {
        let dir = std::env::temp_dir().join(format!("muse-grant-sib-{}", std::process::id()));
        let root = dir.join("repo");
        let sibling = dir.join("repo-evil");
        let _ = std::fs::create_dir_all(&root);
        let _ = std::fs::create_dir_all(&sibling);
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), root.canonicalize().unwrap());
        // String-prefix sibling shares characters but no path components.
        assert!(!path_within_grant(&state, &id, &sibling).unwrap());
        // A symlink inside the grant pointing out resolves outside.
        #[cfg(unix)]
        {
            let outside = dir.join("outside");
            let _ = std::fs::create_dir_all(&outside);
            std::fs::write(outside.join("secret.txt"), b"nope").expect("fixture");
            let link = root.join("escape");
            let _ = std::os::unix::fs::symlink(&outside, &link);
            assert!(!path_within_grant(&state, &id, &link.join("secret.txt")).unwrap());
            // .. segments that stay inside still verify.
            let sub = root.join("sub");
            let _ = std::fs::create_dir_all(&sub);
            assert!(path_within_grant(&state, &id, &sub.join("..")).unwrap());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revocation_drops_sessions_and_approvals() {
        let state = AppState::new();
        state.sessions.lock().unwrap().insert("s-keep".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        state.sessions.lock().unwrap().insert("s-drop".into(), "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into());
        state.approvals.lock().unwrap().insert("a-drop".into(), ("s-drop".into(), "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()));
        state.approvals.lock().unwrap().insert("a-keep".into(), ("s-keep".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()));
        drop_grant_bindings(&state, "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let sessions = state.sessions.lock().unwrap();
        assert!(sessions.contains_key("s-keep"));
        assert!(!sessions.contains_key("s-drop"));
        drop(sessions);
        let approvals = state.approvals.lock().unwrap();
        assert!(approvals.contains_key("a-keep"));
        assert!(!approvals.contains_key("a-drop"));
    }

    #[test]
    fn approval_events_track_ownership_and_prune() {
        let state = AppState::new();
        state.sessions.lock().unwrap().insert("s-1".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        // Unbound sessions never record approvals.
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-x", "sessionId": "s-ghost" } }));
        assert!(state.approvals.lock().unwrap().is_empty());
        // Bound sessions record; resolution prunes.
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-1", "sessionId": "s-1" } }));
        assert_eq!(state.approvals.lock().unwrap().get("a-1"), Some(&("s-1".to_string(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string())));
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approvalResolved", "payload": { "approvalId": "a-1", "sessionId": "s-1" } }));
        assert!(state.approvals.lock().unwrap().is_empty());
        // Turn end prunes the whole session; host death clears everything.
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-2", "sessionId": "s-1" } }));
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "turnCompleted", "payload": { "sessionId": "s-1", "turnId": "t" } }));
        assert!(state.approvals.lock().unwrap().is_empty());
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-3", "sessionId": "s-1" } }));
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "hostExit", "payload": {} }));
        assert!(state.approvals.lock().unwrap().is_empty());
        // Malformed events never panic.
        snoop_bridge_event(&state, &json!({ "type": "event" }));
        snoop_bridge_event(&state, &json!({ "id": "x", "ok": true }));
    }

    #[test]
    fn duplicate_in_flight_ids_are_rejected() {
        let state = AppState::new();
        assert!(track_pending(&state, "dup", "listSessions", None));
        assert!(!track_pending(&state, "dup", "startSession", None));
    }

    #[test]
    fn fork_responses_bind_to_the_source_grant() {
        let state = AppState::new();
        let grant = mint_grant_id();
        state.grants.lock().unwrap().insert(grant.clone(), PathBuf::from("/tmp"));
        state.sessions.lock().unwrap().insert("s-src".into(), grant.clone());
        track_pending(&state, "call-fork", "forkSession", Some(grant.clone()));
        snoop_bridge_response(&state, &json!({ "id": "call-fork", "ok": true, "result": { "sessionId": "s-fork" } }));
        assert_eq!(state.sessions.lock().unwrap().get("s-fork"), Some(&grant));
    }

    #[test]
    fn unbound_sessions_are_rejected() {
        let state = AppState::new();
        assert!(require_session(&state, "nope-missing").is_err());
        assert!(require_session(&state, "").is_err());
        state.sessions.lock().unwrap().insert("s-bound".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        assert!(require_session(&state, "s-bound").is_ok());
    }

    #[test]
    fn bridge_responses_bind_sessions_to_the_calling_grant() {
        let state = AppState::new();
        let grant = mint_grant_id();
        state.grants.lock().unwrap().insert(grant.clone(), PathBuf::from("/tmp"));
        track_pending(&state, "call-1", "startSession", Some(grant.clone()));
        track_pending(&state, "call-2", "listSessions", Some(grant.clone()));
        snoop_bridge_response(&state, &json!({ "id": "call-1", "ok": true, "result": { "sessionId": "s-new" } }));
        snoop_bridge_response(&state, &json!({ "id": "call-2", "ok": true, "result": { "sessions": [{ "sessionId": "s-a" }, { "sessionId": "s-b" }] } }));
        let sessions = state.sessions.lock().unwrap();
        assert_eq!(sessions.get("s-new"), Some(&grant));
        assert_eq!(sessions.get("s-a"), Some(&grant));
        assert_eq!(sessions.get("s-b"), Some(&grant));
        assert!(state.pending.lock().unwrap().is_empty(), "attribution is single-shot");
    }

    #[test]
    fn snoop_binds_nothing_without_attribution_or_on_failure() {
        let state = AppState::new();
        let grant = mint_grant_id();
        state.grants.lock().unwrap().insert(grant.clone(), PathBuf::from("/tmp"));
        // Unknown call id: no binding.
        snoop_bridge_response(&state, &json!({ "id": "ghost", "ok": true, "result": { "sessionId": "s-ghost" } }));
        // Failed call: no binding.
        track_pending(&state, "call-9", "startSession", Some(grant.clone()));
        snoop_bridge_response(&state, &json!({ "id": "call-9", "ok": false, "error": "denied" }));
        // Grant revoked before the response landed: no binding.
        track_pending(&state, "call-10", "startSession", Some("wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()));
        snoop_bridge_response(&state, &json!({ "id": "call-10", "ok": true, "result": { "sessionId": "s-revoked" } }));
        // Malformed lines never panic and bind nothing.
        snoop_bridge_response(&state, &json!({ "type": "event" }));
        snoop_bridge_response(&state, &json!({ "id": "call-9" }));
        assert!(state.sessions.lock().unwrap().is_empty());
    }

    fn wait_until(mut check: impl FnMut() -> bool, ms: u64) -> bool {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(ms) {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        check()
    }

    /// Native-shell e2e through `mock_app` + a real spawned bridge process
    /// (tests/fixtures/stub-bridge.mjs): the grant → session → approval →
    /// export → relaunch → crash-recovery flow the packaged app runs, minus
    /// the dialog gestures themselves. Skips when Node is absent.
    #[test]
    fn native_shell_e2e_grant_session_approval_export_relaunch() {
        if which::which("node").is_err() {
            eprintln!("skipping native e2e: node is not on PATH");
            return;
        }
        let pid = std::process::id();
        // Grants must never touch the user's real keyring entry in tests.
        let grants_account = format!("e2e-grants-{pid}");
        std::env::set_var("MUSE_TEST_GRANTS_ACCOUNT", &grants_account);
        // Non-temp scratch dirs: exec validation rejects /tmp, and grant roots
        // must exist on disk.
        let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("e2e-{pid}"));
        let workspace = scratch.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let stub = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/stub-bridge.mjs")
            .canonicalize()
            .unwrap();
        std::env::set_var("MUSE_BRIDGE_SCRIPT", &stub);

        use tauri::Listener;
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        let handle = app.handle().clone();
        // The reader thread forwards every bridge line as a `bridge-line`
        // event; capture them to assert the response round-trip, not just
        // the request write.
        let lines = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        app.listen("bridge-line", move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });
        let call = |id: &str, method: &str, params: Value| {
            bridge_request(handle.clone(), app.state::<AppState>(), id.to_string(), method.to_string(), params)
        };
        let response_for = |lines: &Mutex<Vec<String>>, id: &str| -> Option<Value> {
            lines.lock().unwrap().iter().find_map(|line| {
                let value: Value = serde_json::from_str(line).ok()?;
                (value.get("id").and_then(Value::as_str) == Some(id)).then_some(value)
            })
        };

        // Grant minting: dedupe by canonical root; persisted via the test account.
        let canon = workspace.canonicalize().unwrap();
        let state = app.state::<AppState>();
        let grant = mint_grant(&state, canon.clone()).unwrap();
        let again = mint_grant(&state, canon.clone()).unwrap();
        assert_eq!(grant.grant_id, again.grant_id, "re-picking a root returns its grant");

        // A session call without a grant id is refused before the bridge.
        assert!(call("n0", "startSession", json!({})).is_err());

        // The grant-bound call injects workspaceRoot natively (the stub refuses
        // otherwise) and the response binds session -> grant via the snoop.
        call("r1", "startSession", json!({ "grantId": grant.grant_id })).unwrap();
        assert!(wait_until(|| state.sessions.lock().unwrap().get("s-1") == Some(&grant.grant_id), 5_000), "session did not bind to the grant");

        // The stub's approval event binds approval -> (session, grant).
        assert!(wait_until(|| state.approvals.lock().unwrap().contains_key("a-1"), 5_000), "approval never arrived");
        // A decision for the wrong session is refused natively; the owning
        // session's decision forwards to the bridge and back.
        assert!(call("r2", "decideApproval", json!({ "approvalId": "a-1", "sessionId": "s-other", "choiceId": "deny" })).is_err());
        call("r3", "decideApproval", json!({ "approvalId": "a-1", "sessionId": "s-1", "choiceId": "deny" })).unwrap();
        assert!(wait_until(|| response_for(&lines, "r3").is_some(), 5_000), "decideApproval response never arrived");
        assert_eq!(response_for(&lines, "r3").unwrap().get("result").unwrap().get("decided").unwrap(), "deny");

        // Bound session verbs forward; unbound sessions fail closed.
        call("r4", "sendTurn", json!({ "sessionId": "s-1", "text": "hi" })).unwrap();
        call("r5", "cancelTurn", json!({ "sessionId": "s-1" })).unwrap();
        assert!(call("r6", "sendTurn", json!({ "sessionId": "s-nope", "text": "x" })).is_err());
        assert!(wait_until(|| response_for(&lines, "r4").is_some() && response_for(&lines, "r5").is_some(), 5_000), "turn responses never arrived");

        // Export: a fixture `muse` under target/ (non-temp, executable, right
        // name) satisfies exec validation and writes the export file. The
        // fixture is a POSIX script, so this half only runs on unix.
        #[cfg(unix)]
        {
            let bin_dir = scratch.join("bin");
            std::fs::create_dir_all(&bin_dir).unwrap();
            let fake = bin_dir.join("muse");
            std::fs::write(&fake, "#!/bin/sh\nout=\"\"\nsess=\"\"\nwhile [ $# -gt 0 ]; do case \"$1\" in --out) shift; out=\"$1\";; --session) shift; sess=\"$1\";; esac; shift; done\nprintf '{\"exported\":true,\"session\":\"%s\"}\\n' \"$sess\" > \"$out\"\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
            let out = scratch.join("export.json");
            let written = export_to_path(&state, "s-1", out.to_str().unwrap(), fake.to_str().unwrap(), false).unwrap();
            assert_eq!(written, out.to_string_lossy());
            assert!(std::fs::read_to_string(&out).unwrap().contains("\"exported\":true"));
            assert!(export_to_path(&state, "s-nope", out.to_str().unwrap(), fake.to_str().unwrap(), false).is_err());
        }

        // Relaunch: grants reload from the persisted blob; live session
        // bindings do not survive a restart.
        let restored = parse_grants(&render_grants(&state.grants.lock().unwrap()).unwrap());
        let relaunched = AppState::new();
        relaunched.grants.lock().unwrap().extend(restored);
        assert!(grant_root(&relaunched, &grant.grant_id).is_ok());
        assert!(require_session(&relaunched, "s-1").is_err());

        // Bridge crash: the next request respawns the stub and succeeds.
        {
            let mut guard = state.bridge.lock().unwrap();
            let bridge = guard.as_mut().unwrap();
            let _ = bridge.child.kill();
            let _ = bridge.child.wait();
        }
        call("r9", "ping", json!({})).unwrap();
        assert!(wait_until(|| response_for(&lines, "r9").and_then(|v| v.get("result").and_then(|r| r.get("pong")).cloned()) == Some(json!(true)), 5_000), "ping after respawn never returned");

        // Teardown: stop the bridge, drop the test keychain entry, scratch dirs.
        if let Some(bridge) = state.bridge.lock().unwrap().as_mut() {
            let _ = bridge.child.kill();
            let _ = bridge.child.wait();
        }
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            let _ = keyring::Entry::new("com.musecode.desktop", &grants_account).map(|e| e.delete_credential());
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
