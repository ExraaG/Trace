# Trace

Trace is a focused, dark-mode-first desktop IDE for ESP32 Arduino development. It keeps the editor experience modern and small while delegating board discovery, dependency resolution, compilation, and upload to the proven `arduino-cli` toolchain.

The v1 workflow is intentionally narrow: edit one `.ino` sketch, choose a connected ESP32, compile, upload, and inspect or send serial data from the built-in console. Build and upload output streams into the UI as it arrives. Trace does not include multi-file projects, a file tree, library management, board/core management, or themes.

## Install Trace

After the repository is public and the first release is published, the installer handles Trace, Arduino CLI, and the ESP32 Arduino core in one command.

**Linux (x86_64) and macOS (Intel or Apple Silicon):**

```sh
curl -fsSL https://raw.githubusercontent.com/ExraaG/Trace/main/install.sh | sh
```

**Windows x64 (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/ExraaG/Trace/main/install.ps1 | iex
```

The Linux installer places a self-contained AppImage and desktop entry in the current user's home directory. The macOS installer copies Trace to `~/Applications`, and the Windows installer uses the native Trace setup package. No administrator access is required for Trace or Arduino CLI itself. A board-specific USB driver may still be required on Windows or macOS; Linux users may need serial-device permission through their distribution's `dialout` or `uucp` group.

## Prerequisites

The one-command installer supplies the application toolchain. The following are only required when building Trace from source:

- [Rust via `rustup`](https://www.rust-lang.org/tools/install), including `cargo` and the stable Rust toolchain.
- [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system:
  - **Windows:** Microsoft C++ Build Tools and Microsoft Edge WebView2. WebView2 is already present on most current Windows installations.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** WebKitGTK and the distribution-specific development packages listed in Tauri's guide. On Debian/Ubuntu this includes the WebKitGTK, GTK, appindicator, SVG, SSL, and build-essential packages from that guide.
- The [Tauri CLI](https://v2.tauri.app/reference/cli/). This project declares the JavaScript CLI locally, so `npm install` installs it; a separate global installation is not required.
- A current [Node.js LTS release](https://nodejs.org/en/download) with npm. npm is the package manager used by the checked-in lockfile.
- [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/) installed on `PATH`, or in Trace's managed `~/.trace/bin` location.
- The [Espressif Arduino core for ESP32](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html), installed as the `esp32:esp32` core. The one-command installers configure this automatically.
- The USB/serial driver required by your specific ESP32 board. On Linux, your user must also have serial-port access (commonly membership in the `dialout` or `uucp` group); log out and back in after changing group membership.

If Arduino CLI is installed but the ESP32 core is not, install the stable core with:

```sh
arduino-cli config init
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32
```

Confirm the tools and board are visible before launching Trace:

```sh
arduino-cli version
arduino-cli core list
arduino-cli board list
```

## Install and run in development

From the repository root:

```sh
npm install
npm run tauri dev
```

The second command starts Vite and launches the native Trace window through `tauri dev`.

## Build a production binary

Build the optimized frontend, Rust binary, and native installer/bundle for the current operating system:

```sh
npm run tauri build
```

Artifacts are written under `src-tauri/target/release/bundle/` (`.deb` and `.rpm` for a local Linux build). Production installers for another operating system should be built on that operating system; platform signing may be required for distribution.

## Publishing a release

The release workflow builds an x86_64 Linux AppImage and DEB, Intel and Apple Silicon macOS DMGs, and Windows x64 NSIS/MSI installers. It only runs for version tags, so normal pushes never publish a release.

When the repository is public and version numbers in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` match, publish with:

```sh
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions creates the release and uploads all platform installers. Once that workflow finishes, the one-command installers above use the newest published release automatically.

## Using Trace

1. Connect an ESP32 over USB and select its name and port in the toolbar. Use refresh if it was connected after Trace opened.
2. Open an existing `.ino` file or edit the starter sketch and choose **Save As**.
3. Select **Compile**. Trace saves the current buffer and streams `arduino-cli` output into the build panel.
4. After a successful compile, select **Upload**. Upload remains disabled until that session has a successful, current compile.
5. Connect the serial console, select a baud rate (115200 by default), and send or receive newline-delimited data.

Arduino sketches conventionally live in a directory with the same name as the primary `.ino` file (for example, `Blink/Blink.ino`). Following that convention provides the best compatibility with Arduino CLI.

## Layout & Panels

Drag any divider to resize the editor, build output, serial console, or enabled AI assistant. Trace remembers custom sizes and collapsed panels across restarts. The toolbar also provides three starting points: **Focus** gives most of the window to code, **Debug** keeps build and serial output prominent, and **Full** balances every enabled panel. Dragging a divider after choosing a preset changes the saved layout to **Custom**.

## AI Assistant (optional)

The first-launch prompt can enable an ESP32/Arduino assistant using your own Anthropic, OpenAI, or Google Gemini API key. An OpenAI-compatible custom endpoint is also supported for local models and third-party services, with a configurable URL and optional bearer token. Trace asks the selected provider for its currently available models, lets you choose one, and streams replies into the chat as they arrive. AI is opt-in: when disabled, the panel is hidden and Trace makes no provider requests. Credentials and custom endpoint details are stored locally in Trace's app-data settings file, are never added to logs, and requests go directly from the Rust backend to the selected destination. Open **Settings** to enable, disable, refresh models, or change the provider later. **Explain error** copies the current build output into the chat input for review before sending. Asking Trace to write or replace code sends the current editor buffer as deliberate context, then opens the generated sketch as a red/green Monaco diff in the main editor instead of printing the code in chat. Apply or discard the proposal there; use **Save As** to persist an applied change to disk.

## Serial Console

The docked console supports common baud rates, defaults to 115200, sends text on Enter, optionally shows relative timestamps, and follows new output until you scroll up. Because an ESP32 serial port cannot be monitored and uploaded to simultaneously, Trace disconnects it automatically for upload, records that status in the console, and offers a one-click **Reconnect** when uploading finishes.

## Project layout

```text
src/                    React, TypeScript, Monaco, and Tailwind UI
src-tauri/src/lib.rs    Tauri commands, streamed tool output, serial I/O, and AI provider requests
src-tauri/              Rust package, capabilities, icons, and Tauri config
```

Compile and upload processes run asynchronously in Rust and send each stdout/stderr line to React through Tauri events. The serial monitor uses the Rust `serialport` crate directly; no subprocess is used for serial communication.
