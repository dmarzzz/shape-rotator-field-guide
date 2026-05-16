// escape.js — tiny HTML/attribute escapers used by the card and form
// renderers. Lifted verbatim from alchemy.js so both the Electron app
// and the sibling web app reach for the same helper.

export function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Attribute-safe variant — double-quote is the only char that can break
// an attribute once escHtml has run, but it's a no-op redundancy that
// keeps the alchemy.js call sites untouched.
export function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}
