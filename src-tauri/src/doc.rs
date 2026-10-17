//! `Doc` and the read + render pipeline that produces it (no Tauri types).

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

use crate::files::read_text;
use crate::paths::{absolutize, display_path};
use crate::render::render_markdown_split;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub path: String,
    pub title: String,
    /// The head of the body; the whole body when `rest_id` is `None`.
    pub html: String,
    /// Set by `RestStore::publish` when the body was split.
    pub rest_id: Option<u64>,
    pub render_ms: f64,
}

/// A rendered document plus the rest of its body, which stays out of the IPC payload.
/// `doc.rest_id` is `None` until the rest is published to a `RestStore`.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub doc: Doc,
    pub rest: Option<Arc<String>>,
}

/// Reads and renders `path` (absolute, or relative to the cwd).
pub fn load_doc(path: &Path) -> Result<Loaded, String> {
    let abs = absolutize(path);
    let text = read_text(&abs)?;
    let started = Instant::now();
    let (html, rest) = render_markdown_split(&text, abs.parent());
    let render_ms = started.elapsed().as_secs_f64() * 1000.0;
    let title = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let rest = (!rest.is_empty()).then(|| Arc::new(rest));
    let doc = Doc { path: display_path(&abs), title, html, rest_id: None, render_ms };
    Ok(Loaded { doc, rest })
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

        let loaded = load_doc(&file).unwrap();
        assert!(loaded.rest.is_none());
        let doc = loaded.doc;
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
        assert!(json["restId"].is_null() && json.get("rest_id").is_none());
    }

    #[test]
    fn big_file_is_split_and_serializes_rest_id() {
        let dir = std::env::temp_dir().join(format!("mdread-doc-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.md");
        let src = "# H

".to_string() + &"paragraph text

".repeat(5000);
        std::fs::write(&file, &src).unwrap();

        let loaded = load_doc(&file).unwrap();
        let rest = loaded.rest.expect("split");
        let whole = crate::render::render_markdown(&src, file.parent());
        assert_eq!(format!("{}{}", loaded.doc.html, rest), whole);
        assert!(!loaded.doc.html.is_empty() && !rest.is_empty());

        let mut doc = loaded.doc;
        doc.rest_id = Some(7);
        assert_eq!(serde_json::to_value(&doc).unwrap()["restId"], 7);
    }

    #[test]
    fn errors_pass_through() {
        let err = load_doc(Path::new(r"Z:\definitely\missing.md")).unwrap_err();
        assert!(err.starts_with("File not found: Z:\\"), "{err}");
    }
}
