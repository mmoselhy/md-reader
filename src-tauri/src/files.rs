//! Reading a document from disk (SPEC section 5 "Input"). Kept apart from rendering so that
//! `render_markdown` stays pure.

use std::io::ErrorKind;
use std::path::Path;

use crate::paths::display_path;

pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Reads `path` (already absolute) as text: BOM stripped, invalid UTF-8 converted lossily.
/// Errors are short, user-readable strings.
pub fn read_text(path: &Path) -> Result<String, String> {
    let shown = display_path(path);
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => format!("File not found: {shown}"),
        _ => format!("Could not read {shown}: {e}"),
    })?;
    if !meta.is_file() {
        return Err(format!("Not a file: {shown}"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("File too large (over 64 MiB): {shown}"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read {shown}: {e}"))?;
    Ok(decode(bytes))
}

fn decode(bytes: Vec<u8>) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    match std::str::from_utf8(body) {
        Ok(s) => s.to_owned(),
        Err(_) => String::from_utf8_lossy(body).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mdread-files-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_file() {
        let p = temp_dir("missing").join("nope.md");
        let err = read_text(&p).unwrap_err();
        assert_eq!(err, format!("File not found: {}", display_path(&p)));
    }

    #[test]
    fn directory_is_not_a_file() {
        let d = temp_dir("dir");
        let err = read_text(&d).unwrap_err();
        assert_eq!(err, format!("Not a file: {}", display_path(&d)));
    }

    #[test]
    fn bom_is_stripped() {
        let p = temp_dir("bom").join("a.md");
        std::fs::write(&p, b"\xEF\xBB\xBF# Hi").unwrap();
        assert_eq!(read_text(&p).unwrap(), "# Hi");
    }

    #[test]
    fn invalid_utf8_is_lossy() {
        let p = temp_dir("lossy").join("a.md");
        std::fs::write(&p, b"ok \xFF\xFE end").unwrap();
        assert_eq!(read_text(&p).unwrap(), "ok \u{FFFD}\u{FFFD} end");
    }

    #[test]
    fn oversize_file_is_rejected() {
        let p = temp_dir("big").join("big.md");
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(MAX_FILE_BYTES + 1).unwrap(); // sparse; never read
        let err = read_text(&p).unwrap_err();
        assert!(err.starts_with("File too large"), "{err}");
    }
}
