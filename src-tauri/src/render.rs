//! Markdown -> HTML (SPEC section 5). Pure: no file or network I/O.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use pulldown_cmark::{html, CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};
use pulldown_cmark_escape::{escape_href, escape_html};

use crate::paths;

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_GFM
}

pub fn render_markdown(source: &str, base_dir: Option<&Path>) -> String {
    let mut events: Vec<Event> = Vec::with_capacity(source.len() / 12 + 16);
    let mut ids = HeadingIds::default();
    // Index of the open heading's Start event and its accumulated plain text.
    let mut heading: Option<(usize, String)> = None;

    for event in Parser::new_ext(source, options()) {
        if let (Some((_, text)), Event::Text(t) | Event::Code(t)) = (heading.as_mut(), &event) {
            text.push_str(t);
        }
        match event {
            Event::Start(Tag::Heading { level, id, classes, attrs }) => {
                match &id {
                    Some(explicit) => ids.reserve(explicit),
                    None => heading = Some((events.len(), String::new())),
                }
                events.push(Event::Start(Tag::Heading { level, id, classes, attrs }));
            }
            Event::End(TagEnd::Heading(level)) => {
                if let Some((idx, text)) = heading.take() {
                    let slug = ids.unique(slugify(&text));
                    if let Event::Start(Tag::Heading { id, .. }) = &mut events[idx] {
                        *id = Some(CowStr::from(slug));
                    }
                }
                events.push(Event::End(TagEnd::Heading(level)));
            }
            Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
                let local = (link_type != LinkType::Email)
                    .then(|| resolve_local(&dest_url, base_dir))
                    .flatten();
                match local {
                    Some(target) => events.push(Event::InlineHtml(local_anchor(&dest_url, &title, &target).into())),
                    None => events.push(Event::Start(Tag::Link { link_type, dest_url, title, id })),
                }
            }
            Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
                let dest_url = match resolve_local(&dest_url, base_dir) {
                    Some(target) => CowStr::from(paths::asset_url(&target.path)),
                    None => dest_url,
                };
                events.push(Event::Start(Tag::Image { link_type, dest_url, title, id }));
            }
            other => events.push(other),
        }
    }

    let mut out = String::with_capacity(source.len() * 3 / 2);
    html::push_html(&mut out, events.into_iter());
    out
}

/// Opening `<a>` tag for a local link: `href` as written plus `data-local-path` / `data-fragment`.
fn local_anchor(dest: &str, title: &str, target: &LocalTarget) -> String {
    let mut h = String::with_capacity(dest.len() + target.path.len() + 48);
    h.push_str("<a href=\"");
    let _ = escape_href(&mut h, dest);
    h.push_str("\" data-local-path=\"");
    let _ = escape_html(&mut h, &target.path);
    h.push('"');
    if let Some(fragment) = &target.fragment {
        h.push_str(" data-fragment=\"");
        let _ = escape_html(&mut h, fragment);
        h.push('"');
    }
    if !title.is_empty() {
        h.push_str(" title=\"");
        let _ = escape_html(&mut h, title);
        h.push('"');
    }
    h.push('>');
    h
}

#[derive(Debug, PartialEq, Eq)]
struct LocalTarget {
    path: String,
    fragment: Option<String>,
}

/// URL scheme of `dest` (`https`, `mailto`, a one-letter drive such as `C`), if it has one.
fn scheme(dest: &str) -> Option<&str> {
    let s = &dest[..dest.find(':')?];
    let mut chars = s.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then_some(s)
}

/// Resolves a link/image target to an absolute local path, or `None` for web, fragment-only,
/// protocol-relative and other-scheme targets.
fn resolve_local(dest: &str, base_dir: Option<&Path>) -> Option<LocalTarget> {
    if dest.is_empty() || dest.starts_with('#') || dest.starts_with("//") {
        return None;
    }
    let (location, fragment) = match dest.split_once('#') {
        Some((l, f)) => (l, Some(f.to_string())),
        None => (dest, None),
    };
    let location = location.split_once('?').map_or(location, |(l, _)| l);

    let raw = match scheme(location) {
        Some(s) if s.len() == 1 => location.to_string(), // `C:\x` or `C:/x`
        Some(s) if s.eq_ignore_ascii_case("file") => file_url_to_path(&location[s.len() + 1..])?,
        Some(_) => return None,
        None => location.to_string(),
    };
    let decoded = paths::percent_decode(&raw);
    if decoded.is_empty() {
        return None;
    }
    let p = Path::new(&decoded);
    let abs = if p.has_root() || p.is_absolute() {
        paths::absolutize(p)
    } else if let Some(base) = base_dir {
        paths::absolutize(&base.join(p))
    } else {
        paths::absolutize(p)
    };
    Some(LocalTarget { path: paths::display_path(&abs), fragment })
}

