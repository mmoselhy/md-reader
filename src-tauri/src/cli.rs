//! Command-line parsing (SPEC section 4 "Command-line arguments").

use std::path::PathBuf;

/// `args` excludes the program name. The first argument not starting with `-` is the path;
/// everything else is ignored. Resolution against the cwd happens later (`paths::absolutize`).
pub fn parse_path_arg(args: &[String]) -> Option<PathBuf> {
    args.iter().find(|a| !a.is_empty() && !a.starts_with('-')).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_args() {
        assert_eq!(parse_path_arg(&[]), None);
    }

    #[test]
    fn first_non_dash_wins() {
        assert_eq!(parse_path_arg(&v(&["--flag", "a.md", "b.md"])), Some(PathBuf::from("a.md")));
    }

    #[test]
    fn only_flags() {
        assert_eq!(parse_path_arg(&v(&["-x", "--y"])), None);
    }

    #[test]
    fn spaces_and_relative_kept_verbatim() {
        assert_eq!(parse_path_arg(&v(&[r"..\my notes\a b.md"])), Some(PathBuf::from(r"..\my notes\a b.md")));
    }

    #[test]
    fn empty_argument_is_skipped() {
        assert_eq!(parse_path_arg(&v(&["", "a.md"])), Some(PathBuf::from("a.md")));
    }
}
