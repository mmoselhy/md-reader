//! `Doc` and the read + render pipeline that produces it (no Tauri types).

use std::path::Path;
use std::time::Instant;

use serde::Serialize;

use crate::files::read_text;
use crate::paths::{absolutize, display_path};
use crate::render::render_markdown;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub path: String,
    pub title: String,
    pub html: String,
    pub render_ms: f64,
}

/// Reads and renders `path` (absolute, or relative to the cwd).
pub fn load_doc(path: &Path) -> Result<Doc, String> {
    let abs = absolutize(path);
    let text = read_text(&abs)?;
    let started = Instant::now();
    let html = render_markdown(&text, abs.parent());
    let render_ms = started.elapsed().as_secs_f64() * 1000.0;
    let title = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Doc { path: display_path(&abs), title, html, render_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_and_serializes_camel_case() {
        let dir = std::env::temp_dir().join(format!("mdread-doc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a b.md");
        std::fs::write(&file, "# T\n\n![i](p.png)\n").unwrap();

        let doc = load_doc(&file).unwrap();
        assert_eq!(doc.title, "a b.md");
        assert_eq!(doc.path, display_path(&file));
        assert!(!doc.path.starts_with(r"\\?\"));
        assert!(doc.html.contains(r#"<h1 id="t">T</h1>"#));
        assert!(doc.html.contains("http://asset.localhost/"));

        let json = serde_json::to_value(&doc).unwrap();
        assert!(json.get("renderMs").is_some() && json.get("render_ms").is_none());
        for key in ["path", "title", "html"] {
            assert!(json[key].is_string());
        }
    }

    #[test]
    fn errors_pass_through() {
        let err = load_doc(Path::new(r"Z:\definitely\missing.md")).unwrap_err();
        assert!(err.starts_with("File not found: Z:\\"), "{err}");
    }
}
