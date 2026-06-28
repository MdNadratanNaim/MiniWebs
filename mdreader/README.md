# How it currently works:

- **Upload card** — `drag-and-drop` or `click-to-browse`, reads the file in-browser with FileReader (nothing uploaded anywhere).

- **Link card** — type `owner/repo/branch/file.md` or a full `https://...md` URL.

- **View button** — prioritizes a selected file, otherwise uses the link — plays a brief scanline animation, then swaps the form for the rendered article ("standalone page" view, built entirely client-side since there's no backend here to actually serve separate static pages).

- **Deep linking** — `index.html?view=test/adfsdf/pdf.md` → fetches `https://raw.githubusercontent.com/test/adfsdf/pdf.md`. `index.html?view=https://example.com/test/jdffd.md` → fetches that URL directly (anything starting with `http://` or `https://` is used as-is). This also runs on page load and updates the address bar when you load via the link card, so the result is shareable.

- **Markdown parser** — a small hand-written parser (no library) covering headers, bold/italic/strikethrough, inline code, fenced code blocks, blockquotes, ordered/unordered lists, tables, images, links, autolinks, and --- rules. It escapes unsafe raw HTML and blocks javascript:/data: URLs, so pasted-in markdown can't run script.

- **LaTeX support** — added KaTeX via CDN. The parser now extracts `$...$` and `$$...$$` *before* bold/italic processing so things like `$x_i + y^2$` don't get mangled by markdown's underscore/asterisk rules, then KaTeX typesets them after the HTML is inserted. Currency text like "$5 and $10" is left alone (delimiters can't have inner whitespace — same rule Pandoc uses), and `\$` escapes to a literal dollar sign if you need both real LaTeX and prices in the same doc.

- **Relative image/link resolution** — when markdown is loaded via a URL, relative paths (`public/resources/images/favicon.svg`) now resolve against that file's location, exactly like the GitHub example you gave. Verified: a README at `.../main/README.md` referencing `public/resources/images/favicon.svg` resolves to `.../main/public/resources/images/favicon.svg`. Local file uploads have no remote base, so relative paths there are left as typed (nothing else to resolve them against). I extended the same resolution to markdown links, not just images — seemed like the natural companion fix.
