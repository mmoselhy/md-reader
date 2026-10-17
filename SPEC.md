# mdread v1 spec

The fastest local Markdown reader for Windows, with a very simple and intuitive UI and light and dark modes.

## 1. Goals and measurable targets

| Target | Threshold | How to measure |
|---|---|---|
| Render speed | `render_markdown` on a 1 MiB document < **15 ms** (release build) | `cargo test --release --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture perf` (the test asserts < 50 ms to stay stable on slow machines and prints the measured time) |
| Cold start | process start → first paint of a 1 MiB file < **500 ms** | `node tests/fixtures/gen-large.mjs`, then `$env:MDREAD_TIMING="$PWD\timing.log"; .\src-tauri\target\release\mdread.exe tests\fixtures\large.md`, then read `timing.log` |
| No flash | the window never shows a blank white frame before content | the window starts hidden and is shown by `mark_ready` (section 4) |
| Small and dependency-free UI | no frameworks, no bundler, no web fonts, no npm runtime dependencies | the files in `src/` are served as they are |

## 2. Scope

**In v1:** read-only viewing of CommonMark + GFM (tables, task lists, strikethrough, footnotes, autolinks, GFM alerts), YAML front matter hidden; open by CLI argument (Explorer "Open with" / file association), Ctrl+O dialog, drag and drop onto the window; live reload when the file changes on disk, keeping the scroll position; light/dark/system theme toggle, persisted; text zoom; relative images; relative links to other Markdown files open in mdread, with back/forward; web links open in the default browser; scripts embedded in Markdown never run.

**Not in v1 (do not build):** editing, export/print, syntax highlighting (code blocks keep a `language-xxx` class for later), find-in-page, tabs or multiple windows, settings UI, math, mermaid, rewriting local `<img>` inside raw HTML, single-instance handling, installer polish, macOS/Linux testing.

## 3. Stack and layout

Tauri 2 (Rust) on the system WebView2 runtime. Rust renders Markdown to HTML with `pulldown-cmark` (SIMD on). The frontend is plain static files in `src/` (`build.frontendDist = "../src"`, no `devUrl`, `app.withGlobalTauri = true`), so JS uses `window.__TAURI__.*` and no imports from npm.

```
SPEC.md                      this file (orchestrator)
.gitignore                   (orchestrator)
src-tauri/Cargo.toml         (orchestrator) all dependencies are already declared
src-tauri/build.rs           (orchestrator)
src-tauri/tauri.conf.json    (orchestrator) window, CSP, asset protocol, bundle
src-tauri/capabilities/      (orchestrator) core:default, core:window:allow-set-title, dialog:allow-open, opener:default
src-tauri/icons/             (orchestrator)
src-tauri/src/**             Task A (Rust backend)
src-tauri/tests/**           Task A
src/**                       Task B (UI)
tests/ui/**                  Task B
tests/fixtures/**            (orchestrator) read-only for workers
```

Declared crates: `tauri 2.12` (feature `protocol-asset`), `tauri-plugin-dialog 2.8`, `tauri-plugin-opener 2.7`, `pulldown-cmark 0.13` (`html`, `simd`), `pulldown-cmark-escape 0.11` (`escape_href`, `escape_html` for attributes you emit yourself), `notify 8.2`, `notify-debouncer-mini 0.6`, `serde`, `serde_json`. Do not add crates; if one is truly needed, say so in your report instead.

## 4. IPC contract (Rust ⇄ JS)

All names are exact. JS calls them with `window.__TAURI__.core.invoke(name, args)`; argument keys are camelCase in JS (Tauri converts them to snake_case).

### Type `Doc` (serialized as JSON)

```ts
type Doc = {
  path: string;      // absolute Windows path, no "\\?\" verbatim prefix, e.g. "C:\\notes\\a.md"
  title: string;     // file name, e.g. "a.md"
  html: string;      // rendered body HTML (section 5)
  renderMs: number;  // time spent in render_markdown, milliseconds
};
```

Rust struct: `Doc { path, title, html, render_ms }` with `#[serde(rename_all = "camelCase")]`.

### Commands

