use sha2::Digest;
use std::io::Read;
use std::path::PathBuf;

fn main() {
    // Bake the bridge script's SHA-256 into release builds so the sidecar
    // spawn verifies the resource before running it (SEC-02). The file may be
    // absent for plain `cargo test` (no bridge built yet) — debug builds never
    // consult the digest, and release packaging always builds the bridge via
    // `beforeBuildCommand` first.
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/muse-bridge/dist/index.js");
    println!("cargo:rerun-if-changed={}", script.display());
    match std::fs::File::open(&script) {
        Ok(file) => {
            let mut reader = std::io::BufReader::new(file);
            let mut hash = sha2::Sha256::new();
            let mut chunk = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => hash.update(&chunk[..read]),
                    Err(err) => {
                        println!("cargo:warning=bridge script unreadable: {err}");
                        println!("cargo:rustc-env=BRIDGE_SCRIPT_SHA256=none");
                        tauri_build::build();
                        return;
                    }
                }
            }
            println!("cargo:rustc-env=BRIDGE_SCRIPT_SHA256={:x}", hash.finalize());
        }
        Err(_) => {
            println!("cargo:rustc-env=BRIDGE_SCRIPT_SHA256=none");
        }
    }
    tauri_build::build()
}
