# Repository Guidelines

## Project Structure & Module Organization
- `src/`: React UI code (app shell, panes, styling).
- `src-tauri/`: Tauri backend (Rust PTY sessions, app config).
- `public/`: Static assets.
- `vite.config.ts`: Vite dev/build configuration.
- `src-tauri/tauri.conf.json`: Tauri app settings.

## Build, Test, and Development Commands
- `pnpm install`: Install dependencies.
- `pnpm dev`: Run the Vite web dev server (UI only).
- `pnpm tauri dev`: Run the full desktop app (UI + Rust backend).
- `pnpm build`: Build the web frontend.
- `pnpm tauri build`: Package the desktop app.

## Coding Style & Naming Conventions
- TypeScript/React in `src/`, Rust in `src-tauri/`.
- Indentation: 2 spaces for TS/TSX, 2 spaces for JSON.
- Prefer descriptive component and file names (e.g., `TerminalPane.tsx`).
- Keep UI state in React; keep PTY/session logic in Rust.

## Testing Guidelines
- No formal test framework is set up yet.
- If adding tests, keep them close to the feature (e.g., `src/__tests__/`).
- Verify manually with `pnpm tauri dev` for terminal behavior.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and scoped to one change (e.g., `Add drag-to-resize split panes`).
- Keep commits atomic and focused.
- PRs should include a short summary and note any UX changes or new commands.

## Architecture Overview
- Frontend uses xterm.js for terminal rendering.
- Backend uses Tauri + Rust with `portable-pty` for PTY sessions.
- Split panes are managed in React and render isolated PTY sessions.

## Agent Instructions
- Auto-commit changes when finished.
- Avoid long-running UI work on the main thread (defer PTY spawn and heavy init).
