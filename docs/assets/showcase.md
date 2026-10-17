# Project Atlas

A **fast** look at the week: open any `.md` file and it's on screen before you blink. Edit it in your favorite editor and mdread reloads it [live](#).

> [!TIP]
> Press **Ctrl+T** to switch between system, light and dark themes.

## Sprint board

| Task | Owner | Status |
|:-----|:-----:|-------:|
| Ship the parser | Ana | ✅ Done |
| Dark mode polish | Ben | 🚧 75% |
| Docs site | Chloe | 📝 Draft |

## Checklist

- [x] Render GitHub-flavored Markdown
- [x] Follow links between notes
- [ ] Take a coffee break

## Snippet

```rust
fn main() {
    let doc = mdread::open("notes.md")?;
    println!("{} words", doc.words());
}
```
