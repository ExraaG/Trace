> [!WARNING]
> **Windows & macOS Users:** The current release opens unexpected terminal windows and may not function correctly. A fix is actively being worked on! If you need a stable experience, we recommend waiting for the upcoming patch.

# Trace

Trace is a focused desktop IDE for ESP32 and Arduino development. It provides a modern code editor, a beginner-friendly visual block editor, live build output, automatic library installation, upload controls, and a serial console while leaving the actual toolchain work to `arduino-cli`.

Trace deliberately keeps the workflow small: open or write one `.ino` sketch, choose a connected Arduino-compatible board, compile, upload, and inspect serial data. ESP32 is configured by the installer; other installed Arduino cores use the same workflow. There is no project tree or board-package manager to get between you and the board.

## Install Trace

The installer sets up Trace, Arduino CLI, and the ESP32 Arduino core. It installs into your user account and does not require administrator access for Trace itself.

**Linux (x86_64) and macOS (Intel or Apple Silicon):**

```sh
curl -fsSL https://raw.githubusercontent.com/ExraaG/Trace/main/install.sh | sh
```

**Windows x64 (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/ExraaG/Trace/main/install.ps1 | iex
```

Want to inspect a script before running it? Open [`install.sh`](install.sh) or [`install.ps1`](install.ps1) in this repository first.

The Linux installer places a self-contained AppImage and application-menu entry in your home directory. The macOS installer copies Trace to `~/Applications`, and the Windows installer runs the native Trace setup package. A board-specific USB driver may still be required on Windows or macOS. Linux users may need serial-device permission through their distribution's `dialout` or `uucp` group.

Current builds are not code-signed. Windows SmartScreen or macOS Gatekeeper may ask you to confirm that you want to open Trace. Only accept that prompt when you downloaded Trace from this repository's official release page.

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
- Any additional Arduino core required by the board you intend to use. Trace reads its boards, menus, recipes, and defaults through `arduino-cli`.
- The USB/serial driver required by your specific ESP32 board. On Linux, your user must also have serial-port access (commonly membership in the `dialout` or `uucp` group); log out and back in after changing group membership.

On Linux, Trace automatically applies the NVIDIA explicit-sync compatibility workaround required by affected WebKitGTK/Wayland combinations. No launch-time environment variable is needed.

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

## Maintainer release process

The release workflow builds an x86_64 Linux AppImage and DEB, Intel and Apple Silicon macOS DMGs, and Windows x64 NSIS/MSI installers. It only runs for version tags, so normal pushes never publish a release.

When version numbers in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` match, publish with:

```sh
git tag v0.3.1
git push origin v0.3.1
```

GitHub Actions creates the release and uploads all platform installers. Once that workflow finishes, the one-command installers above use the newest published release automatically.

## Using Trace

1. Connect a board over USB and select its name and port in the toolbar. Use refresh if it was connected after Trace opened. Hidden family/template definitions are ignored; ambiguous devices require a concrete installed board choice. If automatic detection chooses incorrectly, select **Wrong board?**, search for the installed board model, and Trace will remember that correction for the device's USB identity.
2. Use the sliders button beside the board picker to review platform-provided options such as flash size, partition scheme, PSRAM, or upload mode. Trace uses platform defaults unless you select another value.
3. Open an existing `.ino` file or edit the starter sketch. Saving is optional for compilation. Select **Blocks** beside **Code** above the editor to build a sketch visually; connected blocks generate the same `.ino` buffer used by compile and upload.
4. Select **Compile**. Trace validates expanded build recipes and partition files before starting, then streams `arduino-cli` output into the build panel.
5. After a successful compile, select **Upload**. Upload remains disabled until that session has a successful, current compile.
6. Connect the serial console, select a baud rate (115200 by default), and send or receive newline-delimited data.

Arduino sketches conventionally live in a directory with the same name as the primary `.ino` file (for example, `Blink/Blink.ino`). Following that convention provides the best compatibility with Arduino CLI.

## Automatic libraries

When the editor contains an angle-bracket include such as `#include <Stepper.h>`, Trace checks the selected board core and installed Arduino libraries first. If the header is missing, Trace resolves the matching package through Arduino Library Manager and installs it asynchronously with `arduino-cli`. A compact package bar appears below the toolbar; select it to see per-package resolution, download, installation, completion, or failure progress. Failed installs remain visible and can be retried. Compile waits for active installs and reports unresolved library failures clearly instead of starting a broken build.

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
