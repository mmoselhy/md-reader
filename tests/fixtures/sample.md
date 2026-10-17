---
title: mdread sample
tags: [fixture, gfm]
---

# mdread sample document

A paragraph with **bold**, *italic*, ~~strikethrough~~, `inline code`, and a [web link](https://example.com).
Autolink: <https://www.rust-lang.org>. Email: <someone@example.com>.

## Links and images

- Fragment link to [Tables](#tables)
- Relative Markdown link to [the other doc](other.md) and [a section in it](other.md#second-section)
- Link to a local non-Markdown file: [notes.txt](notes.txt)
- Link with spaces: [spaced doc](sub%20dir/spaced%20name.md)
- Local image: ![local image](images/pixel.png)
- Remote image: ![badge](https://img.shields.io/badge/mdread-v0.1-blue)

## Tables

| Left | Center | Right |
|:-----|:------:|------:|
| a    |   b    |     c |
| `x`  | **y**  |    1.5 |

## Task list

- [x] Done item
- [ ] Open item

## Code

```rust
fn main() {
    println!("Hello, mdread!");
}
```

    indented code block

## Quotes and alerts

> A plain blockquote
> spanning two lines.

> [!NOTE]
> GitHub-style note alert.

> [!WARNING]
> GitHub-style warning alert.

## Footnotes

Here is a footnote reference.[^1]

[^1]: And the footnote text.

## Duplicate heading

## Duplicate heading

### Ünïcödé & Punctuation: Heading!

## Raw HTML

<details>
<summary>Click to expand</summary>

Hidden content.

</details>

<script>document.title = "pwned";</script>
<img src="x" onerror="document.title='pwned'">

---

Final paragraph after a thematic break.
