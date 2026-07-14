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
const STAGED_SKETCH_NAME: &str = "TraceSketch";
const AI_SYSTEM_PROMPT: &str = "You are the optional Trace IDE assistant. Help with ESP32, Arduino, C++, build errors, uploads, and embedded debugging. Be concise, practical, and explicit when uncertain. Prefer the smallest safe fix. You only know code or logs the user deliberately includes in chat. When a request includes <trace-current-code> and asks you to write or change the open sketch, return the complete replacement sketch inside exactly one <trace-code>...</trace-code> block. Never put partial code in that block.";

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

fn stage_sketch_source(sketch_code: &str) -> Result<String, String> {
    let sketch_dir = env::temp_dir()
        .join("trace-arduino")
        .join(STAGED_SKETCH_NAME);
    fs::create_dir_all(&sketch_dir).map_err(|error| {
        format!(
            "Could not create Arduino build directory {}: {error}",
            sketch_dir.display()
        )
    })?;
    let staged_file = sketch_dir.join(format!("{STAGED_SKETCH_NAME}.ino"));
    fs::write(&staged_file, sketch_code).map_err(|error| {
        format!(
            "Could not write temporary Arduino sketch {}: {error}",
            staged_file.display(),
        )
    })?;

    Ok(sketch_dir.to_string_lossy().into_owned())
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamChunk<'a> {
    request_id: &'a str,
    delta: &'a str,
}

#[derive(Debug, Serialize)]
struct AiModel {
    id: String,
    label: String,
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
    blocked_for_upload: AtomicBool,
}

#[derive(Deserialize)]
struct BoardListRoot {
    #[serde(default)]
    detected_ports: Vec<DetectedPort>,
}

#[derive(Deserialize)]
struct DetectedPort {
    #[serde(default)]
    address: String,
    #[serde(default)]
    label: String,
    #[serde(default, alias = "matching_boards")]
    boards: Vec<DetectedBoard>,
    #[serde(default)]
    port: Option<DetectedPortDetails>,
}

#[derive(Deserialize)]
struct DetectedPortDetails {
    #[serde(default)]
    address: String,
    #[serde(default)]
    label: String,
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
        let address = if port.address.trim().is_empty() {
            port.port
                .as_ref()
                .map(|details| details.address.trim())
                .unwrap_or_default()
        } else {
            port.address.trim()
        };
        if address.is_empty() {
            continue;
        }
        let esp32 = port
            .boards
            .iter()
            .find(|board| board.fqbn.starts_with("esp32:esp32:"));
        let any_board = port.boards.first();
        let detected = esp32.or(any_board);
        let name = detected
            .map(|board| board.name.clone())
            .filter(|name| !name.trim().is_empty())
            .or_else(|| (!port.label.trim().is_empty()).then_some(port.label.clone()))
            .or_else(|| {
                port.port
                    .as_ref()
                    .map(|details| details.label.trim())
                    .filter(|label| !label.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "ESP32 board".to_owned());
        let fqbn = esp32
            .map(|board| board.fqbn.clone())
            .filter(|fqbn| !fqbn.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ESP32_FQBN.to_owned());
        result.push(Board {
            name,
            port: address.to_owned(),
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
        let hint = if lower.contains("access is denied") || lower.contains("permission denied") {
            Some("Serial port permission denied. On Linux, add your user to the port's dialout or uucp group, then sign out and back in.")
        } else if lower.contains("resource busy") || lower.contains("device or resource busy") {
            Some("The serial port is busy. Close other serial monitors or applications using the port, then try again.")
        } else {
            None
        };
        if let Some(hint) = hint {
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
    sketch_code: String,
    fqbn: String,
) -> Result<OperationResult, String> {
    let staged_sketch = stage_sketch_source(&sketch_code)?;
    run_tool(
        app,
        state,
        "compile",
        vec!["compile".into(), "--fqbn".into(), fqbn, staged_sketch],
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
    sketch_code: String,
    port: String,
    fqbn: String,
) -> Result<OperationResult, String> {
    let staged_sketch = stage_sketch_source(&sketch_code)?;
    if serial_state.blocked_for_upload.swap(true, Ordering::SeqCst) {
        return Err("An upload is already using the serial port.".to_owned());
    }

    let result = match stop_serial_session(&serial_state, "upload", Some(&app)) {
        Ok(_) => {
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
                    staged_sketch,
                ],
            )
            .await
        }
        Err(error) => Err(error),
    };
    serial_state
        .blocked_for_upload
        .store(false, Ordering::SeqCst);
    result
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
    if state.blocked_for_upload.load(Ordering::SeqCst) {
        return Err("The serial monitor is unavailable while an upload is running.".to_owned());
    }
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

fn emit_ai_delta(app: &AppHandle, request_id: &str, delta: &str) -> Result<(), String> {
    app.emit("ai-stream", AiStreamChunk { request_id, delta })
        .map_err(|error| format!("Could not update the AI panel: {error}"))
}

fn dispatch_sse_event<F>(data_lines: &mut Vec<String>, on_data: &mut F) -> Result<(), String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    if data_lines.is_empty() {
        return Ok(());
    }
    let data = data_lines.join("\n");
    data_lines.clear();
    if data != "[DONE]" {
        on_data(&data)?;
    }
    Ok(())
}

async fn read_sse<F>(
    mut response: reqwest::Response,
    provider: &str,
    mut on_data: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let mut pending = Vec::<u8>::new();
    let mut data_lines = Vec::<String>::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("{provider} stream failed: {error}"))?
    {
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let mut line = pending.drain(..=end).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = std::str::from_utf8(&line)
                .map_err(|_| format!("{provider} returned invalid stream text."))?;
            if line.is_empty() {
                dispatch_sse_event(&mut data_lines, &mut on_data)?;
            } else if let Some(data) = line.strip_prefix("data:") {
                data_lines.push(data.trim_start().to_owned());
            }
        }
    }
    if !pending.is_empty() {
        let line = std::str::from_utf8(&pending)
            .map_err(|_| format!("{provider} returned invalid stream text."))?;
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start().to_owned());
        }
    }
    dispatch_sse_event(&mut data_lines, &mut on_data)
}

