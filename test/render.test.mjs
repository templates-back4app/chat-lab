// File: test/render.test.mjs · amendment B3's hardened "rendering is the client's job": the shipped demo
// client renders message text safely — escaped, never injected as markup — asserted with a hostile-body
// fixture. Pure unit tests, no server. The server stores bodies verbatim (test/matrix.test.mjs T5h proves the
// hostile body crosses the API unmodified), so the LAST line of defense is exactly this module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderMessageText, renderMessageHtml } from '../client/render.mjs';
import { HOSTILE_BODY } from './fixtures.mjs';

test('B3a the hostile-body fixture renders with every metacharacter escaped', () => {
  const html = renderMessageText({ deleted: false, body: HOSTILE_BODY });
  assert.ok(!html.includes('<img'), 'no <img tag survives');
  assert.ok(!html.includes('<script'), 'no <script tag survives');
  assert.ok(!html.includes('onerror="alert'), 'no live event handler survives');
  assert.equal(html, '&lt;img src=x onerror=&quot;alert(&#39;pwned&#39;)&quot;&gt;&lt;script&gt;document.title=&#39;pwned&#39;&lt;/script&gt;&quot;&#39;&amp;');
});

test('B3b the full message row escapes author and id too, and marks deletions without leaking the old body', () => {
  const html = renderMessageHtml({
    id: 'abc"><script>x</script>',
    authorId: '<b>mallory</b>',
    body: 'does not matter',
    deleted: true,
    createdAt: '2026-10-30T12:00:00.000Z',
  });
  assert.ok(!/<script>/.test(html), 'no unescaped script anywhere in the row');
  assert.ok(!/<b>/.test(html), 'author id is escaped');
  assert.match(html, /class="message deleted"/);
  assert.match(html, /<em>message deleted<\/em>/, 'deleted messages show the placeholder, not the body');
  assert.ok(!html.includes('does not matter'), 'a deleted message\'s body never reaches the DOM (it is also redacted server-side)');
});

test('B3c escapeHtml round-trips plain text untouched', () => {
  assert.equal(escapeHtml('plain text, no metacharacters'), 'plain text, no metacharacters');
  assert.equal(escapeHtml(''), '');
});
