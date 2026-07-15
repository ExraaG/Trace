use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use serialport::SerialPort;
use std::{
    collections::{HashMap, HashSet},
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
    matched: bool,
    usb_label: String,
    vid: String,
    pid: String,
    identity_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult {
    success: bool,
    exit_code: Option<i32>,
    missing_header: Option<String>,
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

#[derive(Default)]
struct LibraryState {
    statuses: Mutex<HashMap<String, String>>,
    install_lock: Arc<AsyncMutex<()>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryInstallEvent<'a> {
    header: &'a str,
    package: &'a str,
    status: &'a str,
    progress: u8,
    message: &'a str,
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
    properties: HashMap<String, Value>,
    #[serde(default)]
    protocol_label: String,
    #[serde(default)]
    port: Option<DetectedPortDetails>,
}

#[derive(Deserialize)]
struct DetectedPortDetails {
    #[serde(default)]
    address: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    properties: HashMap<String, Value>,
    #[serde(default)]
    protocol_label: String,
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

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
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
        // A board explicitly identified as another Arduino family must not be
        // offered as an ESP32 target. Unknown USB-UART bridges remain usable
        // because many inexpensive ESP32 boards do not report an FQBN.
        if esp32.is_none() && !port.boards.is_empty() {
            continue;
        }
        let matched = esp32.is_some();
        let details = port.port.as_ref();
        let properties = details
            .map(|value| &value.properties)
            .unwrap_or(&port.properties);
        let property = |name: &str| {
            properties
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .and_then(|(_, value)| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_owned()
        };
        let vid = property("vid");
        let pid = property("pid");
        let product = property("product");
        let manufacturer = property("manufacturer");
        let serial = property("serialNumber");
        let nested_label = details
            .map(|value| value.label.as_str())
            .unwrap_or_default();
        let protocol_label = details
            .map(|value| value.protocol_label.as_str())
            .filter(|value| !value.is_empty())
            .unwrap_or(&port.protocol_label);
        let identity_text = format!(
            "{address} {} {nested_label} {protocol_label} {product} {manufacturer}",
            port.label
        )
        .to_ascii_lowercase();
        let unrelated_device = contains_any(
            &identity_text,
            &[
                "bluetooth",
                "modem",
                "gps",
                "gnss",
                "cellular",
                "printer",
                "scanner",
                "camera",
                "audio",
                "midi",
                "phone",
                "tablet",
                "keyboard",
                "mouse",
                "ups",
                "z-wave",
            ],
        );
        if !matched && unrelated_device {
            continue;
        }
        let usb_path = {
            let lower = address.to_ascii_lowercase();
            lower.contains("ttyusb")
                || lower.contains("ttyacm")
                || lower.contains("cu.usb")
                || lower.contains("tty.usb")
        };
        let bridge_hint = contains_any(
            &identity_text,
            &[
                "esp32",
                "espressif",
                "arduino",
                "cp210",
                "ch340",
                "ch341",
                "ft232",
                "ftdi",
                "usb serial",
                "usb-to-uart",
                "usb to uart",
                "uart bridge",
                "usb jtag",
                "usb cdc",
            ],
        );
        let has_usb_identity = !vid.is_empty()
            || !pid.is_empty()
            || identity_text.contains("serial port (usb)")
            || identity_text.contains("usb serial");
        let windows_usb_port =
            cfg!(windows) && address.to_ascii_lowercase().starts_with("com") && has_usb_identity;
        if !matched && !(usb_path || bridge_hint || windows_usb_port) {
            continue;
        }

        let name = esp32
            .map(|board| board.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Possible ESP32 board".to_owned());
        let fqbn = esp32
            .map(|board| board.fqbn.clone())
            .filter(|fqbn| !fqbn.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ESP32_FQBN.to_owned());
        let product_lower = product.to_ascii_lowercase();
        let usb_label = if product_lower.contains("cp2102") {
            "CP2102".to_owned()
        } else if product_lower.contains("cp210") {
            "CP210x".to_owned()
        } else if product_lower.contains("ch340") {
            "CH340".to_owned()
        } else if product_lower.contains("ch341") {
            "CH341".to_owned()
        } else if product_lower.contains("ft232")
            || manufacturer.to_ascii_lowercase().contains("ftdi")
        {
            "FTDI".to_owned()
        } else if !product.is_empty() {
            product
        } else if !vid.is_empty() || !pid.is_empty() {
            format!("USB serial {vid}:{pid}")
        } else {
            "USB serial".to_owned()
        };
        let identity_key = if !vid.is_empty() || !pid.is_empty() {
            if serial.is_empty() {
                format!("{address}|{vid}:{pid}")
            } else {
                format!("{vid}:{pid}:{serial}")
            }
        } else {
            address.to_owned()
        };
        result.push(Board {
            name,
            port: address.to_owned(),
            fqbn,
            matched,
            usb_label,
            vid,
            pid,
            identity_key,
        });
    }
    result.sort_by(|left, right| {
        right
            .matched
            .cmp(&left.matched)
            .then_with(|| left.port.cmp(&right.port))
    });
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

fn missing_header_from_output(output: &str) -> Option<String> {
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        let Some(error_start) = lower.find("fatal error:") else {
            continue;
        };
        let value_start = error_start + "fatal error:".len();
        let remainder = line[value_start..].trim();
        let remainder_lower = remainder.to_ascii_lowercase();
        for marker in [": no such file or directory", ": file not found"] {
            if let Some(end) = remainder_lower.find(marker) {
                let header = remainder[..end].trim().trim_matches(['<', '>', '"', '\'']);
                if !header.is_empty() {
                    return Some(header.to_owned());
                }
            }
        }
    }
    None
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
    let combined_output = format!("{stdout_text}\n{stderr_text}");
    let missing_header = (!status.success())
        .then(|| missing_header_from_output(&combined_output))
        .flatten();

    if !status.success() {
        let lower = combined_output.to_ascii_lowercase();
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
        missing_header,
    })
}

fn emit_library_status(
    app: &AppHandle,
    header: &str,
    package: &str,
    status: &str,
    progress: u8,
    message: &str,
) {
    if let Ok(mut statuses) = app.state::<LibraryState>().statuses.lock() {
        statuses.insert(header.to_owned(), status.to_owned());
    }
    let _ = app.emit(
        "library-install",
        LibraryInstallEvent {
            header,
            package,
            status,
            progress,
            message,
        },
    );
}

fn emit_tool_line(app: &AppHandle, operation: &'static str, stream: &'static str, line: &str) {
    let _ = app.emit(
        "tool-output",
        ToolOutput {
            operation,
            stream,
            line,
        },
    );
}

fn is_core_or_system_header(header: &str) -> bool {
    let lower = header.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "arduino.h"
            | "wire.h"
            | "spi.h"
            | "wifi.h"
            | "wificlient.h"
            | "wifiserver.h"
            | "wifiudp.h"
            | "bluetoothserial.h"
            | "esp.h"
            | "esp32-hal.h"
            | "stdint.h"
            | "stddef.h"
            | "stdbool.h"
            | "stdio.h"
            | "stdlib.h"
            | "string.h"
            | "math.h"
            | "time.h"
    ) || ["freertos/", "driver/", "soc/", "hal/", "lwip/", "esp_"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn installed_library_index(value: &Value) -> (HashSet<String>, HashSet<String>) {
    let mut headers = HashSet::new();
    let mut packages = HashSet::new();
    for entry in value
        .get("installed_libraries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(library) = entry.get("library") else {
            continue;
        };
        if let Some(name) = library.get("name").and_then(Value::as_str) {
            packages.insert(name.to_ascii_lowercase());
        }
        for header in library
            .get("provides_includes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            // Header names are case-sensitive on Linux. Keeping the spelling
            // reported by Arduino CLI prevents dht.h from being mistaken for
            // the different and commonly requested DHT.h header.
            headers.insert(header.to_owned());
        }
    }
    (headers, packages)
}

fn search_library_names(value: &Value) -> Vec<String> {
    value
        .get("libraries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|library| library.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

fn library_name_key(value: &str) -> String {
    let mut key: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect();
    if let Some(without_suffix) = key.strip_suffix("library") {
        key = without_suffix.to_owned();
    }
    key
}

fn exact_library_name(header: &str, candidates: &[String]) -> Option<String> {
    let stem = Path::new(header)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(header);
    let expected = library_name_key(stem);
    let mut matches = candidates
        .iter()
        .filter(|candidate| library_name_key(candidate) == expected);
    let matched = matches.next()?.clone();
    matches.next().is_none().then_some(matched)
}

fn preferred_library_name(header: &str, candidates: &[String]) -> Option<String> {
    if let Some(package) = exact_library_name(header, candidates) {
        return Some(package);
    }
    let stem = Path::new(header)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(header);
    let sensor_library = format!("{stem} sensor library");
    let mut matches = candidates
        .iter()
        .filter(|candidate| candidate.eq_ignore_ascii_case(&sensor_library));
    let matched = matches.next()?.clone();
    matches.next().is_none().then_some(matched)
}

async fn run_arduino_cli_json(args: &[String]) -> Result<Value, String> {
    let command = arduino_cli_path();
    let mut process = Command::new(&command);
    process.args(args).kill_on_drop(true);
    let output = process
        .output()
        .await
        .map_err(|error| friendly_command_error(&command, error))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("arduino-cli exited with {}", output.status)
        } else {
            detail
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read arduino-cli library data: {error}"))
}

async fn resolve_library_package(header: &str) -> Result<Option<String>, String> {
    let compact = "--omit-releases-details".to_owned();
    let json_flag = "--json".to_owned();
    let stem = Path::new(header)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(header);

    let by_name = run_arduino_cli_json(&[
        "lib".to_owned(),
        "search".to_owned(),
        format!("name={stem}"),
        compact.clone(),
        json_flag.clone(),
    ])
    .await?;
    let name_matches = search_library_names(&by_name);
    if let Some(package) = preferred_library_name(header, &name_matches) {
        return Ok(Some(package));
    }

    // The Library Manager index does not consistently populate `provides_includes`.
    // A normal search plus normalized exact match handles headers such as
    // Adafruit_SSD1306.h whose package is named "Adafruit SSD1306".
    let broad = run_arduino_cli_json(&[
        "lib".to_owned(),
        "search".to_owned(),
        stem.to_owned(),
        compact.clone(),
        json_flag.clone(),
    ])
    .await?;
    let broad_matches = search_library_names(&broad);
    if let Some(package) = preferred_library_name(header, &broad_matches) {
        return Ok(Some(package));
    }

    let by_header = run_arduino_cli_json(&[
        "lib".to_owned(),
        "search".to_owned(),
        format!("provides={header}"),
        compact,
        json_flag,
    ])
    .await?;
    let header_matches = search_library_names(&by_header);
    if let Some(package) = preferred_library_name(header, &header_matches) {
        return Ok(Some(package));
    }
    if header_matches.len() == 1 {
        Ok(header_matches.into_iter().next())
    } else if header_matches.is_empty() {
        Ok(None)
    } else {
        Err(format!(
            "Multiple Arduino libraries provide {header}; install the intended package manually."
        ))
    }
}

async fn install_library_package(
    app: &AppHandle,
    header: &str,
    package: &str,
) -> Result<(), String> {
    emit_library_status(
        app,
        header,
        package,
        "downloading",
        35,
        "Downloading package and dependencies…",
    );
    let command = arduino_cli_path();
    emit_tool_line(
        app,
        "library",
        "system",
        &format!("Installing {package} for {header}…"),
    );
    let mut child = Command::new(&command)
        .args(["lib", "install", package, "--no-color"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| friendly_command_error(&command, error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not capture Arduino library installer output.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not capture Arduino library installer errors.")?;
    let stdout_task = tokio::spawn(stream_pipe(stdout, app.clone(), "library", "stdout"));
    let stderr_task = tokio::spawn(stream_pipe(stderr, app.clone(), "library", "stderr"));
    let wait = child.wait();
    tokio::pin!(wait);
    let mut progress = 35_u8;
    let status = loop {
        tokio::select! {
            result = &mut wait => break result.map_err(|error| format!("Arduino library installer stopped unexpectedly: {error}"))?,
            _ = tokio::time::sleep(Duration::from_millis(450)) => {
                progress = (progress + 6).min(88);
                let (status, message) = if progress < 58 {
                    ("downloading", "Downloading package and dependencies…")
                } else {
                    ("installing", "Installing package and dependencies…")
                };
                emit_library_status(app, header, package, status, progress, message);
            }
        }
    };
    let (stdout_text, stderr_text) = tokio::join!(stdout_task, stderr_task);
    let stdout_text = stdout_text.unwrap_or_default();
    let stderr_text = stderr_text.unwrap_or_default();

    if status.success() {
        Ok(())
    } else {
        let stderr = stderr_text.trim().to_owned();
        let stdout = stdout_text.trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("arduino-cli exited with {status}")
        } else {
            detail.lines().last().unwrap_or(&detail).to_owned()
        })
    }
}

async fn process_library_queue(app: AppHandle, fqbn: String, headers: Vec<String>) {
    let install_lock = app.state::<LibraryState>().install_lock.clone();
    let _guard = install_lock.lock().await;
    let list_result = run_arduino_cli_json(&[
        "lib".to_owned(),
        "list".to_owned(),
        "--all".to_owned(),
        "--fqbn".to_owned(),
        fqbn.clone(),
        "--json".to_owned(),
    ])
    .await;
    let (mut installed_headers, mut installed_packages) = match list_result {
        Ok(value) => installed_library_index(&value),
        Err(error) => {
            emit_tool_line(
                &app,
                "library",
                "stderr",
                &format!("Library list failed: {error}"),
            );
            for header in headers {
                emit_library_status(&app, &header, "", "failed", 100, &error);
            }
            return;
        }
    };

    let mut missing_headers = Vec::new();
    for header in headers {
        if is_core_or_system_header(&header) {
            if let Ok(mut statuses) = app.state::<LibraryState>().statuses.lock() {
                statuses.insert(header, "available".to_owned());
            }
            continue;
        }
        if installed_headers.contains(&header) {
            emit_library_status(
                &app,
                &header,
                "",
                "installed",
                100,
                "Library is already installed.",
            );
            continue;
        }
        emit_library_status(
            &app,
            &header,
            "",
            "resolving",
            8,
            "Queued for library resolution…",
        );
        missing_headers.push(header);
    }

    for header in missing_headers {
        emit_library_status(
            &app,
            &header,
            "",
            "resolving",
            15,
            "Finding the Arduino library…",
        );
        let package = match resolve_library_package(&header).await {
            Ok(Some(package)) => package,
            Ok(None) => {
                let message = format!(
                    "No confident Arduino Library Manager match for {header}. Check the library name and install it manually."
                );
                emit_tool_line(&app, "library", "stderr", &message);
                emit_library_status(&app, &header, "", "failed", 100, &message);
                continue;
            }
            Err(error) => {
                emit_tool_line(
                    &app,
                    "library",
                    "stderr",
                    &format!("Library search failed for {header}: {error}"),
                );
                emit_library_status(&app, &header, "", "failed", 100, &error);
                continue;
            }
        };

        if installed_packages.contains(&package.to_ascii_lowercase()) {
            let message = format!(
                "{package} is installed, but Arduino CLI does not report the exact header {header}."
            );
            emit_tool_line(&app, "library", "stderr", &message);
            emit_library_status(&app, &header, &package, "failed", 100, &message);
            continue;
        }

        match install_library_package(&app, &header, &package).await {
            Ok(()) => {
                let refreshed = run_arduino_cli_json(&[
                    "lib".to_owned(),
                    "list".to_owned(),
                    "--all".to_owned(),
                    "--fqbn".to_owned(),
                    fqbn.clone(),
                    "--json".to_owned(),
                ])
                .await;
                match refreshed {
                    Ok(value) => {
                        let (headers, packages) = installed_library_index(&value);
                        installed_headers = headers;
                        installed_packages = packages;
                        if installed_headers.contains(&header) {
                            emit_library_status(
                                &app,
                                &header,
                                &package,
                                "installed",
                                100,
                                "Package installed successfully.",
                            );
                        } else {
                            let case_mismatch = installed_headers
                                .iter()
                                .find(|installed| installed.eq_ignore_ascii_case(&header));
                            let message = match case_mismatch {
                                Some(installed) => format!(
                                    "Installed {package}, but it provides {installed} instead of the case-sensitive header {header}."
                                ),
                                None => format!(
                                    "Installed {package}, but Arduino CLI does not report that it provides {header}."
                                ),
                            };
                            emit_tool_line(&app, "library", "stderr", &message);
                            emit_library_status(&app, &header, &package, "failed", 100, &message);
                        }
                    }
                    Err(error) => {
                        let message =
                            format!("Installed {package}, but could not verify {header}: {error}");
                        emit_tool_line(&app, "library", "stderr", &message);
                        emit_library_status(&app, &header, &package, "failed", 100, &message);
                    }
                }
            }
            Err(error) => {
                emit_library_status(&app, &header, &package, "failed", 100, &error);
            }
        }
    }
}

#[tauri::command]
async fn sync_libraries(
    app: AppHandle,
    state: State<'_, LibraryState>,
    headers: Vec<String>,
    fqbn: String,
    retry: bool,
) -> Result<(), String> {
    let pending = {
        let mut statuses = state
            .statuses
            .lock()
            .map_err(|_| "Library state lock was poisoned.".to_owned())?;
        let mut pending = Vec::new();
        let mut seen = HashSet::new();
        for header in headers {
            let header = header.trim().replace('\\', "/");
            if header.is_empty()
                || header.len() > 160
                || header.contains("..")
                || !seen.insert(header.to_ascii_lowercase())
            {
                continue;
            }
            if !statuses.contains_key(&header) || retry {
                statuses.insert(header.clone(), "checking".to_owned());
                pending.push(header);
            }
        }
        pending
    };

    if !pending.is_empty() {
        process_library_queue(app, fqbn, pending).await;
    }
    Ok(())
}

#[tauri::command]
async fn compile_sketch(
    app: AppHandle,
    state: State<'_, ToolState>,
    library_state: State<'_, LibraryState>,
    sketch_code: String,
    fqbn: String,
) -> Result<OperationResult, String> {
    let library_installing = library_state
        .statuses
        .lock()
        .map_err(|_| "Library state lock was poisoned.".to_owned())?
        .values()
        .any(|status| {
            matches!(
                status.as_str(),
                "checking" | "resolving" | "downloading" | "installing"
            )
        });
    if library_installing {
        return Err("Arduino libraries are still being downloaded. Wait for package installation to finish, then compile again.".to_owned());
    }
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

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
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
        .manage(LibraryState::default())
        .invoke_handler(tauri::generate_handler![
            list_boards,
            read_sketch,
            write_sketch,
            compile_sketch,
            upload_sketch,
            open_serial,
            close_serial,
            write_serial,
            quit_app,
            sync_libraries,
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
    fn indexes_headers_provided_by_installed_libraries() {
        let value = json!({
            "installed_libraries": [{
                "library": {
                    "name": "WiFi",
                    "provides_includes": ["WiFi.h", "WiFiClient.h"]
                }
            }]
        });
        let (headers, packages) = installed_library_index(&value);
        assert!(headers.contains("WiFi.h"));
        assert!(headers.contains("WiFiClient.h"));
        assert!(!headers.contains("wifi.h"));
        assert!(packages.contains("wifi"));
    }

    #[test]
    fn reads_exact_library_search_results() {
        let value = json!({
            "libraries": [{ "name": "Stepper" }],
            "status": "success"
        });
        assert_eq!(search_library_names(&value), vec!["Stepper"]);
        assert!(search_library_names(&json!({ "status": "success" })).is_empty());
    }

    #[test]
    fn matches_underscored_headers_to_spaced_package_names() {
        let candidates = vec![
            "Adafruit SSD1306".to_owned(),
            "Adafruit SSD1306 EMULATOR".to_owned(),
            "Adafruit_SSD1306_72x40".to_owned(),
        ];
        assert_eq!(
            exact_library_name("Adafruit_SSD1306.h", &candidates),
            Some("Adafruit SSD1306".to_owned())
        );
        assert_eq!(
            exact_library_name("Adafruit_GFX.h", &["Adafruit GFX Library".to_owned()]),
            Some("Adafruit GFX Library".to_owned())
        );
    }

    #[test]
    fn prefers_the_dht_sensor_library_over_lowercase_dhtlib() {
        let candidates = vec![
            "DHTlib".to_owned(),
            "DHT11".to_owned(),
            "DHT sensor library".to_owned(),
            "DHT Sensors Non-Blocking".to_owned(),
        ];
        assert_eq!(
            preferred_library_name("DHT.h", &candidates),
            Some("DHT sensor library".to_owned())
        );
    }

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
    fn extracts_missing_header_from_compiler_output() {
        assert_eq!(
            missing_header_from_output(
                "TraceSketch.ino:2:10: fatal error: Adafruit_SSD1306.h: No such file or directory"
            ),
            Some("Adafruit_SSD1306.h".to_owned())
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
                matched: true,
                usb_label: "USB serial".to_owned(),
                vid: String::new(),
                pid: String::new(),
                identity_key: "/dev/ttyUSB0".to_owned(),
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
                name: "Possible ESP32 board".to_owned(),
                port: "COM4".to_owned(),
                fqbn: DEFAULT_ESP32_FQBN.to_owned(),
                matched: false,
                usb_label: "USB serial".to_owned(),
                vid: String::new(),
                pid: String::new(),
                identity_key: "COM4".to_owned(),
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
                name: "Possible ESP32 board".to_owned(),
                port: "/dev/ttyUSB0".to_owned(),
                fqbn: DEFAULT_ESP32_FQBN.to_owned(),
                matched: false,
                usb_label: "USB serial".to_owned(),
                vid: String::new(),
                pid: String::new(),
                identity_key: "/dev/ttyUSB0".to_owned(),
            }]
        );
    }

    #[test]
    fn filters_builtin_and_unrelated_serial_devices() {
        let json = br#"{
          "detected_ports": [
            {"port": {"address": "/dev/ttyS0", "label": "/dev/ttyS0", "protocol": "serial"}},
            {"port": {
              "address": "/dev/ttyACM1",
              "label": "USB GPS receiver",
              "protocol": "serial",
              "protocol_label": "Serial Port (USB)",
              "properties": {"vid": "0x1234", "pid": "0x5678", "product": "GNSS GPS modem"}
            }},
            {
              "address": "/dev/ttyACM2",
              "label": "Arduino Uno",
              "boards": [{"name": "Arduino Uno", "fqbn": "arduino:avr:uno"}]
            }
          ]
        }"#;

        assert!(parse_board_list(json).unwrap().is_empty());
    }

    #[test]
    fn identifies_cp2102_and_builds_a_stable_override_key() {
        let json = br#"{
          "detected_ports": [{
            "port": {
              "address": "/dev/ttyUSB0",
              "label": "/dev/ttyUSB0",
              "protocol": "serial",
              "protocol_label": "Serial Port (USB)",
              "properties": {
                "vid": "0x10C4",
                "pid": "0xEA60",
                "product": "CP2102 USB to UART Bridge Controller",
                "serialNumber": "0001"
              }
            }
          }]
        }"#;
        let board = parse_board_list(json).unwrap().remove(0);
        assert_eq!(board.name, "Possible ESP32 board");
        assert_eq!(board.usb_label, "CP2102");
        assert_eq!(board.identity_key, "0x10C4:0xEA60:0001");
        assert!(!board.matched);
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