fn stream_api_error(value: &Value) -> Option<String> {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/response/error/message")
                .and_then(Value::as_str)
        })
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(str::to_owned)
}

async fn ask_openai(
    app: &AppHandle,
    request_id: &str,
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[AiMessage],
) -> Result<String, String> {
    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "instructions": AI_SYSTEM_PROMPT,
            "input": messages,
            "max_output_tokens": 4096,
            "store": false,
            "stream": true
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach OpenAI: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_error(response, "OpenAI").await);
    }
    let mut output = String::new();
    read_sse(response, "OpenAI", |data| {
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("OpenAI returned an unreadable stream event: {error}"))?;
        if value.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                emit_ai_delta(app, request_id, delta)?;
                output.push_str(delta);
            }
        } else if matches!(
            value.get("type").and_then(Value::as_str),
            Some("error" | "response.failed")
        ) {
            return Err(stream_api_error(&value)
                .unwrap_or_else(|| "OpenAI could not complete the response.".to_owned()));
        }
        Ok(())
    })
    .await?;
    (!output.trim().is_empty())
        .then_some(output)
        .ok_or_else(|| "OpenAI returned no text response.".to_owned())
}

async fn ask_anthropic(
    app: &AppHandle,
    request_id: &str,
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[AiMessage],
) -> Result<String, String> {
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": model,
            "system": AI_SYSTEM_PROMPT,
            "messages": messages,
            "max_tokens": 4096,
            "stream": true
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Anthropic: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_error(response, "Anthropic").await);
    }
    let mut output = String::new();
    read_sse(response, "Anthropic", |data| {
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("Anthropic returned an unreadable stream event: {error}"))?;
        if value.get("type").and_then(Value::as_str) == Some("content_block_delta")
            && value.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
        {
            if let Some(delta) = value.pointer("/delta/text").and_then(Value::as_str) {
                emit_ai_delta(app, request_id, delta)?;
                output.push_str(delta);
            }
        } else if value.get("type").and_then(Value::as_str) == Some("error") {
            return Err(stream_api_error(&value)
                .unwrap_or_else(|| "Anthropic could not complete the response.".to_owned()));
        }
        Ok(())
    })
    .await?;
    (!output.trim().is_empty())
        .then_some(output)
        .ok_or_else(|| "Anthropic returned no text response.".to_owned())
}

async fn ask_gemini(
    app: &AppHandle,
    request_id: &str,
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[AiMessage],
) -> Result<String, String> {
    let model = model.strip_prefix("models/").unwrap_or(model);
    if !model
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("Google Gemini returned an invalid model identifier.".to_owned());
    }
    let contents = messages
        .iter()
        .map(|message| {
            json!({
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": message.content }]
            })
        })
        .collect::<Vec<_>>();
    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
        ))
        .header("x-goog-api-key", api_key)
        .json(&json!({
            "systemInstruction": { "parts": [{ "text": AI_SYSTEM_PROMPT }] },
            "contents": contents,
            "generationConfig": { "maxOutputTokens": 4096 }
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Google Gemini: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_error(response, "Google Gemini").await);
    }
    let mut output = String::new();
    read_sse(response, "Google Gemini", |data| {
        let value: Value = serde_json::from_str(data).map_err(|error| {
            format!("Google Gemini returned an unreadable stream event: {error}")
        })?;
        if let Some(message) = stream_api_error(&value) {
            return Err(message);
        }
        if let Some(parts) = value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
        {
            for delta in parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
            {
                emit_ai_delta(app, request_id, delta)?;
                output.push_str(delta);
            }
        }
        Ok(())
    })
    .await?;
    (!output.trim().is_empty())
        .then_some(output)
        .ok_or_else(|| "Google Gemini returned no text response.".to_owned())
}

