// Tauri shell — spawn Node sidecar, bridge stdio RPC to frontend

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<std::process::Child>>,
}

#[derive(Serialize, Deserialize, Debug)]
struct RpcRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug)]
struct RpcResponse {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<serde_json::Value>,
}

#[tauri::command]
fn spawn_sidecar(state: State<SidecarState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }

    // Detect Node binary
    let node_cmd = if cfg!(target_os = "windows") { "node.cmd" } else { "node" };

    // Path to compiled sidecar
    let sidecar_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .unwrap()
        .join("sidecar")
        .join("index.js");

    let mut child = Command::new(node_cmd)
        .arg(sidecar_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn call_sidecar(
    state: State<SidecarState>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut guard = state.child.lock().unwrap();
    let child = guard.as_mut().ok_or("Sidecar not running")?;

    let stdin = child.stdin.as_mut().ok_or("No stdin")?;
    let stdout = child.stdout.as_mut().ok_or("No stdout")?;

    let req = RpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        method,
        params,
    };

    let req_str = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
    stdin.write_all(req_str.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;

    let resp: RpcResponse = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if let Some(err) = resp.error {
        return Err(err.to_string());
    }
    Ok(resp.result.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn grant_folder(folder: String) -> Result<serde_json::Value, String> {
    call_sidecar_sync("grant_folder", serde_json::json!({ "folder": folder }))
}

#[tauri::command]
fn list_granted_folders() -> Result<serde_json::Value, String> {
    call_sidecar_sync("list_granted_folders", serde_json::json!({}))
}

#[tauri::command]
fn list_skills() -> Result<serde_json::Value, String> {
    call_sidecar_sync("list_skills", serde_json::json!({}))
}

#[tauri::command]
fn list_tools() -> Result<serde_json::Value, String> {
    call_sidecar_sync("list_tools", serde_json::json!({}))
}

#[tauri::command]
fn run(message: String, history: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    call_sidecar_sync(
        "run",
        serde_json::json!({ "message": message, "history": history }),
    )
}

// Helper — wraps the state call (Tauri command pattern)
fn call_sidecar_sync(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    // This is a placeholder — actual implementation uses Tauri State
    // In real code, refactor to share state between commands
    Err("Use the State-based command directly".to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarState::default())
        .setup(|_app| {
            // Auto-spawn sidecar on startup
            Ok(())
        })
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
        .expect("error while running tauri application");
}
