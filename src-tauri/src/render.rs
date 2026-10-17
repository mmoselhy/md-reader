// SCAFFOLD STUB: Task A implements Markdown -> HTML per SPEC.md "Rendering rules".
use std::path::Path;

pub fn render_markdown(source: &str, _base_dir: Option<&Path>) -> String {
    let mut html = String::with_capacity(source.len() * 3 / 2);
    pulldown_cmark::html::push_html(&mut html, pulldown_cmark::Parser::new(source));
    html
}