/// `//host/share/x`, `///C:/x` or `/C:/x` (the part after `file:`) -> `\\host\share\x` / `C:/x`.
fn file_url_to_path(rest: &str) -> Option<String> {
    let (host, path) = match rest.strip_prefix("//") {
        Some(after) => match after.find('/') {
            Some(i) => (&after[..i], &after[i..]),
            None => (after, ""),
        },
        None => ("", rest),
    };
    let b = path.as_bytes();
    let path = if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        &path[1..]
    } else {
        path
    };
    if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        (!path.is_empty()).then(|| path.to_string())
    } else {
        Some(format!("//{host}{path}"))
    }
}

/// GitHub-style slug: lowercase, keep letters/numbers/`-`/`_`, spaces -> `-`, drop the rest.
fn slugify(text: &str) -> String {
    let mut slug = String::with_capacity(text.len());
    for c in text.chars() {
        if c == ' ' {
            slug.push('-');
        } else if c.is_alphanumeric() {
            slug.extend(c.to_lowercase());
        } else if c == '-' || c == '_' {
            slug.push(c);
        }
    }
    if slug.is_empty() {
        slug.push_str("section");
    }
    slug
}

/// Per-document heading id registry.
#[derive(Default)]
struct HeadingIds {
    used: HashSet<String>,
    next_suffix: HashMap<String, usize>,
}

impl HeadingIds {
    fn reserve(&mut self, id: &str) {
        self.used.insert(id.to_string());
    }

