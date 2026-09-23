use std::sync::Mutex;

// Serialize access: some platform credential stores do not support concurrent writes.
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.musecode.desktop", "muse-api-key")
        .map_err(|_| "Could not access the system credential store".into())
}

/// Workspace grants live in the OS keyring — NOT in a file under AppData,
/// where the store plugin (renderer-reachable, unscopable) could rewrite them.
/// The renderer has no command that writes this entry; it only ever holds ids.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn grants_entry() -> Result<keyring::Entry, String> {
    // Test seam (debug builds only): the e2e suite reroutes grants to a
    // throwaway account so the user's real entry is never touched.
    #[cfg(debug_assertions)]
    let account = std::env::var("MUSE_TEST_GRANTS_ACCOUNT").unwrap_or_else(|_| "workspace-grants".into());
    #[cfg(not(debug_assertions))]
    let account = "workspace-grants";
    keyring::Entry::new("com.musecode.desktop", &account)
        .map_err(|_| "Could not access the system credential store".into())
}

/// ACP agent identity pins (path + digest per agent). The renderer can read
/// them for display and confirm a drifted binary, but only the native side
/// resolves and records paths — a confirm accepts the actual binary on disk,
/// never a renderer-nominated string.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn agent_pins_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.musecode.desktop", "agent-pins")
        .map_err(|_| "Could not access the system credential store".into())
}

pub fn agent_pins_value() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    match agent_pins_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read agent pins from the system credential store.".into()),
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("Secure credential storage is unavailable on this platform".into())
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn acp_consent_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.musecode.desktop", "acp-isolation-consent")
        .map_err(|_| "Could not access the system credential store".into())
}

pub fn acp_consent_value() -> Result<bool, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    match acp_consent_entry()?.get_password() {
        Ok(value) => Ok(value == "1" || value.eq_ignore_ascii_case("true")),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Could not read ACP isolation consent from the system credential store.".into()),
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Ok(false)
}

pub fn acp_consent_store(consented: bool) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let entry = acp_consent_entry()?;
        if consented {
            entry.set_password("1").map_err(|_| "Could not save ACP isolation consent.".into())
        } else {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("Could not clear ACP isolation consent.".into()),
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = consented;
        Err("Secure credential storage is unavailable on this platform".into())
    }
}

#[tauri::command]
pub async fn acp_isolation_consent_get() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(acp_consent_value)
        .await
        .map_err(|_| "Credential store task failed".to_string())?
}

#[tauri::command]
pub async fn acp_isolation_consent_set(consented: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || acp_consent_store(consented))
        .await
        .map_err(|_| "Credential store task failed".to_string())?
}

pub fn agent_pins_store(raw: &str) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        agent_pins_entry()?
            .set_password(raw)
            .map_err(|_| "Could not save agent pins in the system credential store.".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("Secure credential storage is unavailable on this platform".into())
}

pub fn grants_value() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    match grants_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read workspace grants from the system credential store.".into()),
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("Secure credential storage is unavailable on this platform".into())
}

pub fn grants_store(raw: &str) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        grants_entry()?
            .set_password(raw)
            .map_err(|_| "Could not save workspace grants in the system credential store.".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("Secure credential storage is unavailable on this platform".into())
}

pub fn credential_value() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the API key from the system credential store. Unlock it and try again.".into()),
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("Secure credential storage is unavailable on this platform".into())
}

#[tauri::command]
pub async fn credential_get() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // The renderer only learns that a key exists. The native bridge injects
        // the actual value into trusted Muse lifecycle requests.
        credential_value().map(|value| value.map(|_| "••••••••".to_string()))
    }).await.map_err(|_| "Credential store task failed".to_string())?
}

#[tauri::command]
pub async fn credential_set(value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            let entry = entry()?;
            if value.is_empty() {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err("Could not remove the API key from the system credential store".into()),
                }
            } else {
                entry.set_password(&value).map_err(|_| "Could not save the API key in the system credential store. Unlock it and try again.".into())
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        Err("Secure credential storage is unavailable on this platform".into())
    }).await.map_err(|_| "Credential store task failed".to_string())?
}