| Command | JS call | Returns | Behaviour |
|---|---|---|---|
| `initial_doc` | `invoke('initial_doc')` | `Doc \| null`; rejects with `string` | The document given on the command line. Rust starts reading and rendering it on a background thread **at process start**, before the webview loads; this command waits for that result. `null` if no path was given. Rejects with a readable message if the path can't be read. Starts watching the file on success. Calling it again returns the same result. |
| `open_file` | `invoke('open_file', { path })` | `Doc`; rejects with `string` | Reads and renders `path` (absolute or relative to the process's working directory). On success it **replaces** the watched file with this one. On failure the previous watch stays. |
| `mark_ready` | `invoke('mark_ready')` | `void` | The frontend calls this once, right after the first content (document, empty state or error) is in the DOM. Rust shows the main window and focuses it. If `MDREAD_TIMING` is set, it appends `ready_ms=<ms since process start>` to that file. Safe to call more than once. |

All commands except `mark_ready` are `async fn` so file I/O never blocks the UI thread. Error strings are short and readable, for example `File not found: C:\x\a.md`, `Not a file: C:\x`, `Could not read C:\x\a.md: <io error>`.

**Fallback:** if `mark_ready` hasn't arrived 1500 ms after setup, Rust shows the window anyway, so a JS error can never leave it invisible.

### Events (Rust → JS)

| Event | Payload | When |
|---|---|---|
| `file-changed` | `{ path: string }` (same format as `Doc.path`) | The watched file was modified, replaced (atomic save via rename) or recreated. Debounced to about 100 ms, at most one event per burst. Not emitted for other files in the directory. |
| `file-removed` | `{ path: string }` | The watched file was deleted or renamed away and hasn't reappeared within the debounce window. |

Drag and drop uses Tauri's built-in webview event: `window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(cb)` with `payload.type` set to `'enter' | 'over' | 'drop' | 'leave'` and `payload.paths: string[]`. There's no custom command for it.

Plugins the UI uses: `window.__TAURI__.dialog.open(...)`, `window.__TAURI__.opener.openUrl(url)`, `window.__TAURI__.opener.revealItemInDir(path)`, and `window.__TAURI__.window.getCurrentWindow().setTitle(title)`.

### Command-line arguments

The first argument that doesn't start with `-` is the path to open. Other arguments are ignored. A relative path is resolved against the working directory.

### Timing log (`MDREAD_TIMING`)

If the environment variable `MDREAD_TIMING` holds a file path, Rust appends one line per event to it: `initial_render_ms=<f64>` when the initial render finishes, and `ready_ms=<f64>` (milliseconds since process start) on the first `mark_ready`. Failing to write the log is never fatal.

## 5. Rendering rules (Task A)

Input: UTF-8 with a BOM stripped if present. Invalid UTF-8 is converted lossily, not rejected. Files over 64 MiB are rejected with an error.

pulldown-cmark options: `ENABLE_TABLES | ENABLE_FOOTNOTES | ENABLE_STRIKETHROUGH | ENABLE_TASKLISTS | ENABLE_HEADING_ATTRIBUTES | ENABLE_YAML_STYLE_METADATA_BLOCKS | ENABLE_GFM`. Smart punctuation and math are off.

Output is HTML exactly as `pulldown_cmark::html::push_html` produces it, with these changes made by transforming the event stream (no regex over HTML):

1. **Heading ids.** Every heading gets an `id`. An explicit `{#id}` attribute wins. Otherwise use a GitHub-style slug: lowercase; keep Unicode letters and numbers, `-` and `_`; spaces become `-`; drop everything else. Duplicates get `-1`, `-2`, and so on (`"Duplicate heading"` → `duplicate-heading`, then `duplicate-heading-1`). An empty slug becomes `section`.
2. **Links.**
   - `http:`, `https:`, `mailto:` and any other URL with a scheme (except `file:`): unchanged.
   - Pure fragment `#x`: unchanged.
   - Local link (no scheme, or `file:`): keep `href` as written and add `data-local-path="<absolute path>"` (relative to the document's directory, percent-decoded, normalised with `.` and `..` removed, backslashes, no verbatim prefix). If there's a fragment, also add `data-fragment="<fragment without #>"`.
3. **Images.** A local `src` (same resolution as links) becomes `http://asset.localhost/<encodeURIComponent(absolute path)>`, the same string Tauri's `convertFileSrc` produces on Windows. Remote and `data:` sources are unchanged.
4. **Raw HTML** passes through. Script execution is blocked by the CSP in `tauri.conf.json`, not by stripping.
5. **Task-list checkboxes** stay as pulldown-cmark emits them (`disabled`).

Rendering must be a pure function, `render_markdown(source: &str, base_dir: Option<&Path>) -> String`, with no I/O, so it can be tested and benchmarked.

## 6. File watching (Task A)

Watch the file's **parent directory** non-recursively with `notify-debouncer-mini` (debounce 100 ms) and filter events down to the watched file name. Editors save atomically (write temp → rename), which breaks watches on the file itself. Only one file is watched at a time; `open_file` replaces it. The watcher must not hold an open handle that stops editors from saving.

## 7. UI (Task B)

Principles: content first, chrome minimal, everything reachable in one keystroke or click, no settings screen.

**Layout**
- A slim top bar (about 40 px) shows the document title (the full path appears as a tooltip), then on the right an **Open** button and a **theme** button whose icon shows the current mode (system / light / dark). The bar stays put while the document scrolls.
- The document column is centered, about 860 px max width, with comfortable padding. It uses the system UI font stack (`"Segoe UI", system-ui, sans-serif`) and a monospace stack (`"Cascadia Code", Consolas, monospace`). GitHub-like typography covers headings, tables, blockquotes, code blocks, task lists, footnotes, and GFM alerts (pulldown-cmark emits `<blockquote class="markdown-alert-note">` and similar; check the real output) with colored left borders and titles.
- **Empty state** (no document): centered text "Open a Markdown file", a button, and a hint "or drop a file here · Ctrl+O".
- **Error state**: a dismissible banner above the content. The previous document stays visible.
- **Drag overlay**: while a file is dragged over the window, a translucent overlay with a dashed border says "Drop to open".
- The window title is `<file name> — mdread`, or `mdread` when empty.

**Themes**
- The mode is `system | light | dark`, stored in `localStorage["mdread.theme"]`, default `system`. The theme button cycles system → light → dark → system.
- The resolved theme is applied as `<html data-theme="light|dark">` by a tiny classic (non-module) script `src/theme-init.js` loaded synchronously in `<head>`, so the first paint already uses the right colors. In `system` mode it follows `prefers-color-scheme` live.
- Palette (CSS custom properties on `:root[data-theme=…]`): light bg `#ffffff`, fg `#1f2328`, muted `#59636e`, border `#d1d9e0`, code bg `#f6f8fa`, link `#0969da`; dark bg `#0d1117`, fg `#e6edf3`, muted `#9198a1`, border `#3d444d`, code bg `#151b23`, link `#4493f8`.

**Interactions**
| Input | Action |
|---|---|
| Ctrl+O, Open button, empty-state button | Native open dialog filtered to `md, markdown, mdown, mkd, mkdn, txt` (plus "All files"), then `open_file` |
| Drop file(s) | Open the first dropped path |
| F5 / Ctrl+R | Reload the current document (keeps scroll) |
| Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 | Text zoom in 10% steps between 70% and 200%, reset to 100%; stored in `localStorage["mdread.zoom"]` |
| Ctrl+T | Cycle theme |
| Alt+Left / Alt+Right, mouse back/forward buttons | Back/forward through documents opened by following links in this session |
| Click `#frag` link | Scroll to the element with that id (decode the id) |
| Click a link with `data-local-path` to a Markdown file (`.md .markdown .mdown .mkd .mkdn`, any case) | `open_file`, push it onto history, then scroll to `data-fragment` if present, otherwise to the top |
| Click another local link | `opener.revealItemInDir(path)`; local files are never opened or executed |
| Click an `http(s):` / `mailto:` link | `opener.openUrl(href)` |
| Anything else | Do nothing. Never let the webview navigate away from the app |

**Live reload:** on `file-changed` for the current path, call `open_file` again and restore `scrollTop` (clamped to the new height). On `file-removed`, show a banner ("File was deleted or moved") and keep the content.

**Startup sequence:** `invoke('initial_doc')` → render the document, the empty state or the error → `invoke('mark_ready')` **straight after the DOM insertion** (not in `requestAnimationFrame`, which may not fire while the window is hidden).

**Performance:** insert document HTML with a single `innerHTML` assignment. Apply `content-visibility: auto` with `contain-intrinsic-size` to top-level children of the document column so very large documents paint quickly. No layout thrashing in scroll handlers.

**Pure logic** (theme cycling, theme resolution, zoom stepping and clamping, link classification, Markdown extension check, history stack, scroll clamping) lives in `src/logic.js` as an ES module with no DOM or Tauri access, and is unit-tested with `node --test tests/ui/`.

## 8. Rules for all workers

- Touch only the files your task owns. Read anything you like.
- Don't commit, push, `cargo clean`, or delete `src-tauri/target/`. Two workers may build at the same time; cargo serializes on the target lock, which is expected.
- No new dependencies (crates or npm).
- End your work with a `## Report` (see the task brief).
