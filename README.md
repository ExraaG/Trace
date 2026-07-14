# Trace

Trace is a focused, dark-mode-first desktop IDE for ESP32 Arduino development. It keeps the editor experience modern and small while delegating board discovery, dependency resolution, compilation, and upload to the proven `arduino-cli` toolchain.

The v1 workflow is intentionally narrow: edit one `.ino` sketch, choose a connected ESP32, compile, upload, and inspect or send serial data from the built-in monitor. Build and upload output streams into the UI as it arrives. Trace does not include multi-file projects, a file tree, library management, board/core installation, themes, or settings.

## Prerequisites

Install all of the following before running Trace:

- [Rust via `rustup`](https://www.rust-lang.org/tools/install), including `cargo` and the stable Rust toolchain.
- [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system:
  - **Windows:** Microsoft C++ Build Tools and Microsoft Edge WebView2. WebView2 is already present on most current Windows installations.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** WebKitGTK and the distribution-specific development packages listed in Tauri's guide. On Debian/Ubuntu this includes the WebKitGTK, GTK, appindicator, SVG, SSL, and build-essential packages from that guide.
- The [Tauri CLI](https://v2.tauri.app/reference/cli/). This project declares the JavaScript CLI locally, so `npm install` installs it; a separate global installation is not required.
- A current [Node.js LTS release](https://nodejs.org/en/download) with npm. npm is the package manager used by the checked-in lockfile.
- [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/) installed on `PATH`.
- The [Espressif Arduino core for ESP32](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html), installed as the `esp32:esp32` core.
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

Artifacts are written under `src-tauri/target/release/bundle/` (`.deb` and `.rpm` on Linux). Production installers for another operating system should be built on that operating system; platform signing may be required for distribution. AppImage distribution is best built in an older supported Linux container or CI image so its glibc baseline remains portable.

## Using Trace

1. Connect an ESP32 over USB and select its name and port in the toolbar. Use refresh if it was connected after Trace opened.
2. Open an existing `.ino` file or edit the starter sketch and choose **Save As**.
3. Select **Compile**. Trace saves the current buffer and streams `arduino-cli` output into the build panel.
4. After a successful compile, select **Upload**. Upload remains disabled until that session has a successful, current compile.
5. Open the serial monitor, select a baud rate (115200 by default), and send or receive newline-delimited data. Trace closes the port before uploading and offers to reopen it afterward.

Arduino sketches conventionally live in a directory with the same name as the primary `.ino` file (for example, `Blink/Blink.ino`). Following that convention provides the best compatibility with Arduino CLI.

## Project layout

```text
src/                    React, TypeScript, Monaco, and Tailwind UI
src-tauri/src/lib.rs    Tauri commands, streamed tool output, and serial I/O
src-tauri/              Rust package, capabilities, icons, and Tauri config
```

Compile and upload processes run asynchronously in Rust and send each stdout/stderr line to React through Tauri events. The serial monitor uses the Rust `serialport` crate directly; no subprocess is used for serial communication.
