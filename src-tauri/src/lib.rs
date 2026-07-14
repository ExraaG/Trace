use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use serialport::SerialPort;
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::{io::AsyncBufReadExt, process::Command, sync::Mutex as AsyncMutex};

const DEFAULT_ESP32_FQBN: &str = "esp32:esp32:esp32";
const AI_SYSTEM_PROMPT: &str = "You are the optional Trace IDE assistant. Help with ESP32, Arduino, C++, build errors, uploads, and embedded debugging. Be concise, practical, and explicit when uncertain. Prefer the smallest safe fix. You only know code or logs the user deliberately includes in chat.";

fn arduino_cli_binary_name() -> &'static str {
    if cfg!(windows) {
        "arduino-cli.exe"
    } else {
        "arduino-cli"
    }
}

fn arduino_cli_path() -> PathBuf {
    if let Some(path) = env::var_os("TRACE_ARDUINO_CLI").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }

    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"));
    if let Some(home) = home {
        let managed = PathBuf::from(home)
            .join(".trace")
            .join("bin")
            .join(arduino_cli_binary_name());
        if managed.is_file() {
            return managed;
        }
    }

    #[cfg(target_os = "macos")]
    for path in [
        "/opt/homebrew/bin/arduino-cli",
        "/usr/local/bin/arduino-cli",
    ] {
        if Path::new(path).is_file() {
            return PathBuf::from(path);
        }
    }

    PathBuf::from(arduino_cli_binary_name())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Board {
    name: String,
    port: String,
    fqbn: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult {
    success: bool,
    exit_code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct ToolOutput<'a> {
    operation: &'a str,
    stream: &'a str,
    line: &'a str,
}

#[derive(Clone, Serialize)]
struct SerialLine<'a> {
    line: &'a str,
}

#[derive(Clone, Serialize)]
struct SerialStateEvent<'a> {
    open: bool,
    port: Option<&'a str>,
    reason: &'a str,
}

#[derive(Clone, Deserialize, Serialize)]
struct AiMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    #[serde(default)]
    output: Vec<OpenAiOutput>,
}

#[derive(Deserialize)]
struct OpenAiOutput {
    #[serde(default)]
    content: Vec<OpenAiContent>,
}

#[derive(Deserialize)]
struct OpenAiContent {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    #[serde(default)]
    content: Vec<AnthropicContent>,
}

#[derive(Deserialize)]
struct AnthropicContent {
    #[serde(default)]
    text: String,
}

#[derive(Default)]
struct ToolState {
    operation_lock: AsyncMutex<()>,
}

struct SerialSession {
    port_name: String,
    writer: Arc<Mutex<Box<dyn SerialPort>>>,
    stop: Arc<AtomicBool>,
    reader_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct SerialState {
    session: Mutex<Option<SerialSession>>,
}

#[derive(Deserialize)]
struct BoardListRoot {
    #[serde(default)]
    detected_ports: Vec<DetectedPort>,
}

#[derive(Deserialize)]
struct DetectedPort {
    address: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    boards: Vec<DetectedBoard>,
}

#[derive(Deserialize)]
struct DetectedBoard {
    name: String,
    #[serde(default)]
    fqbn: String,
}

fn friendly_command_error(command: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!(
            "Arduino CLI was not found at {}. Re-run the Trace installer or set TRACE_ARDUINO_CLI.",
            command.display()
        )
    } else {
        format!("Could not start {}: {error}", command.display())
    }
}

fn parse_board_list(bytes: &[u8]) -> Result<Vec<Board>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("arduino-cli returned invalid board JSON: {error}"))?;
    let root: BoardListRoot = serde_json::from_value(value)
        .map_err(|error| format!("Could not read arduino-cli board data: {error}"))?;

    let mut result = Vec::new();
    for port in root.detected_ports {
        let esp32 = port
            .boards
            .iter()
            .find(|board| board.fqbn.starts_with("esp32:esp32:"));
        let any_board = port.boards.first();
        let detected = esp32.or(any_board);
        let name = detected
            .map(|board| board.name.clone())
            .filter(|name| !name.trim().is_empty())
            .or_else(|| (!port.label.trim().is_empty()).then_some(port.label))
            .unwrap_or_else(|| "ESP32 board".to_owned());
        let fqbn = esp32
            .map(|board| board.fqbn.clone())
            .filter(|fqbn| !fqbn.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ESP32_FQBN.to_owned());
        result.push(Board {
            name,
            port: port.address,
            fqbn,
        });
    }
    result.sort_by(|left, right| left.port.cmp(&right.port));
    Ok(result)
}

