// File: test/fixtures.mjs · shared fixtures (no tests in here — safe to import from any suite).

// The hostile message body of amendment B3: markup injection, an event handler, a script tag, and the quote/
// ampersand metacharacters. Stored VERBATIM by the server (bodies are data — matrix T5), rendered inert by
// the shipped client (render.test.mjs).
export const HOSTILE_BODY = `<img src=x onerror="alert('pwned')"><script>document.title='pwned'</script>"'&`;
