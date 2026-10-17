//! Pure path and URL-component helpers (no I/O except `std::path::absolute`, which reads the cwd).
//!
//! `canonicalize` is deliberately never used: it adds a `\\?\` prefix and fails for missing files.

use std::path::{Component, Path, PathBuf};

/// Makes `path` absolute (relative to the cwd) and removes `.` / `..` lexically.
pub fn absolutize(path: &Path) -> PathBuf {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_lexically(&abs)
}

/// Removes `.` and resolves `..` without touching the file system. `..` never climbs above the root.
pub fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else if out.as_os_str().is_empty() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Windows-style display string: backslashes, no `\\?\` verbatim prefix.
pub fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        s
    }
}

/// Decodes `%XX` sequences; invalid sequences are kept literally, invalid UTF-8 is replaced.
pub fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() &&hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() {
            out.push(hex(b[i + 1]).unwrap() << 4 | hex(b[i + 2]).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// Equivalent of JavaScript `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len() * 2);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
        }
    }
    out
}

/// URL the webview uses to load a local file through Tauri's asset protocol (Windows form).
pub fn asset_url(abs_path: &str) -> String {
    format!("http://asset.localhost/{}", encode_uri_component(abs_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_dot_and_dotdot() {
        let p = normalize_lexically(Path::new(r"C:\a\.\b\..\c\..\..\d"));
        assert_eq!(display_path(&p), r"C:\d");
    }

    #[test]
    fn dotdot_stops_at_root() {
        let p = normalize_lexically(Path::new(r"C:\..\..\x"));
        assert_eq!(display_path(&p), r"C:\x");
    }

    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.md")), r"C:\a\b.md");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\sh\b.md")), r"\\srv\sh\b.md");
    }

    #[test]
    fn absolutize_resolves_relative_without_verbatim() {
        let p = display_path(&absolutize(Path::new(r"sub\..\missing.md")));
        assert!(!p.starts_with(r"\\?\"));
        assert!(p.ends_with(r"\missing.md"));
        assert!(!p.contains(".."));
    }

    #[test]
    fn decodes_percent() {
        assert_eq!(percent_decode("sub%20dir/spaced%20name.md"), "sub dir/spaced name.md");
        assert_eq!(percent_decode("%C3%9C%zz%"), "Ü%zz%");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component(r"C:\a b\p.png"), "C%3A%5Ca%20b%5Cp.png");
        assert_eq!(encode_uri_component("AZaz09-_.!~*'()"), "AZaz09-_.!~*'()");
        assert_eq!(encode_uri_component("é/#?&+"), "%C3%A9%2F%23%3F%26%2B");
    }
}
