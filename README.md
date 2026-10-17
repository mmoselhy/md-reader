# mdread

A fast, minimal Markdown reader for Windows. Open a `.md` file and read it. That's the whole app.

- **Fast:** Markdown is rendered in Rust ([pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark)) and shown in the system WebView2, so nothing like Chromium is bundled. The window only appears once content is painted, so there's no white flash. Big files show their first screen immediately and load the rest right after.
- **Simple:** one slim bar with the file name, an Open button and a theme button. No settings screen.
- **Light and dark:** follows the system theme, or toggle System → Light → Dark (remembered).
- **GitHub-flavored Markdown:** tables, task lists, strikethrough, footnotes, autolinks and alerts (`> [!NOTE]`). YAML front matter is hidden.
- **Live reload:** edits saved in any editor show up instantly and keep your scroll position.
- **Safe:** scripts embedded in Markdown never run, and local links to non-Markdown files are revealed in Explorer, never executed.

## Install

Download from the [latest release](https://github.com/mmoselhy/mdread/releases/latest):

- `mdread_<version>_x64-setup.exe`: installer. It registers mdread as a viewer for `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdn` files.
- `mdread-<version>-x64-portable.exe`: single exe, no install.

The builds aren't code-signed yet, so Windows SmartScreen may warn on first run (**More info → Run anyway**). mdread uses the WebView2 runtime that ships with Windows 10 and 11. The installer fetches it if it's missing.

## Use

```
mdread.exe path\to\file.md
```

You can also double-click a `.md` file (after installing), drag a file onto the window, or press **Ctrl+O**.

| Key | Action |
|---|---|
| Ctrl+O | Open a file |
| Ctrl+T | Cycle theme: system → light → dark |
| Ctrl+= / Ctrl+- / Ctrl+0 | Text size up / down / reset |
| F5 or Ctrl+R | Reload |
| Alt+← / Alt+→ (or mouse back/forward) | Back / forward through followed Markdown links |

## Performance

Measured on the release build on one Windows 11 machine (your numbers will vary):

| | |
|---|---|
| Window shown, small file | ~450–600 ms (essentially WebView2 startup; same with no file) |
| Window shown, 1 MiB file | same as a small file: only the first screen is sent before showing, the rest follows |
| Render 1 MiB of dense Markdown in Rust | ~22 ms |

Reproduce the startup number with the `MDREAD_TIMING` log described in [SPEC.md](SPEC.md#1-goals-and-measurable-targets).

## Build from source

Requirements: Windows 10/11, [Rust](https://rustup.rs) (stable, MSVC toolchain, with Visual Studio Build Tools), and Node.js (only for the Tauri CLI and the UI tests).

```
npx @tauri-apps/cli@2 build            # installer in src-tauri\target\release\bundle\nsis\
npx @tauri-apps/cli@2 build --no-bundle  # just src-tauri\target\release\mdread.exe
```

Tests:

```
cargo test --manifest-path src-tauri/Cargo.toml
node --test "tests/ui/*.test.mjs"
cargo test --release --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture perf
```

The frontend is plain HTML, CSS and JS in `src/`, with no bundler and no npm dependencies. The design, including the IPC contract between Rust and the UI, is in [SPEC.md](SPEC.md).

## License

[MIT](LICENSE)