fn custom_url(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|error| format!("The custom provider URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The custom provider URL must use http:// or https://.".to_owned());
    }
    Ok(url)
}

fn custom_models_url(endpoint: &str) -> Result<reqwest::Url, String> {
    let mut url = custom_url(endpoint)?;
    let path = url.path().trim_end_matches('/');
    let models_path = if let Some(base) = path.strip_suffix("/chat/completions") {
        format!("{base}/models")
    } else if let Some(base) = path.strip_suffix("/responses") {
        format!("{base}/models")
    } else {
        format!("{path}/models")
    };
    url.set_path(&models_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn ask_custom(
    app: &AppHandle,
    request_id: &str,
    client: &reqwest::Client,
    api_key: &str,
    messages: &[AiMessage],
    endpoint: &str,
    model: &str,
) -> Result<String, String> {
    let url = custom_url(endpoint)?;
    let mut compatible_messages = vec![json!({
        "role": "system",
        "content": AI_SYSTEM_PROMPT
    })];
    compatible_messages.extend(
        messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );
    let mut request = client.post(url).json(&json!({
        "model": model,
        "messages": compatible_messages,
        "max_tokens": 4096,
        "stream": true
    }));
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach the custom provider: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_error(response, "Custom provider").await);
    }
    let is_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    let mut output = String::new();
    if is_stream {
        read_sse(response, "Custom provider", |data| {
            let value: Value = serde_json::from_str(data).map_err(|error| {
                format!("The custom provider returned an unreadable stream event: {error}")
            })?;
            if let Some(message) = stream_api_error(&value) {
                return Err(message);
            }
            if let Some(delta) = value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
            {
                emit_ai_delta(app, request_id, delta)?;
                output.push_str(delta);
            }
            Ok(())
        })
        .await?;
    } else {
        let value = response.json::<Value>().await.map_err(|error| {
            format!("The custom provider returned an unreadable response: {error}")
        })?;
        let text = value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| "The custom provider returned no text response.".to_owned())?;
        emit_ai_delta(app, request_id, text)?;
        output.push_str(text);
    }
    (!output.trim().is_empty())
        .then_some(output)
        .ok_or_else(|| "The custom provider returned no text response.".to_owned())
}

fn parse_openai_models(value: &Value) -> Vec<AiModel> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .map(|id| AiModel {
            id: id.to_owned(),
            label: id.to_owned(),
        })
        .collect()
}

#[tauri::command]
async fn list_ai_models(
    provider: String,
    api_key: String,
    custom_url: Option<String>,
) -> Result<Vec<AiModel>, String> {
    if provider != "custom" && api_key.trim().is_empty() {
        return Err("Enter an API key before loading models.".to_owned());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("Could not initialize the AI client: {error}"))?;
    let response = match provider.as_str() {
        "openai" => client
            .get("https://api.openai.com/v1/models")
            .bearer_auth(api_key.trim())
            .send()
            .await
            .map_err(|error| format!("Could not reach OpenAI: {error}"))?,
        "anthropic" => client
            .get("https://api.anthropic.com/v1/models?limit=1000")
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .map_err(|error| format!("Could not reach Anthropic: {error}"))?,
        "gemini" => client
            .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000")
            .header("x-goog-api-key", api_key.trim())
            .send()
            .await
            .map_err(|error| format!("Could not reach Google Gemini: {error}"))?,
        "custom" => {
            let endpoint = custom_url.as_deref().unwrap_or_default();
            let mut request = client.get(custom_models_url(endpoint)?);
            if !api_key.trim().is_empty() {
                request = request.bearer_auth(api_key.trim());
            }
            request
                .send()
                .await
                .map_err(|error| format!("Could not reach the custom provider: {error}"))?
        }
        _ => return Err("Unsupported AI provider.".to_owned()),
    };
    if !response.status().is_success() {
        let label = match provider.as_str() {
            "openai" => "OpenAI",
            "anthropic" => "Anthropic",
            "gemini" => "Google Gemini",
            _ => "Custom provider",
        };
        return Err(provider_error(response, label).await);
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| format!("The provider returned an unreadable model list: {error}"))?;
    let mut models = match provider.as_str() {
        "anthropic" => value
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get("id")?.as_str()?;
                let label = model
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(id);
                Some(AiModel {
                    id: id.to_owned(),
                    label: label.to_owned(),
                })
            })
            .collect::<Vec<_>>(),
        "gemini" => value
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|model| {
                model
                    .get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_some_and(|methods| {
                        methods
                            .iter()
                            .any(|method| method.as_str() == Some("generateContent"))
                    })
            })
            .filter_map(|model| {
                let raw_id = model
                    .get("baseModelId")
                    .and_then(Value::as_str)
                    .or_else(|| model.get("name").and_then(Value::as_str))?;
                let id = raw_id.strip_prefix("models/").unwrap_or(raw_id);
                let label = model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id);
                Some(AiModel {
                    id: id.to_owned(),
                    label: label.to_owned(),
                })
            })
            .collect::<Vec<_>>(),
        _ => parse_openai_models(&value),
    };
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    models.sort_by_key(|model| model.label.to_lowercase());
    if models.is_empty() {
        return Err("The provider did not return any compatible text models.".to_owned());
    }
    Ok(models)
}

