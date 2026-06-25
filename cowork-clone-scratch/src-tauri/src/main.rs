// Tauri shell — multiplex JSON-RPC requests and stream sidecar events to React.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

type RpcResult = Result<serde_json::Value, String>;
type PendingRequests = Arc<Mutex<HashMap<String, mpsc::Sender<RpcResult>>>>;

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Default)]
struct SidecarState {
    process: Arc<Mutex<Option<SidecarProcess>>>,
    pending: PendingRequests,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    request_id: String,
    event: serde_json::Value,
}

#[tauri::command]
fn spawn_sidecar(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<(), String> {
    let mut process_guard = state.process.lock().map_err(|error| error.to_string())?;
    if process_guard.is_some() {
        return Ok(());
    }

    let project_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    let mut command = if cfg!(debug_assertions) {
        let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
        let mut command = Command::new(npm);
        command.args(["--silent", "run", "sidecar"]);
        if let Some(directory) = project_dir {
            command.current_dir(directory);
        }
        command
    } else {
        let executable_name = if cfg!(target_os = "windows") {
            "cowork-sidecar.exe"
        } else {
            "cowork-sidecar"
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate application executable: {error}"))?
            .parent()
            .ok_or("Could not locate application binary directory")?
            .join(executable_name);
        Command::new(executable)
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        command.env("COWORK_RESOURCE_DIR", resource_dir);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Failed to spawn sidecar: {error}"))?;

    let stdin = child.stdin.take().ok_or("Sidecar stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("Sidecar stdout is unavailable")?;
    let pending = Arc::clone(&state.pending);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(error) => {
                    reject_all(&pending, format!("Failed to read sidecar output: {error}"));
                    return;
                }
            };
            let response: RpcResponse = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("Invalid sidecar response: {error}");
                    continue;
                }
            };

            if let Some(event) = response.event {
                let _ = app.emit(
                    "agent-event",
                    AgentEventPayload { request_id: response.id, event },
                );
                continue;
            }

            let sender = pending
                .lock()
                .ok()
                .and_then(|mut requests| requests.remove(&response.id));
            if let Some(sender) = sender {
                let result = if let Some(error) = response.error {
                    Err(error.to_string())
                } else {
                    Ok(response.result.unwrap_or(serde_json::Value::Null))
                };
                let _ = sender.send(result);
            }
        }
        reject_all(&pending, "Sidecar closed its output stream".to_string());
    });

    *process_guard = Some(SidecarProcess { child, stdin });
    Ok(())
}

fn reject_all(pending: &PendingRequests, message: String) {
    if let Ok(mut requests) = pending.lock() {
        for (_, sender) in requests.drain() {
            let _ = sender.send(Err(message.clone()));
        }
    }
}

fn call_sidecar_blocking(
    state: SidecarState,
    method: String,
    params: serde_json::Value,
) -> RpcResult {
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = RpcRequest { id: request_id.clone(), method, params };
    let request_json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let (sender, receiver) = mpsc::channel();

    state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request_id.clone(), sender);

    let write_result = (|| {
        let mut process_guard = state.process.lock().map_err(|error| error.to_string())?;
        let process = process_guard.as_mut().ok_or("Sidecar not running")?;
        writeln!(process.stdin, "{request_json}").map_err(|error| error.to_string())?;
        process.stdin.flush().map_err(|error| error.to_string())
    })();

    if let Err(error) = write_result {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&request_id);
        }
        return Err(error);
    }

    receiver.recv().map_err(|error| error.to_string())?
}

async fn call_sidecar_async(
    state: State<'_, SidecarState>,
    method: &str,
    params: serde_json::Value,
) -> RpcResult {
    let owned_state = state.inner().clone();
    let owned_method = method.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        call_sidecar_blocking(owned_state, owned_method, params)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn call_sidecar(
    state: State<'_, SidecarState>,
    method: String,
    params: serde_json::Value,
) -> RpcResult {
    call_sidecar_async(state, &method, params).await
}

#[tauri::command]
async fn grant_folder(state: State<'_, SidecarState>, folder: String) -> RpcResult {
    call_sidecar_async(state, "grant_folder", serde_json::json!({ "folder": folder })).await
}

#[tauri::command]
async fn list_granted_folders(state: State<'_, SidecarState>) -> RpcResult {
    call_sidecar_async(state, "list_granted_folders", serde_json::json!({})).await
}

#[tauri::command]
async fn list_skills(state: State<'_, SidecarState>) -> RpcResult {
    call_sidecar_async(state, "list_skills", serde_json::json!({})).await
}

#[tauri::command]
async fn list_tools(state: State<'_, SidecarState>) -> RpcResult {
    call_sidecar_async(state, "list_tools", serde_json::json!({})).await
}

#[tauri::command]
async fn run(
    state: State<'_, SidecarState>,
    message: String,
    history: Vec<serde_json::Value>,
    workspace: Option<String>,
    run_id: String,
    conversation_id: Option<String>,
) -> RpcResult {
    call_sidecar_async(
        state,
        "run",
        serde_json::json!({
            "message": message,
            "history": history,
            "workspace": workspace,
            "runId": run_id,
            "conversationId": conversation_id,
        }),
    )
    .await
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
