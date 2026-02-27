# ForgeTerm

AI-native terminal workspace built on Tauri + React + xterm.js.

## Overview

- Multi-pane terminal workspace with isolated PTY sessions
- Tauri desktop shell with React UI
- xterm.js rendering with shell integration

## Requirements

- macOS 11+ for the packaged app
- Rust toolchain (for development)
- Node.js + pnpm (for development)

## Install (macOS)

1. Download the latest DMG: `ForgeTerm_0.1.0_aarch64.dmg`
2. Open the DMG
3. Drag `ForgeTerm.app` into `Applications`
4. Eject the DMG

### Update Existing Install

Option A: Drag-and-Replace (Recommended)
1. Quit ForgeTerm completely
2. Open the new DMG
3. Drag `ForgeTerm.app` into `Applications`
4. Choose **Replace** when prompted

Option B: Manual Replace
1. Quit the app
2. Delete `ForgeTerm.app` from `Applications`
3. Drag the new app from the DMG into `Applications`

### First Launch (Security Prompt)

If macOS blocks the app:
1. Open **System Settings → Privacy & Security**
2. Click **Open Anyway** for ForgeTerm
3. Launch again

## Development

Install dependencies:

```bash
pnpm install
```

Run the desktop app (UI + Rust backend):

```bash
pnpm tauri dev
```

Run the web UI only:

```bash
pnpm dev
```

## Build

Build the web frontend:

```bash
pnpm build
```

Build the desktop app and DMG:

```bash
pnpm tauri build
```

DMG output:

```
src-tauri/target/release/bundle/dmg/ForgeTerm_0.1.0_aarch64.dmg
```

## Project Structure

- `src/` React UI code (app shell, panes, styling)
- `src-tauri/` Tauri backend (Rust PTY sessions, app config)
- `public/` Static assets
- `vite.config.ts` Vite dev/build configuration
- `src-tauri/tauri.conf.json` Tauri app settings

## Notes

- UI state lives in React; PTY/session logic lives in Rust
- No auto-updater is configured yet; updates are manual via DMG