#[tauri::command]
async fn ask_ai(
    app: AppHandle,
    request_id: String,
    provider: String,
    api_key: String,
    model: String,
    messages: Vec<AiMessage>,
    custom_url: Option<String>,
) -> Result<String, String> {
    if provider != "custom" && api_key.trim().is_empty() {
        return Err("Add an API key in Trace settings first.".to_owned());
    }
    if messages.is_empty() {
        return Err("Enter a question for the assistant.".to_owned());
    }
    if request_id.trim().is_empty() {
        return Err("The assistant request is missing its stream identifier.".to_owned());
    }
    if model.trim().is_empty() {
        return Err("Select an AI model in Trace settings first.".to_owned());
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
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("Could not initialize the AI client: {error}"))?;
    match provider.as_str() {
        "openai" => {
            ask_openai(
                &app,
                &request_id,
                &client,
                api_key.trim(),
                model.trim(),
                &messages,
            )
            .await
        }
        "anthropic" => {
            ask_anthropic(
                &app,
                &request_id,
                &client,
                api_key.trim(),
                model.trim(),
                &messages,
            )
            .await
        }
        "gemini" => {
            ask_gemini(
                &app,
                &request_id,
                &client,
                api_key.trim(),
                model.trim(),
                &messages,
            )
            .await
        }
        "custom" => {
            ask_custom(
                &app,
                &request_id,
                &client,
                api_key.trim(),
                &messages,
                custom_url.as_deref().unwrap_or_default(),
                model.trim(),
            )
            .await
        }
        _ => Err("Unsupported AI provider.".to_owned()),
    }
}

pub fn run() {
    // WebKitGTK 2.52 can crash on Wayland/NVIDIA explicit-sync before the webview
    // finishes loading. This opt-out avoids that compositor path without disabling
    // WebKit's accelerated DMABUF renderer entirely.
    #[cfg(target_os = "linux")]
    if env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }

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
            list_ai_models,
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
    fn stages_unsaved_editor_source_as_a_valid_arduino_sketch() {
        let staged_dir =
            PathBuf::from(stage_sketch_source("void setup() {}\nvoid loop() {}\n").unwrap());
        let staged_file = staged_dir.join(format!("{STAGED_SKETCH_NAME}.ino"));

        assert_eq!(staged_dir.file_name().unwrap(), STAGED_SKETCH_NAME);
        assert_eq!(
            fs::read_to_string(staged_file).unwrap(),
            "void setup() {}\nvoid loop() {}\n"
        );
    }

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

    #[test]
    fn parses_current_arduino_cli_nested_port_shape() {
        let json = br#"{
          "detected_ports": [{
            "port": {
              "address": "/dev/ttyUSB0",
              "label": "/dev/ttyUSB0",
              "protocol": "serial"
            }
          }]
        }"#;
        assert_eq!(
            parse_board_list(json).unwrap(),
            vec![Board {
                name: "/dev/ttyUSB0".to_owned(),
                port: "/dev/ttyUSB0".to_owned(),
                fqbn: DEFAULT_ESP32_FQBN.to_owned(),
            }]
        );
    }

    #[test]
    fn derives_models_url_from_compatible_chat_endpoint() {
        assert_eq!(
            custom_models_url("http://localhost:11434/v1/chat/completions")
                .unwrap()
                .as_str(),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            custom_models_url("https://example.test/v1/responses?ignored=true")
                .unwrap()
                .as_str(),
            "https://example.test/v1/models"
        );
    }
}