#[tauri::command]
async fn list_boards() -> Result<Vec<Board>, String> {
    let command = arduino_cli_path();
    let output = Command::new(&command)
        .args(["board", "list", "--json"])
        .output()
        .await
        .map_err(|error| friendly_command_error(&command, error))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if details.is_empty() {
            "arduino-cli board detection failed.".to_owned()
        } else {
            format!("arduino-cli board detection failed: {details}")
        });
    }
    parse_board_list(&output.stdout)
}

#[tauri::command]
fn read_sketch(path: String) -> Result<String, String> {
    if Path::new(&path)
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("ino")
    {
        return Err("Trace can only open .ino sketch files.".to_owned());
    }
    fs::read_to_string(&path).map_err(|error| format!("Could not read {path}: {error}"))
}

#[tauri::command]
fn write_sketch(path: String, contents: String) -> Result<(), String> {
    if !path.to_ascii_lowercase().ends_with(".ino") {
        return Err("Trace can only save .ino sketch files.".to_owned());
    }
    fs::write(&path, contents).map_err(|error| format!("Could not write {path}: {error}"))
}

async fn stream_pipe<R>(
    reader: R,
    app: AppHandle,
    operation: &'static str,
    stream: &'static str,
) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = tokio::io::BufReader::new(reader).lines();
    let mut captured = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        captured.push_str(&line);
        captured.push('\n');
        let _ = app.emit(
            "tool-output",
            ToolOutput {
                operation,
                stream,
                line: &line,
            },
        );
    }
    captured
}

async fn run_tool(
    app: AppHandle,
    state: State<'_, ToolState>,
    operation: &'static str,
    args: Vec<String>,
) -> Result<OperationResult, String> {
    let _guard = state
        .operation_lock
        .try_lock()
        .map_err(|_| "Another compile or upload is already running.".to_owned())?;
    let command = arduino_cli_path();
    let mut child = Command::new(&command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| friendly_command_error(&command, error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not capture arduino-cli output.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not capture arduino-cli errors.")?;
    let stdout_task = tokio::spawn(stream_pipe(stdout, app.clone(), operation, "stdout"));
    let stderr_task = tokio::spawn(stream_pipe(stderr, app.clone(), operation, "stderr"));
    let status = child
        .wait()
        .await
        .map_err(|error| format!("arduino-cli stopped unexpectedly: {error}"))?;
    let (stdout_text, stderr_text) = tokio::join!(stdout_task, stderr_task);
    let stdout_text = stdout_text.unwrap_or_default();
    let stderr_text = stderr_text.unwrap_or_default();

    if !status.success() {
        let lower = format!("{stdout_text}\n{stderr_text}").to_ascii_lowercase();
        if lower.contains("resource busy")
            || lower.contains("access is denied")
            || lower.contains("permission denied")
            || lower.contains("device or resource busy")
        {
            let hint = "The serial port is busy. Close other serial monitors or applications using the port, then try again.";
            let _ = app.emit(
                "tool-output",
                ToolOutput {
                    operation,
                    stream: "stderr",
                    line: hint,
                },
            );
        }
    }

    Ok(OperationResult {
        success: status.success(),
        exit_code: status.code(),
    })
}

#[tauri::command]
async fn compile_sketch(
    app: AppHandle,
    state: State<'_, ToolState>,
    sketch_path: String,
    fqbn: String,
) -> Result<OperationResult, String> {
    run_tool(
        app,
        state,
        "compile",
        vec!["compile".into(), "--fqbn".into(), fqbn, sketch_path],
    )
    .await
}

fn stop_serial_session(
    state: &SerialState,
    reason: &str,
    app: Option<&AppHandle>,
) -> Result<bool, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "Serial state lock was poisoned.".to_owned())?;
    let Some(mut active) = session.take() else {
        return Ok(false);
    };
    active.stop.store(true, Ordering::Relaxed);
    let port_name = active.port_name.clone();
    drop(active.writer);
    if let Some(handle) = active.reader_thread.take() {
        let _ = handle.join();
    }
    if let Some(app) = app {
        let _ = app.emit(
            "serial-state",
            SerialStateEvent {
                open: false,
                port: Some(&port_name),
                reason,
            },
        );
    }
    Ok(true)
}

