/* =========================================================
   md.reader — script.js
   1. Tiny markdown -> HTML parser (no dependencies)
   2. App logic: upload / link input, view switching,
      ?view= deep-link resolution
   ========================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------
     1. MARKDOWN PARSER
     --------------------------------------------------------- */

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Reject script-executing URL schemes; allow normal http(s)/mailto/relative links.
  function sanitizeUrl(url) {
    const trimmed = (url || '').trim();
    if (/^(javascript|data|vbscript):/i.test(trimmed)) return '#';
    return trimmed;
  }

  /* ---- Resolve a markdown-relative URL (image/link target) against the
     URL of the source markdown file, the same way a browser resolves a
     relative <img src> against its page. Only kicks in for links loaded
     from a remote URL (file uploads have no remote base, so relative
     paths are left as-is — there's nowhere safe to resolve them against).
     Anything that already has a scheme (http:, mailto:, #fragment, etc.)
     passes through untouched. */
  function resolveAgainstBase(url, baseUrl) {
    if (!baseUrl || !url) return url;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url; // already absolute / has a scheme
    if (/^[#?]/.test(url)) return url; // pure fragment or query, leave for the current page
    try {
      return new URL(url, baseUrl).href;
    } catch (e) {
      return url;
    }
  }

  /* ---- Allowlist-based raw HTML pass-through ----
     Markdown files often contain a handful of plain HTML tags (<br>, <div>,
     <img>, <span>, <table> tweaks, and so on). Rather than escaping every
     "<" and ">" in the document, recognized tags from a fixed allowlist are
     kept as real markup (with attributes sanitized); anything not on the
     list — <script>, <iframe>, <style>, <form>, event handlers, etc. — is
     shown as plain escaped text instead of being parsed as markup. */

  const ALLOWED_TAGS = new Set([
    'a', 'b', 'i', 'em', 'strong', 'br', 'hr', 'div', 'span', 'p', 'img',
    'ul', 'ol', 'li', 'blockquote', 'sub', 'sup', 'small', 'kbd', 'mark',
    'del', 'ins', 'u', 'figure', 'figcaption', 'details', 'summary',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre'
  ]);
  const SELF_CLOSING_TAGS = new Set(['br', 'hr', 'img']);
  const GLOBAL_SAFE_ATTRS = ['class', 'id', 'title', 'align', 'width', 'height', 'colspan', 'rowspan', 'start', 'type'];
  const TAG_EXTRA_ATTRS = {
    a: ['href', 'target'],
    img: ['src', 'alt', 'width', 'height'],
  };

  function sanitizeAttributes(tagName, attrString) {
    const allowed = new Set(GLOBAL_SAFE_ATTRS.concat(TAG_EXTRA_ATTRS[tagName] || []));
    const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m, out = '', sawBlankTarget = false;

    while ((m = attrRegex.exec(attrString))) {
      const name = m[1].toLowerCase();
      if (name === 'on' || name.indexOf('on') === 0) continue; // strip all event handlers (onclick, onerror, ...)
      if (!allowed.has(name)) continue;
      let value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] || '');

      if (name === 'href' || name === 'src') value = resolveAgainstBase(sanitizeUrl(value), renderBaseUrl);
      if (name === 'target') {
        if (['_blank', '_self', '_parent', '_top'].indexOf(value) === -1) continue;
        if (value === '_blank') sawBlankTarget = true;
      }
      out += ' ' + name + '="' + String(value).replace(/"/g, '&quot;') + '"';
    }
    if (tagName === 'a' && sawBlankTarget) out += ' rel="noopener noreferrer"';
    return out;
  }

  // Decide what to do with one matched tag-like chunk of text.
  function sanitizeTag(raw) {
    const m = raw.match(/^<(\/)?([a-zA-Z][a-zA-Z0-9]*)\s*([^<>]*)>$/);
    if (!m) return escapeHtml(raw); // malformed — show literally
    const closing = !!m[1];
    const tagName = m[2].toLowerCase();
    let attrPart = (m[3] || '').replace(/\/\s*$/, '').trim();

    if (!ALLOWED_TAGS.has(tagName)) return escapeHtml(raw); // not on the list — show literally, never executed

    if (closing) {
      return SELF_CLOSING_TAGS.has(tagName) ? '' : '</' + tagName + '>';
    }
    const safeAttrs = sanitizeAttributes(tagName, attrPart);
    return '<' + tagName + safeAttrs + (SELF_CLOSING_TAGS.has(tagName) ? ' />' : '>');
  }

  // Walk the text once: pull out anything that looks like an HTML tag,
  // sanitize it in isolation, then escape everything else as plain text.
  function passThroughSafeHtml(text) {
    const tags = [];
    text = text.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\s*\/?>/g, function (tag) {
      const idx = tags.push(sanitizeTag(tag)) - 1;
      return '\u0001TAG' + idx + '\u0001';
    });
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(/\u0001TAG(\d+)\u0001/g, function (m, i) { return tags[+i]; });
    return text;
  }

  // Set once per parseMarkdown() call; read by the image/link handlers in
  // parseInline() below. Not a function param because parseInline is called
  // from many places (headers, paragraphs, list items, table cells, ...)
  // and threading it through every call site would be a lot of churn for a
  // single-pass synchronous render.
  let renderBaseUrl = null;

  // Reference-style link/image definitions collected from the whole document
  // (e.g. "[ref]: https://example.com \"title\""), keyed by lowercased label.
  // Populated once per parseMarkdown() call, read by parseInline() below —
  // same reasoning as renderBaseUrl above.
  let renderLinkRefs = {};

  // Inline-level: bold, italic, strikethrough, code spans, links, images, autolinks.
  function parseInline(text) {
    // 1. Pull out inline code spans first so nothing inside them gets touched.
    const codeSpans = [];
    text = text.replace(/`([^`]+)`/g, function (m, code) {
      const idx = codeSpans.push(escapeHtml(code)) - 1;
      return '\u0000CODE' + idx + '\u0000';
    });

    // 2. LaTeX math spans, pulled out before any other inline rule can see
    //    them — markdown's *_ emphasis characters are extremely common
    //    inside math (subscripts, multiplication) and would otherwise get
    //    rewritten into <em>/<strong> tags. The literal "$...$"/"$$...$$"
    //    text is restored afterwards (HTML-escaped) and rendered into real
    //    typeset math by KaTeX once the page inserts this HTML into the DOM.
    //    Delimiters can't have inner leading/trailing whitespace — this is
    //    the same rule Pandoc uses for $-math, and it's what keeps prose
    //    like "$5 and $10" from being misread as a formula.
    const mathSpans = [];
    text = text.replace(/\$\$([^\$\n]+?)\$\$/g, function (m, expr) {
      const idx = mathSpans.push('$$' + expr + '$$') - 1;
      return '\u0002MATH' + idx + '\u0002';
    });
    text = text.replace(/\$([^\s$](?:[^\$\n]*?[^\s$])?)\$/g, function (m, expr) {
      const idx = mathSpans.push('$' + expr + '$') - 1;
      return '\u0002MATH' + idx + '\u0002';
    });

    // 3. Backslash-escapes: "\*", "\_", "\[", etc. let any of these
    //    markdown-significant characters through as a literal, the same way
    //    real markdown does. This runs *after* code/math extraction above —
    //    both are full of literal backslashes with their own meaning (LaTeX's
    //    "\\" row separator, regex escapes, etc.) that must never be read as
    //    markdown escape sequences. Restored as plain escaped text at the end.
    const escapedChars = [];
    text = text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, function (m, ch) {
      const idx = escapedChars.push(ch) - 1;
      return '\u0003ESC' + idx + '\u0003';
    });

    // 4. Let allowlisted HTML tags through as real markup; escape everything else.
    text = passThroughSafeHtml(text);

    // 4b. Reference-style images/links: ![alt][ref] and [text][ref] (or the
    //     shorthand [text][] which reuses the visible text as the ref key),
    //     resolved against the "[ref]: url \"title\"" definitions collected
    //     for the whole document in renderLinkRefs. Runs before the inline
    //     "(url)" forms below since the bracket syntax is unambiguous either way.
    text = text.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, function (m, alt, ref) {
      const def = renderLinkRefs[(ref || alt).toLowerCase()];
      if (!def) return m;
      const safeUrl = resolveAgainstBase(sanitizeUrl(def.url), renderBaseUrl).replace(/"/g, '&quot;');
      const safeAlt = alt.replace(/"/g, '&quot;');
      return '<img src="' + safeUrl + '" alt="' + safeAlt + '"' +
        (def.title ? ' title="' + def.title.replace(/"/g, '&quot;') + '"' : '') + ' loading="lazy">';
    });
    text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, function (m, label, ref) {
      const def = renderLinkRefs[(ref || label).toLowerCase()];
      if (!def) return m;
      const safeUrl = resolveAgainstBase(sanitizeUrl(def.url), renderBaseUrl).replace(/"/g, '&quot;');
      return '<a href="' + safeUrl + '"' +
        (def.title ? ' title="' + def.title.replace(/"/g, '&quot;') + '"' : '') +
        ' target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });

    // 5. Images ![alt](url "title")
    text = text.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      function (m, alt, url, title) {
        const safeUrl = resolveAgainstBase(sanitizeUrl(url), renderBaseUrl).replace(/"/g, '&quot;');
        const safeAlt = alt.replace(/"/g, '&quot;');
        const safeTitle = (title || '').replace(/"/g, '&quot;');
        return '<img src="' + safeUrl + '" alt="' + safeAlt + '"' +
          (title ? ' title="' + safeTitle + '"' : '') + ' loading="lazy">';
      }
    );

    // 6. Links [text](url "title")
    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      function (m, label, url, title) {
        const safeUrl = resolveAgainstBase(sanitizeUrl(url), renderBaseUrl).replace(/"/g, '&quot;');
        const safeTitle = (title || '').replace(/"/g, '&quot;');
        return '<a href="' + safeUrl + '"' +
          (title ? ' title="' + safeTitle + '"' : '') +
          ' target="_blank" rel="noopener noreferrer">' + label + '</a>';
      }
    );

    // 7. Autolinks <https://...>
    text = text.replace(
      /&lt;((https?:\/\/)[^\s&]+)&gt;/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // 8. Bold + italic combined, then bold, then italic, then strikethrough.
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    text = text.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '<em>$1</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 9. Restore code spans.
    text = text.replace(/\u0000CODE(\d+)\u0000/g, function (m, i) {
      return '<code>' + codeSpans[+i] + '</code>';
    });

    // 10. Restore math spans (as escaped literal "$...$" text — KaTeX's
    //     auto-render pass typesets these after this HTML lands in the DOM).
    text = text.replace(/\u0002MATH(\d+)\u0002/g, function (m, i) {
      return escapeHtml(mathSpans[+i]);
    });

    // 11. Restore backslash-escaped characters from step 1 as plain,
    //     HTML-escaped literal text.
    text = text.replace(/\u0003ESC(\d+)\u0003/g, function (m, i) {
      return escapeHtml(escapedChars[+i]);
    });

    return text;
  }

  // Indentation width of a line, counting a tab as 4 columns — used by
  // parseListItems() to tell nested list items apart from their parents.
  function leadingSpaces(line) {
    const ws = line.match(/^[ \t]*/)[0];
    let n = 0;
    for (let c = 0; c < ws.length; c++) n += ws[c] === '\t' ? 4 : 1;
    return n;
  }

  const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s+/;

  // Parses a run of list items starting at lines[startIdx], all indented at
  // exactly `indent`. Recurses into itself for any more-indented block
  // immediately under an item, which lets a nested "- " or "1. " become a
  // nested <ul>/<ol> rather than flattening into its parent's <li> text.
  // Plain (non-list) indented lines under an item are treated as a wrapped
  // paragraph continuation of that item instead. Returns the rendered HTML
  // for this list plus the line index just past it.
  function parseListItems(lines, startIdx, indent) {
    let i = startIdx;
    let type = null, start = null;
    let itemsHtml = '';

    while (i < lines.length) {
      const line = lines[i];

      // A blank line only continues the list if what follows (after any
      // further blank lines) is still indented at or past this list's level
      // — otherwise the list has ended.
      if (/^[ \t]*$/.test(line)) {
        let j = i + 1;
        while (j < lines.length && /^[ \t]*$/.test(lines[j])) j++;
        if (j >= lines.length) { i = j; break; }
        const nextIndent = leadingSpaces(lines[j]);
        const nextIsItem = LIST_ITEM_RE.test(lines[j]);
        if (nextIndent >= indent && (nextIsItem || nextIndent > indent)) { i = j; continue; }
        break;
      }

      const curIndent = leadingSpaces(line);
      const m = line.match(/^[ \t]*([-*+]|\d+[.)])\s+(.*)$/);
      if (curIndent !== indent || !m) break; // dedent ends this list, deeper indent belongs to an item above

      const marker = m[1];
      const isOrdered = /\d/.test(marker);
      const itemType = isOrdered ? 'ol' : 'ul';
      if (type === null) {
        type = itemType;
        if (isOrdered) start = parseInt(marker, 10);
      } else if (itemType !== type) {
        break; // a different marker type at the same level starts a new list
      }

      let content = m[2];
      let checkboxHtml = '';
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        checkboxHtml = '<input type="checkbox" disabled' + (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ';
        content = task[2];
      }

      i++;
      const contentLines = [content];
      let nestedHtml = '';

      // Everything more-indented than this item (until a line dedents back
      // to `indent` or shallower) belongs to it: either a nested sub-list or
      // a wrapped continuation line of the item's own paragraph text.
      while (i < lines.length) {
        const l = lines[i];

        if (/^[ \t]*$/.test(l)) {
          let k = i + 1;
          while (k < lines.length && /^[ \t]*$/.test(lines[k])) k++;
          if (k < lines.length && leadingSpaces(lines[k]) > indent) { i = k; continue; }
          break;
        }

        const lIndent = leadingSpaces(l);
        if (lIndent <= indent) break;

        if (LIST_ITEM_RE.test(l)) {
          const sub = parseListItems(lines, i, lIndent);
          nestedHtml += sub.html;
          i = sub.next;
          continue;
        }

        contentLines.push(l.trim());
        i++;
      }

      itemsHtml += '<li>' + checkboxHtml + parseInline(contentLines.join(' ')) + nestedHtml + '</li>';
    }

    if (!type) return { html: '', next: startIdx };
    const startAttr = (type === 'ol' && start && start !== 1) ? ' start="' + start + '"' : '';
    return { html: '<' + type + startAttr + '>' + itemsHtml + '</' + type + '>\n', next: i };
  }

  // Block-level: headers, paragraphs, lists, blockquotes, code fences, tables, hr.
  // baseUrl: the URL the markdown was fetched from (omitted for local file
  // uploads), used to resolve relative image/link paths — see resolveAgainstBase().
  function parseMarkdown(src, baseUrl) {
    renderBaseUrl = baseUrl || null;
    src = (src || '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');

    // Pre-scan reference-style link/image definitions ("[ref]: url \"title\"")
    // anywhere in the document, so they can be used before or after they're
    // declared. Definition lines are blanked out in place — they render as
    // nothing themselves, matching normal markdown behavior — everything
    // else is left untouched and at its original line index.
    const linkRefs = {};
    const linkDefRe = /^[ \t]{0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]*)")?\s*$/;
    for (let li = 0; li < lines.length; li++) {
      const dm = lines[li].match(linkDefRe);
      if (dm) {
        linkRefs[dm[1].toLowerCase()] = { url: dm[2], title: dm[3] || '' };
        lines[li] = '';
      }
    }
    renderLinkRefs = linkRefs;

    let html = '';
    let i = 0;

    let inCode = false, codeLang = '', codeBuf = [];
    let inMath = false, mathBuf = [];
    let paraBuf = []; // { text, brk } — brk marks a hard line break after this line
    let quoteBuf = [];

    function flushPara() {
      if (paraBuf.length) {
        let joined = paraBuf[0].text;
        for (let p = 1; p < paraBuf.length; p++) {
          joined += (paraBuf[p - 1].brk ? '<br>' : ' ') + paraBuf[p].text;
        }
        html += '<p>' + parseInline(joined) + '</p>\n';
        paraBuf = [];
      }
    }
    function flushQuote() {
      if (quoteBuf.length) {
        html += '<blockquote>' + parseInline(quoteBuf.join(' ')) + '</blockquote>\n';
        quoteBuf = [];
      }
    }
    function splitRow(row) {
      const cells = row.split('|');
      if (cells.length && cells[0].trim() === '') cells.shift();
      if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
      return cells.map(function (c) { return c.trim(); });
    }
    // Reads alignment (left/center/right) off the "---", ":---", "---:",
    // ":---:" separator row cells; null means no explicit alignment.
    function parseAlign(sepRow) {
      return splitRow(sepRow).map(function (c) {
        const left = c.charAt(0) === ':';
        const right = c.charAt(c.length - 1) === ':';
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return null;
      });
    }
    function flushTable(rows) {
      if (rows.length < 2) return;
      const head = splitRow(rows[0]);
      const aligns = parseAlign(rows[1]);
      const body = rows.slice(2).map(splitRow);
      function alignAttr(idx) {
        return aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '';
      }
      let t = '<table><thead><tr>';
      head.forEach(function (c, idx) { t += '<th' + alignAttr(idx) + '>' + parseInline(c) + '</th>'; });
      t += '</tr></thead><tbody>';
      body.forEach(function (r) {
        t += '<tr>';
        r.forEach(function (c, idx) { t += '<td' + alignAttr(idx) + '>' + parseInline(c) + '</td>'; });
        t += '</tr>';
      });
      t += '</tbody></table>\n';
      html += t;
    }

    while (i < lines.length) {
      const line = lines[i];

      // code fence
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        if (!inCode) {
          flushPara(); flushQuote();
          inCode = true; codeLang = fence[1].trim(); codeBuf = [];
        } else {
          html += '<pre><code class="lang-' + (codeLang || 'text') + '">' +
            escapeHtml(codeBuf.join('\n')) + '</code></pre>\n';
          inCode = false; codeLang = ''; codeBuf = [];
        }
        i++; continue;
      }
      if (inCode) { codeBuf.push(line); i++; continue; }

      // display-math fence: a line containing only "$$" opens/closes a
      // block of LaTeX, kept raw (no inline markdown parsing) so KaTeX's
      // auto-render pass can typeset it once this HTML is in the DOM.
      const mathFence = /^\$\$\s*$/.test(line);
      if (mathFence) {
        if (!inMath) {
          flushPara(); flushQuote();
          inMath = true; mathBuf = [];
        } else {
          html += '<div class="math-display">' +
            escapeHtml('$$' + mathBuf.join('\n') + '$$') + '</div>\n';
          inMath = false; mathBuf = [];
        }
        i++; continue;
      }
      if (inMath) { mathBuf.push(line); i++; continue; }

      // blank line ends current block
      if (/^\s*$/.test(line)) {
        flushPara(); flushQuote();
        i++; continue;
      }

      // setext headings: a paragraph line immediately followed (no blank
      // line between) by a line of "===" promotes it to <h1>, "---" to <h2>.
      // Only fires mid-paragraph — once a blank line has flushed paraBuf, a
      // lone "---" falls through to the horizontal-rule check below instead.
      if (paraBuf.length && /^=+\s*$/.test(line)) {
        const h1Text = paraBuf.map(function (p) { return p.text; }).join(' ');
        html += '<h1>' + parseInline(h1Text) + '</h1>\n';
        paraBuf = [];
        i++; continue;
      }
      if (paraBuf.length && /^-+\s*$/.test(line)) {
        const h2Text = paraBuf.map(function (p) { return p.text; }).join(' ');
        html += '<h2>' + parseInline(h2Text) + '</h2>\n';
        paraBuf = [];
        i++; continue;
      }

      // headers
      const header = line.match(/^(#{1,6})\s+(.*)$/);
      if (header) {
        flushPara(); flushQuote();
        const level = header[1].length;
        html += '<h' + level + '>' + parseInline(header[2].trim()) + '</h' + level + '>\n';
        i++; continue;
      }

      // horizontal rule
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushPara(); flushQuote();
        html += '<hr>\n';
        i++; continue;
      }

      // table: a row with "|" followed by a separator row of dashes/colons/pipes
      if (line.indexOf('|') !== -1 && lines[i + 1] &&
          /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
        flushPara(); flushQuote();
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
          rows.push(lines[i]); i++;
        }
        flushTable(rows);
        continue;
      }

      // blockquote
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushPara();
        quoteBuf.push(quote[1]);
        i++; continue;
      }

      // lists (unordered "-*+" or ordered "1." / "1)"), with nesting,
      // mixed ul/ol, task-list checkboxes, and multi-line item text —
      // fully handled by parseListItems, which consumes every line that
      // belongs to this list (including nested sub-lists) in one go.
      if (LIST_ITEM_RE.test(line)) {
        flushPara(); flushQuote();
        const result = parseListItems(lines, i, leadingSpaces(line));
        html += result.html;
        i = result.next;
        continue;
      }

      // plain paragraph text — a trailing double-space (or backslash) means
      // a hard line break rather than just wrapping to the next line.
      flushQuote();
      paraBuf.push({
        text: line.trim().replace(/\\$/, '').trim(),
        brk: /(?: {2,}|\\)$/.test(line)
      });
      i++;
    }

    if (inCode) {
      html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>\n';
    }
    if (inMath) {
      html += '<div class="math-display">' + escapeHtml('$$' + mathBuf.join('\n')) + '</div>\n';
    }
    flushPara(); flushQuote();

    return html;
  }

  /* ---------------------------------------------------------
     2. APP LOGIC
     --------------------------------------------------------- */

  const els = {
    homeView: document.getElementById('homeView'),
    renderView: document.getElementById('renderView'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    dzText: document.getElementById('dzText'),
    clearFileBtn: document.getElementById('clearFileBtn'),
    linkInput: document.getElementById('linkInput'),
    viewBtn: document.getElementById('viewBtn'),
    viewBtnLabel: document.getElementById('viewBtnLabel'),
    errorLine: document.getElementById('errorLine'),
    backBtn: document.getElementById('backBtn'),
    renderFilename: document.getElementById('renderFilename'),
    sourceLink: document.getElementById('sourceLink'),
    copyLinkBtn: document.getElementById('copyLinkBtn'),
    mdContent: document.getElementById('mdContent'),
    scanLine: document.getElementById('scanLine'),
    themeToggle: document.getElementById('themeToggle'),
  };

  let selectedFile = null;

  /* ---- resolve a typed/linked value into a fetchable URL ----
     - full http(s) URL  -> used as-is
     - "owner/repo/branch/file.md" -> raw.githubusercontent.com/owner/repo/branch/file.md
  */
  function resolveSourceUrl(value) {
    value = value.trim();
    if (/^https?:\/\//i.test(value)) return value;
    value = value.replace(/^\/+/, '');
    return 'https://raw.githubusercontent.com/' + value;
  }

  function showError(message) {
    els.errorLine.textContent = message;
    els.errorLine.hidden = false;
  }
  function clearError() {
    els.errorLine.hidden = true;
    els.errorLine.textContent = '';
  }

  function setBusy(isBusy) {
    els.viewBtn.disabled = isBusy;
    els.viewBtnLabel.textContent = isBusy ? 'Loading…' : 'View rendered markdown';
  }

  function filenameFromUrl(url) {
    try {
      const clean = url.split('?')[0].split('#')[0];
      const parts = clean.split('/');
      return parts[parts.length - 1] || url;
    } catch (e) {
      return url;
    }
  }

  function playScanline() {
    return new Promise(function (resolve) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) { resolve(); return; }
      els.scanLine.classList.remove('run');
      // restart animation
      void els.scanLine.offsetWidth;
      els.scanLine.classList.add('run');
      setTimeout(resolve, 320);
    });
  }

  function renderMarkdownInto(markdownText, opts) {
    opts = opts || {};
    els.mdContent.innerHTML = parseMarkdown(markdownText, opts.baseUrl);
    renderMath(els.mdContent);
    els.renderFilename.textContent = opts.title || 'document.md';
    if (opts.sourceUrl) {
      els.sourceLink.href = opts.sourceUrl;
      els.sourceLink.hidden = false;
    } else {
      els.sourceLink.hidden = true;
    }
    els.homeView.hidden = true;
    els.renderView.hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    els.mdContent.focus();
  }

  // Typeset the literal "$...$" / "$$...$$" text left in the rendered HTML
  // using KaTeX (loaded from a CDN in index.html). Guarded since the CDN
  // script could be slow, blocked, or unavailable — the raw LaTeX source
  // is still perfectly readable as plain text if so.
  function renderMath(container) {
    if (typeof window.renderMathInElement !== 'function') return;
    try {
      window.renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false
      });
    } catch (e) {
      /* malformed LaTeX in the source doc — leave the raw text as-is */
    }
  }

  function showHome() {
    els.renderView.hidden = true;
    els.homeView.hidden = false;
    els.mdContent.innerHTML = '';
  }

  /* ---- File handling ---- */
  function setSelectedFile(file) {
    if (!file) return;
    const looksLikeMarkdown = /\.(md|markdown|txt)$/i.test(file.name) || file.type.indexOf('text') === 0;
    if (!looksLikeMarkdown) {
      showError('That file doesn\u2019t look like markdown or plain text. Try a .md file.');
      return;
    }
    clearError();
    selectedFile = file;
    els.dzText.textContent = file.name;
    els.dzText.classList.add('has-file');
    els.clearFileBtn.hidden = false;
  }

  function clearSelectedFile() {
    selectedFile = null;
    els.fileInput.value = '';
    els.dzText.textContent = 'Drop a .md file here, or click to browse';
    els.dzText.classList.remove('has-file');
    els.clearFileBtn.hidden = true;
  }

  els.fileInput.addEventListener('change', function (e) {
    setSelectedFile(e.target.files[0]);
  });

  els.clearFileBtn.addEventListener('click', function () {
    clearSelectedFile();
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      els.dropzone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      els.dropzone.classList.remove('drag-over');
    });
  });
  els.dropzone.addEventListener('drop', function (e) {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  });
  els.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  /* ---- Link input: Enter triggers view ---- */
  els.linkInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleViewClick();
    }
  });

  /* ---- View button ---- */
  els.viewBtn.addEventListener('click', handleViewClick);

  function handleViewClick() {
    clearError();
    const linkValue = els.linkInput.value.trim();

    if (selectedFile) {
      readFileAndRender(selectedFile);
      return;
    }
    if (linkValue) {
      loadFromLinkAndRender(linkValue, { pushHistory: true });
      return;
    }
    showError('Add a file or paste a link first.');
  }

  function readFileAndRender(file) {
    setBusy(true);
    const reader = new FileReader();
    reader.onload = function () {
      setBusy(false);
      playScanline().then(function () {
        renderMarkdownInto(String(reader.result), { title: file.name, sourceUrl: null, baseUrl: null });
      });
    };
    reader.onerror = function () {
      setBusy(false);
      showError('Couldn\u2019t read that file. Try a different one.');
    };
    reader.readAsText(file);
  }

  function loadFromLinkAndRender(rawValue, opts) {
    opts = opts || {};
    const resolvedUrl = resolveSourceUrl(rawValue);
    setBusy(true);

    fetch(resolvedUrl)
      .then(function (res) {
        if (!res.ok) throw new Error('Server responded with ' + res.status);
        return res.text();
      })
      .then(function (text) {
        setBusy(false);
        if (opts.pushHistory) {
          const params = new URLSearchParams(window.location.search);
          params.set('view', rawValue);
          history.pushState({ view: rawValue }, '', '?' + params.toString());
        }
        return playScanline().then(function () {
          renderMarkdownInto(text, { title: filenameFromUrl(resolvedUrl), sourceUrl: resolvedUrl, baseUrl: resolvedUrl });
        });
      })
      .catch(function (err) {
        setBusy(false);
        showError(
          'Couldn\u2019t load that link (' + err.message + '). Check the URL, or the host may not allow cross-origin requests.'
        );
      });
  }

  /* ---- Back button ---- */
  els.backBtn.addEventListener('click', function () {
    const params = new URLSearchParams(window.location.search);
    params.delete('view');
    const qs = params.toString();
    history.pushState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
    showHome();
  });

  window.addEventListener('popstate', function () {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    if (viewParam) {
      loadFromLinkAndRender(viewParam, { pushHistory: false });
    } else {
      showHome();
    }
  });

  /* ---- Copy link ---- */
  els.copyLinkBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(window.location.href).then(function () {
      const original = els.copyLinkBtn.textContent;
      els.copyLinkBtn.textContent = 'Copied!';
      setTimeout(function () { els.copyLinkBtn.textContent = original; }, 1400);
    }).catch(function () {
      showError('Couldn\u2019t copy the link automatically — copy it from the address bar instead.');
    });
  });

  /* ---- Light / dark mode toggle ----
     index.html sets the initial data-theme attribute synchronously before
     first paint (from localStorage, falling back to the OS preference) so
     there's no flash on load. This just wires up the click handler and
     keeps the button's accessible state in sync. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (els.themeToggle) {
      els.themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      els.themeToggle.setAttribute(
        'aria-label',
        theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
      );
    }
  }

  if (els.themeToggle) {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

    els.themeToggle.addEventListener('click', function () {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('mdreader-theme', next); } catch (e) { /* private browsing, etc. */ }
    });
  }

  /* ---- Deep link on initial load: ?view=owner/repo/branch/file.md or ?view=https://... ---- */
  (function init() {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    if (viewParam) {
      els.linkInput.value = viewParam;
      loadFromLinkAndRender(viewParam, { pushHistory: false });
    }
  })();

})();