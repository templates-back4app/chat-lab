// File: client/render.mjs · ESM, shared by the demo page and the test suite.
//
// Message bodies are stored as PLAIN TEXT and the server never interprets them; rendering/escaping is the
// client's job (brief §3), and this module is how the shipped demo client does it: every piece of
// user-controlled text goes through escapeHtml before it is ever concatenated into markup, and nothing is
// assigned via innerHTML elsewhere. test/render.test.mjs asserts it with a hostile-body fixture
// (amendment B3: "the shipped demo client renders message text safely — escaped, never injected as markup").

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The text a message displays: the escaped body, or the deletion placeholder (the body is already redacted
 *  server-side; the placeholder only tells the reader why the bubble is empty). */
export function renderMessageText(message) {
  if (message.deleted) return '<em>message deleted</em>';
  return escapeHtml(message.body);
}

/** One message as an HTML string. Author ids are user-controlled too (usernames would be worse) — escaped. */
export function renderMessageHtml(message) {
  const cls = message.deleted ? 'message deleted' : 'message';
  return `<li class="${cls}" data-id="${escapeHtml(message.id)}">` +
    `<span class="author">${escapeHtml(message.authorId || '?')}</span>` +
    `<span class="body">${renderMessageText(message)}</span>` +
    `<span class="time">${escapeHtml(message.createdAt || '')}</span>` +
    `</li>`;
}