#[tauri::command]
async fn upload_sketch(
    app: AppHandle,
    tool_state: State<'_, ToolState>,
    serial_state: State<'_, SerialState>,
    sketch_path: String,
    port: String,
    fqbn: String,
) -> Result<OperationResult, String> {
    stop_serial_session(&serial_state, "upload", Some(&app))?;
    run_tool(
        app,
        tool_state,
        "upload",
        vec![
            "upload".into(),
            "-p".into(),
            port,
            "--fqbn".into(),
            fqbn,
            sketch_path,
        ],
    )
    .await
}

fn serial_reader(
    app: AppHandle,
    port: Arc<Mutex<Box<dyn SerialPort>>>,
    stop: Arc<AtomicBool>,
    port_name: String,
) {
    let mut pending = Vec::new();
    let mut buffer = [0_u8; 512];
    while !stop.load(Ordering::Relaxed) {
        let read_result = match port.lock() {
            Ok(mut handle) => handle.read(&mut buffer),
            Err(_) => break,
        };
        match read_result {
            Ok(count) if count > 0 => {
                pending.extend_from_slice(&buffer[..count]);
                while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
                    let mut line = pending.drain(..=position).collect::<Vec<_>>();
                    while matches!(line.last(), Some(b'\n' | b'\r')) {
                        line.pop();
                    }
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let _ = app.emit("serial-line", SerialLine { line: &line });
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => {
                if !stop.load(Ordering::Relaxed) {
                    let _ = app.emit(
                        "serial-state",
                        SerialStateEvent {
                            open: false,
                            port: Some(&port_name),
                            reason: "disconnected",
                        },
                    );
                }
                break;
            }
        }
    }
}

#[tauri::command]
fn open_serial(
    app: AppHandle,
    state: State<'_, SerialState>,
    port: String,
    baud_rate: u32,
) -> Result<(), String> {
    stop_serial_session(&state, "replaced", Some(&app))?;
    let handle = serialport::new(&port, baud_rate)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|error| {
            format!(
                "Could not open {port} at {baud_rate} baud: {error}. The port may be busy or unavailable."
            )
        })?;
    let writer = Arc::new(Mutex::new(handle));
    let stop = Arc::new(AtomicBool::new(false));
    let thread_writer = Arc::clone(&writer);
    let thread_stop = Arc::clone(&stop);
    let thread_app = app.clone();
    let thread_port = port.clone();
    let reader_thread = thread::Builder::new()
        .name("trace-serial-reader".to_owned())
        .spawn(move || serial_reader(thread_app, thread_writer, thread_stop, thread_port))
        .map_err(|error| format!("Could not start serial reader: {error}"))?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| "Serial state lock was poisoned.".to_owned())?;
    *session = Some(SerialSession {
        port_name: port.clone(),
        writer,
        stop,
        reader_thread: Some(reader_thread),
    });
    let _ = app.emit(
        "serial-state",
        SerialStateEvent {
            open: true,
            port: Some(&port),
            reason: "opened",
        },
    );
    Ok(())
}

#[tauri::command]
fn close_serial(
    app: AppHandle,
    state: State<'_, SerialState>,
    reason: String,
) -> Result<(), String> {
    stop_serial_session(&state, &reason, Some(&app)).map(|_| ())
}

#[tauri::command]
fn write_serial(state: State<'_, SerialState>, data: String) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Serial state lock was poisoned.".to_owned())?;
    let active = session.as_ref().ok_or("The serial port is not open.")?;
    let mut port = active
        .writer
        .lock()
        .map_err(|_| "Serial port lock was poisoned.".to_owned())?;
    port.write_all(data.as_bytes())
        .and_then(|_| port.flush())
        .map_err(|error| format!("Could not write to {}: {error}", active.port_name))
}

