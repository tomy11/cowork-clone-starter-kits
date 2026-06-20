// Tauri shell — spawn the Node sidecar and bridge JSON-RPC over stdio.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct SidecarState {
    process: Mutex<Option<SidecarProcess>>,
}

#[derive(Serialize, Debug)]
struct RpcRequest {
    id: String,
    method: String,
    params: serde_json::Value,
}

#[derive(Deserialize, Debug)]
struct RpcResponse {
    id: String,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
    event: Option<serde_json::Value>,
}

#[tauri::command]
fn spawn_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let npm = if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    };
    let project_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Could not locate project directory")?;

    let mut child = Command::new(npm)
        .args(["--silent", "run", "sidecar"])
        .current_dir(project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    let stdin = child.stdin.take().ok_or("Sidecar stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("Sidecar stdout is unavailable")?;
    *guard = Some(SidecarProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    });
    Ok(())
}

fn call_sidecar_inner(
    state: &State<'_, SidecarState>,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut guard = state.process.lock().map_err(|e| e.to_string())?;
    let process = guard.as_mut().ok_or("Sidecar not running")?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = RpcRequest {
        id: request_id.clone(),
        method: method.to_string(),
        params,
    };

    let request_json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    writeln!(process.stdin, "{request_json}").map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())?;

    loop {
        let mut line = String::new();
        let bytes = process
            .stdout
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if bytes == 0 {
            return Err("Sidecar closed its output stream".to_string());
        }

        let response: RpcResponse = serde_json::from_str(&line)
            .map_err(|e| format!("Invalid sidecar response: {e}"))?;
        if response.id != request_id {
            continue;
        }
        if response.event.is_some() {
            continue;
        }
        if let Some(error) = response.error {
            return Err(error.to_string());
        }
        return Ok(response.result.unwrap_or(serde_json::Value::Null));
    }
}

#[tauri::command]
fn call_sidecar(
    state: State<'_, SidecarState>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    call_sidecar_inner(&state, &method, params)
}

#[tauri::command]
fn grant_folder(
    state: State<'_, SidecarState>,
    folder: String,
) -> Result<serde_json::Value, String> {
    call_sidecar_inner(
        &state,
        "grant_folder",
        serde_json::json!({ "folder": folder }),
    )
}

#[tauri::command]
fn list_granted_folders(state: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    call_sidecar_inner(&state, "list_granted_folders", serde_json::json!({}))
}

#[tauri::command]
fn list_skills(state: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    call_sidecar_inner(&state, "list_skills", serde_json::json!({}))
}

#[tauri::command]
fn list_tools(state: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    call_sidecar_inner(&state, "list_tools", serde_json::json!({}))
}

#[tauri::command]
fn run(
    state: State<'_, SidecarState>,
    message: String,
    history: Vec<serde_json::Value>,
    workspace: Option<String>,
) -> Result<serde_json::Value, String> {
    call_sidecar_inner(
        &state,
        "run",
        serde_json::json!({
            "message": message,
            "history": history,
            "workspace": workspace,
        }),
    )
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_sidecar,
            call_sidecar,
            grant_folder,
            list_granted_folders,
            list_skills,
            list_tools,
            run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
