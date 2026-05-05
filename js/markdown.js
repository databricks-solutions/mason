// Markdown + syntax highlighting setup

function setupMarkdown() {
  const renderer = new marked.Renderer();
  renderer.code = function(codeArg, langArg, escaped) {
    let text, lang;
    if (typeof codeArg === "object" && codeArg !== null) {
      text = codeArg.text || codeArg.code || "";
      lang = codeArg.lang || "";
    } else {
      text = codeArg || "";
      lang = langArg || "";
    }
    let highlighted;
    try {
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(text, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
    } catch (_) {
      highlighted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    const langLabel = lang
      ? `<div style="display:flex;justify-content:space-between;padding:6px 14px 0;opacity:0.4;font-size:0.75rem;">${lang}<button class="code-copy-btn" style="background:none;border:none;cursor:pointer;opacity:0.6;font-size:0.8rem;color:inherit;">&#128203;</button></div>`
      : "";
    return `<pre>${langLabel}<code class="hljs language-${lang}">${highlighted}</code></pre>`;
  };
  marked.setOptions({ renderer, breaks: true });
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text), {
    ALLOWED_TAGS: [
      "p", "br", "hr", "strong", "em", "del", "code", "pre", "a",
      "ul", "ol", "li", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "table", "thead", "tbody", "tr", "td", "th",
      "span", "div", "button", "img",
    ],
    ALLOWED_ATTR: ["href", "title", "class", "src", "alt", "style"],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  });
}