async fn provider_error(response: reqwest::Response, provider: &str) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| body.chars().take(800).collect());
    if message.is_empty() {
        format!("{provider} returned HTTP {status}.")
    } else {
        format!("{provider} returned HTTP {status}: {message}")
    }
}

async fn ask_openai(
    client: &reqwest::Client,
    api_key: &str,
    messages: &[AiMessage],
) -> Result<String, String> {
    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&json!({
            "model": "gpt-5.6-luna",
            "instructions": AI_SYSTEM_PROMPT,
            "input": messages,
            "max_output_tokens": 2048,
            "reasoning": { "effort": "low" },
            "store": false
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach OpenAI: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_error(response, "OpenAI").await);
    }
    let value = response
        .json::<OpenAiResponse>()
        .await
        .map_err(|error| format!("OpenAI returned an unreadable response: {error}"))?;
    let text = value
        .output
        .into_iter()
        .flat_map(|item| item.content)
        .map(|content| content.text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty())
        .then_some(text)
        .ok_or_else(|| "OpenAI returned no text response.".to_owned())
}

async fn ask_anthropic(
    client: &reqwest::Client,
    api_key: &str,
    messages: &[AiMessage],
) -> Result<String, String> {
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": "claude-sonnet-5",
            "system": AI_SYSTEM_PROMPT,
            "messages": messages,
            "max_tokens": 2048
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Anthropic: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_error(response, "Anthropic").await);
    }
    let value = response
        .json::<AnthropicResponse>()
        .await
        .map_err(|error| format!("Anthropic returned an unreadable response: {error}"))?;
    let text = value
        .content
        .into_iter()
        .map(|content| content.text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty())
        .then_some(text)
        .ok_or_else(|| "Anthropic returned no text response.".to_owned())
}

#[tauri::command]
async fn ask_ai(
    provider: String,
    api_key: String,
    messages: Vec<AiMessage>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Add an API key in Trace settings first.".to_owned());
    }
    if messages.is_empty() {
        return Err("Enter a question for the assistant.".to_owned());
    }
    if messages.iter().any(|message| {
        !matches!(message.role.as_str(), "user" | "assistant") || message.content.trim().is_empty()
    }) {
        return Err("The assistant request contains an invalid message.".to_owned());
    }
    let total_bytes = messages
        .iter()
        .map(|message| message.content.len())
        .sum::<usize>();
    if total_bytes > 100_000 {
        return Err(
            "The assistant conversation is too large. Start a shorter conversation.".to_owned(),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Could not initialize the AI client: {error}"))?;
    match provider.as_str() {
        "openai" => ask_openai(&client, api_key.trim(), &messages).await,
        "anthropic" => ask_anthropic(&client, api_key.trim(), &messages).await,
        _ => Err("Unsupported AI provider.".to_owned()),
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ToolState::default())
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            list_boards,
            read_sketch,
            write_sketch,
            compile_sketch,
            upload_sketch,
            open_serial,
            close_serial,
            write_serial,
            ask_ai
        ])
        .build(tauri::generate_context!())
        .expect("error while building Trace");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            let state = handle.state::<SerialState>();
            let _ = stop_serial_session(&state, "app-exit", None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_detected_esp32_board() {
        let json = br#"{
          "detected_ports": [{
            "address": "/dev/ttyUSB0",
            "label": "USB Serial",
            "boards": [{"name": "ESP32 Dev Module", "fqbn": "esp32:esp32:esp32"}]
          }]
        }"#;
        assert_eq!(
            parse_board_list(json).unwrap(),
            vec![Board {
                name: "ESP32 Dev Module".to_owned(),
                port: "/dev/ttyUSB0".to_owned(),
                fqbn: "esp32:esp32:esp32".to_owned(),
            }]
        );
    }

    #[test]
    fn gives_unknown_serial_ports_a_working_esp32_default() {
        let json = br#"{
          "detected_ports": [{
            "address": "COM4",
            "label": "USB JTAG/serial debug unit",
            "boards": []
          }]
        }"#;
        assert_eq!(
            parse_board_list(json).unwrap(),
            vec![Board {
                name: "USB JTAG/serial debug unit".to_owned(),
                port: "COM4".to_owned(),
                fqbn: DEFAULT_ESP32_FQBN.to_owned(),
            }]
        );
    }
}
