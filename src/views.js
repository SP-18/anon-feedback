import { MAX_FEEDBACK_CHARS } from './config.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function layout(title, content, { script = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/public/style.css">
${script ? '<script src="/app.js" defer></script>\n' : ''}</head>
<body>
<main class="card">
${content}
</main>
</body>
</html>
`;
}

export function renderGate({ error } = {}) {
  return layout('Anonymous feedback', `<h1>Anonymous feedback</h1>
<form method="post" action="/unlock">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<label for="code">Organisation access code</label>
<input id="code" name="code" type="password" required autocomplete="off">
<button type="submit">Continue</button>
</form>`);
}

export function renderForm({ error, value = '' } = {}) {
  return layout('Anonymous feedback', `<h1>Anonymous feedback</h1>
<p class="note">Your feedback is anonymous. We don't store your name, IP address, browser details or submission time — only the date.</p>
<form id="feedback-form" method="post" action="/submit" autocomplete="off">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<label for="feedback">Your feedback</label>
<textarea id="feedback" name="feedback" rows="8" required maxlength="${MAX_FEEDBACK_CHARS}" autocomplete="off">${escapeHtml(value)}</textarea>
<button type="submit">Submit feedback</button>
</form>`, { script: true });
}

export function renderThanks() {
  return layout('Feedback submitted', `<h1>Thanks — your feedback was submitted.</h1>
<p>It's stored anonymously. Nothing links it back to you.</p>
<a id="submit-another" class="button" href="/">Submit another</a>`, { script: true });
}

export function renderError({ status = 500, message = 'Something went wrong. Please try again later.' } = {}) {
  return layout('Error', `<h1>${status === 404 ? 'Not found' : 'Error'}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to the form</a></p>`);
}
