// Tiny, dependency-free-ish markdown renderer (safe subset).
// Converts markdown to HTML with escaping to prevent script injection.
// Supports: code blocks, inline code, bold/italic, links, headings, lists.

function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(md: string) {
  let s = esc(md);

  // inline code
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${esc(c)}</code>`);

  // bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => {
    const safeUrl = esc(url);
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${text}</a>`;
  });

  return s;
}

export function markdownToHtml(md: string) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  for (const raw of lines) {
    const line = raw;

    const fence = line.match(/^```\s*([a-zA-Z0-9_-]+)?\s*$/);
    if (fence) {
      if (!inCode) {
        closeLists();
        inCode = true;
        codeLang = fence[1] ?? '';
        codeBuf = [];
      } else {
        // close
        const langClass = codeLang ? ` class="lang-${esc(codeLang)}"` : '';
        out.push(`<pre><code${langClass}>${esc(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
        codeLang = '';
        codeBuf = [];
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
      continue;
    }

    // unordered list
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    // ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }

    // blank line
    if (!line.trim()) {
      closeLists();
      continue;
    }

    // paragraph
    closeLists();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (inCode) {
    const langClass = codeLang ? ` class="lang-${esc(codeLang)}"` : '';
    out.push(`<pre><code${langClass}>${esc(codeBuf.join('\n'))}</code></pre>`);
  }

  closeLists();
  return out.join('\n');
}
