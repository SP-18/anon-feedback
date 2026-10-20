import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from './db.js';
import { createAuth } from './auth.js';
import { MAX_BODY_SIZE, MAX_FEEDBACK_CHARS } from './config.js';
import { renderError, renderForm, renderGate, renderThanks } from './views.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function sendHtml(res, status, html) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
}

export function createApp({
  pool,
  accessCode = process.env.ACCESS_CODE,
  sessionSecret = process.env.SESSION_SECRET,
  secureCookies = process.env.NODE_ENV === 'production',
} = {}) {
  if (!pool) throw new Error('createApp requires a pg pool');
  const auth = createAuth({ accessCode, sessionSecret, secureCookies });

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  app.use('/public', express.static(publicDir, { index: false, dotfiles: 'ignore' }));
  app.get('/app.js', (req, res) => res.sendFile('app.js', { root: publicDir }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use(express.urlencoded({ extended: false, limit: MAX_BODY_SIZE }));

  app.get('/', (req, res) => {
    if (!auth.isUnlocked(req)) return sendHtml(res, 200, renderGate());
    sendHtml(res, 200, renderForm());
  });

  app.get('/thanks', (req, res) => {
    if (!auth.isUnlocked(req)) return res.redirect(303, '/');
    sendHtml(res, 200, renderThanks());
  });

  app.post('/unlock', (req, res) => {
    if (!auth.checkCode(req.body?.code)) {
      return sendHtml(res, 401, renderGate({ error: 'Invalid code' }));
    }
    auth.setCookie(res);
    res.redirect(303, '/');
  });

  app.post('/submit', async (req, res) => {
    if (!auth.isUnlocked(req)) return res.redirect(303, '/');

    const raw = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
    const body = raw.trim();
    if (body.length === 0) {
      return sendHtml(res, 400, renderForm({ error: 'Please enter some feedback.', value: raw }));
    }
    if (body.length > MAX_FEEDBACK_CHARS) {
      return sendHtml(res, 400, renderForm({
        error: `Feedback must be ${MAX_FEEDBACK_CHARS.toLocaleString('en-US')} characters or fewer.`,
        value: raw,
      }));
    }

    await pool.query('INSERT INTO submissions (body) VALUES ($1)', [body]);
    res.redirect(303, '/thanks');
  });

  app.use((req, res) => {
    sendHtml(res, 404, renderError({ status: 404, message: 'That page does not exist.' }));
  });

  // Logs only the error itself — never the request, its headers or its body.
  app.use((err, req, res, next) => {
    console.error(err.stack || err.message);
    if (res.headersSent) return next(err);
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    sendHtml(res, status, renderError({ status }));
  });

  return app;
}

const WRITER_FORBIDDEN = ['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE'];

// Catalog check only (never reads submissions). The app's role must be INSERT-only:
// in production any extra privilege is fatal, elsewhere it's a warning.
export async function checkWriterPrivileges(pool, { production = process.env.NODE_ENV === 'production', warn = console.warn } = {}) {
  const { rows: [row] } = await pool.query(
    `SELECT current_user AS role, ${WRITER_FORBIDDEN.map((p) => `has_table_privilege('submissions', '${p}') AS "${p}"`).join(', ')}`);
  const excess = WRITER_FORBIDDEN.filter((p) => row[p]);
  if (excess.length === 0) return;
  const message = `DATABASE_URL role "${row.role}" has ${excess.join(', ')} on submissions; the app must connect as the INSERT-only writer role`;
  if (production) throw new Error(message);
  warn(`Warning: ${message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  const app = createApp({ pool });
  const port = Number(process.env.PORT) || 3000;

  // Fail closed in production: refuse to serve until the role check passes.
  try {
    await checkWriterPrivileges(pool);
  } catch (err) {
    console.error(`Startup check failed: ${err.message}`);
    if (process.env.NODE_ENV === 'production') {
      await pool.end().catch(() => {});
      process.exit(1);
    }
  }

  const server = app.listen(port, () => console.log(`anon-feedback listening on port ${port}`));

  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