    fn unique(&mut self, base: String) -> String {
        if self.used.insert(base.clone()) {
            return base;
        }
        let n = self.next_suffix.entry(base.clone()).or_insert(0);
        loop {
            *n += 1;
            let candidate = format!("{base}-{n}");
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const SAMPLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/sample.md"));
    const BASE: &str = r"C:\docs\notes";

    fn render(src: &str) -> String {
        render_markdown(src, Some(Path::new(BASE)))
    }

    #[test]
    fn slugs_dedupe_and_unicode() {
        let html = render(SAMPLE);
        assert!(html.contains(r#"<h2 id="duplicate-heading">Duplicate heading</h2>"#), "{html}");
        assert!(html.contains(r#"<h2 id="duplicate-heading-1">Duplicate heading</h2>"#));
        assert!(html.contains(r#"id="ünïcödé--punctuation-heading""#));
        assert!(html.contains(r#"<h1 id="mdread-sample-document">"#));
    }

    #[test]
    fn explicit_id_wins_and_is_reserved() {
        let html = render("# Hello {#custom}\n\n## custom\n\n## Hello\n");
        assert!(html.contains(r#"<h1 id="custom">Hello</h1>"#), "{html}");
        assert!(html.contains(r#"<h2 id="custom-1">custom</h2>"#), "{html}");
        assert!(html.contains(r#"<h2 id="hello">Hello</h2>"#), "{html}");
    }

    #[test]
    fn empty_and_symbol_only_headings_become_section() {
        let html = render("# !!!\n\n# ???\n\n#\n");
        assert!(html.contains(r#"<h1 id="section">"#), "{html}");
        assert!(html.contains(r#"<h1 id="section-1">"#), "{html}");
        assert!(html.contains(r#"<h1 id="section-2">"#), "{html}");
    }

    #[test]
    fn heading_slug_uses_inline_text_and_code() {
        let html = render("## A *b* `c_d` [e](https://x.y)\n");
        assert!(html.contains(r#"id="a-b-c_d-e""#), "{html}");
    }

    #[test]
    fn local_link_with_encoded_spaces() {
        let html = render("[spaced doc](sub%20dir/spaced%20name.md)");
        assert!(
            html.contains(
                r#"<a href="sub%20dir/spaced%20name.md" data-local-path="C:\docs\notes\sub dir\spaced name.md">spaced doc</a>"#
            ),
            "{html}"
        );
    }

    #[test]
    fn local_link_fragment_query_title_and_dotdot() {
        let html = render(r#"[x](../other.md?v=1#Second-Section "T&T")"#);
        assert!(
            html.contains(
                r#"<a href="../other.md?v=1#Second-Section" data-local-path="C:\docs\other.md" data-fragment="Second-Section" title="T&amp;T">x</a>"#
            ),
            "{html}"
        );
    }

    #[test]
    fn drive_letter_and_file_urls_are_local() {
        let html = render("[a](C:\\x\\a.md) [b](C:/y/b.md) [c](file:///D:/z%20z/c.md#f) [d](file://srv/share/d.md)");
        assert!(html.contains(r#"data-local-path="C:\x\a.md""#), "{html}");
        assert!(html.contains(r#"data-local-path="C:\y\b.md""#), "{html}");
        assert!(html.contains(r#"data-local-path="D:\z z\c.md" data-fragment="f""#), "{html}");
        assert!(html.contains(r#"data-local-path="\\srv\share\d.md""#), "{html}");
    }

    #[test]
    fn non_local_links_are_unchanged() {
        let html = render("[w](https://example.com/a) [m](mailto:a@b.c) [f](#tables) [t](tel:123) <https://r.org> <a@b.c>");
        assert_eq!(html.matches("data-local-path").count(), 0, "{html}");
        assert!(html.contains(r#"<a href="https://example.com/a">w</a>"#));
        assert!(html.contains(r#"<a href="mailto:a@b.c">m</a>"#));
        assert!(html.contains(r##"<a href="#tables">f</a>"##));
        assert!(html.contains(r#"<a href="tel:123">t</a>"#));
        assert!(html.contains(r#"<a href="https://r.org">https://r.org</a>"#));
        assert!(html.contains(r#"<a href="mailto:a@b.c">a@b.c</a>"#));
    }

    #[test]
    fn sample_links() {
        let html = render(SAMPLE);
        assert!(html.contains(r#"href="other.md#second-section" data-local-path="C:\docs\notes\other.md" data-fragment="second-section""#), "{html}");
        assert!(html.contains(r#"data-local-path="C:\docs\notes\notes.txt""#));
        assert!(html.contains(r##"<a href="#tables">Tables</a>"##));
    }

    #[test]
    fn local_image_gets_exact_asset_url() {
        let html = render_markdown("![a b](p%20q/p.png)", Some(Path::new(r"C:\a b")));
        assert!(
            html.contains(r#"<img src="http://asset.localhost/C%3A%5Ca%20b%5Cp%20q%5Cp.png" alt="a b" />"#),
            "{html}"
        );
        // CommonMark needs <...> around a destination that contains spaces.
        let html = render_markdown("![x](<C:\\a b\\p.png>)", None);
        assert!(html.contains(r#"src="http://asset.localhost/C%3A%5Ca%20b%5Cp.png""#), "{html}");
    }

    #[test]
    fn remote_and_data_images_unchanged() {
        let html = render("![r](https://img.shields.io/x.svg) ![d](data:image/png;base64,AAAA)");
        assert!(html.contains(r#"src="https://img.shields.io/x.svg""#), "{html}");
        assert!(html.contains(r#"src="data:image/png;base64,AAAA""#));
        assert!(!html.contains("asset.localhost"));
    }

    #[test]
    fn sample_image() {
        let html = render(SAMPLE);
        assert!(html.contains(r#"src="http://asset.localhost/C%3A%5Cdocs%5Cnotes%5Cimages%5Cpixel.png""#), "{html}");
    }

    #[test]
    fn front_matter_hidden() {
        let html = render(SAMPLE);
        assert!(!html.contains("title: mdread sample"), "{html}");
        assert!(!html.contains("fixture"));
        assert!(html.starts_with("<h1"));
    }

    #[test]
    fn gfm_features_present() {
        let html = render(SAMPLE);
        assert!(html.contains("markdown-alert-note"), "{html}");
        assert!(html.contains("markdown-alert-warning"));
        assert!(html.contains("text-align: center") || html.contains("text-align:center"));
        assert!(html.contains("<del>strikethrough</del>"));
        assert!(html.contains(r#"type="checkbox""#) && html.contains("disabled"));
        assert!(html.contains(r#"class="language-rust""#));
        assert!(html.contains("footnote"));
    }

    #[test]
    fn raw_html_passes_through() {
        let html = render(SAMPLE);
        assert!(html.contains("<details>") && html.contains("<summary>Click to expand</summary>"));
        assert!(html.contains("<script>document.title"));
        assert!(html.contains(r#"<img src="x" onerror="#));
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert_eq!(render(""), "");
    }

    #[test]
    #[ignore]
    fn perf_render_1mib() {
        let mut big = String::new();
        while big.len() < 1024 * 1024 {
            big.push_str(SAMPLE);
            big.push('\n');
        }
        let base = Path::new(BASE);
        std::hint::black_box(render_markdown(&big, Some(base)));
        let mut best = f64::MAX;
        for _ in 0..7 {
            let t = Instant::now();
            let out = render_markdown(std::hint::black_box(&big), Some(base));
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(out);
        }
        println!("perf_render_1mib: {} bytes, best of 7 = {best:.2} ms", big.len());
        assert!(best < 50.0, "render took {best:.2} ms (limit 50 ms)");
    }
}
