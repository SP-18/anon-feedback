import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { checkWriterPrivileges, createApp } from '../src/server.js';
import { createPool } from '../src/db.js';
import { accessToken, COOKIE_NAME } from '../src/auth.js';
import { runMigrations } from '../scripts/migrate.js';

const ACCESS_CODE = 'test-access-code';
const SESSION_SECRET = 'test-session-secret';
const EXPECTED_TOKEN = accessToken(SESSION_SECRET, ACCESS_CODE);
const CSP = "default-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Roles are cluster-wide, so tests use their own writer role and never touch the dev/prod one.
const WRITER_ROLE = 'feedback_writer_test';
const WRITER_PASSWORD = 'test-writer-password';

let ownerPool;
let writerPool;
let app;

before(async () => {
  const url = process.env.MIGRATION_DATABASE_URL;
  assert.ok(url, 'MIGRATION_DATABASE_URL must be an owner connection to a test database');
  // Every test truncates the submissions table, so refuse to run against a non-test database.
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  assert.match(dbName, /test/i, `Refusing to run tests against "${dbName}": database name must contain "test"`);

  ownerPool = createPool(url);
  await runMigrations(ownerPool, { writerRole: WRITER_ROLE, writerPassword: WRITER_PASSWORD });

  const writerUrl = new URL(url);
  writerUrl.username = WRITER_ROLE;
  writerUrl.password = encodeURIComponent(WRITER_PASSWORD);
  writerPool = createPool(writerUrl.href);
  app = createApp({ pool: writerPool, accessCode: ACCESS_CODE, sessionSecret: SESSION_SECRET });
});

beforeEach(async () => {
  await ownerPool.query('TRUNCATE submissions RESTART IDENTITY');
});

after(async () => {
  await writerPool?.end();
  await ownerPool?.end();
});

function accessCookie(res) {
  const header = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return header?.split(';')[0].slice(COOKIE_NAME.length + 1);
}

async function unlock() {
  const res = await request(app).post('/unlock').type('form').send({ code: ACCESS_CODE });
  return `${COOKIE_NAME}=${accessCookie(res)}`;
}

async function rowCount() {
  const { rows } = await ownerPool.query('SELECT count(*)::int AS n FROM submissions');
  return rows[0].n;
}

test('GET / without cookie shows only the access-code gate', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Organisation access code/);
  assert.match(res.text, /action="\/unlock"/);
  assert.doesNotMatch(res.text, /<textarea/);
  assert.doesNotMatch(res.text, /action="\/submit"/);
  const inputs = res.text.match(/<input\b[^>]*>/g) ?? [];
  assert.equal(inputs.length, 1);
  assert.match(inputs[0], /type="password"/);
  assert.doesNotMatch(res.text, /username|type="text"|type="email"/i);
});

test('POST /unlock sets the cookie only for the correct code', async () => {
  const bad = await request(app).post('/unlock').type('form').send({ code: 'wrong' });
  assert.equal(bad.headers['set-cookie'], undefined);
  assert.match(bad.text, /Invalid code/);
  assert.match(bad.text, /type="password"/);

  const empty = await request(app).post('/unlock').type('form').send({});
  assert.equal(empty.headers['set-cookie'], undefined);

  const good = await request(app).post('/unlock').type('form').send({ code: ACCESS_CODE });
  assert.equal(good.status, 303);
  assert.equal(good.headers.location, '/');
  assert.equal(accessCookie(good), EXPECTED_TOKEN);
  const setCookie = good.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=2592000/);
});

test('two separate unlocks produce the identical cookie value', async () => {
  const a = await unlock();
  const b = await unlock();
  assert.equal(a, b);
  assert.equal(a, `${COOKIE_NAME}=${EXPECTED_TOKEN}`);
});

test('POST /submit without a valid cookie redirects and inserts nothing', async () => {
  const res = await request(app).post('/submit').type('form').send({ feedback: 'hello' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');

  const forged = await request(app).post('/submit').set('Cookie', `${COOKIE_NAME}=deadbeef`)
    .type('form').send({ feedback: 'hello' });
  assert.equal(forged.status, 303);
  assert.equal(await rowCount(), 0);
});

test('valid submit stores one trimmed row dated today', async () => {
  const cookie = await unlock();
  const res = await request(app).post('/submit').set('Cookie', cookie)
    .type('form').send({ feedback: '   Great team, more coffee please.  \n' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/thanks');

  const { rows } = await ownerPool.query('SELECT body, submitted_on = current_date AS today FROM submissions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'Great team, more coffee please.');
  assert.equal(rows[0].today, true);

});

test('empty and over-long feedback re-render with an error and insert nothing', async () => {
  const cookie = await unlock();

  const empty = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: '   \n ' });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /class="error"/);

  const long = 'a'.repeat(20001);
  const tooLong = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: long });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.text, /Feedback must be 20,000 characters or fewer\./);
  assert.ok(tooLong.text.includes(long), 'entered text is preserved');

  assert.equal(await rowCount(), 0);

  const max = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: 'b'.repeat(20000) });
  assert.equal(max.status, 303);
  assert.equal(await rowCount(), 1);
});

test('a 20000-char Hindi submission is accepted by the body parser and stored', async () => {
  const cookie = await unlock();
  const hindi = 'क'.repeat(20000);
  const res = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: hindi });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/thanks');
  const { rows } = await ownerPool.query('SELECT body FROM submissions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, hindi);
});

test('textarea maxlength is 20000', async () => {
  const cookie = await unlock();
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.match(res.text, /<textarea[^>]*\smaxlength="20000"/);
});

test('requests over 256kb get the plain error page with no details', async () => {
  const cookie = await unlock();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let res;
  try {
    res = await request(app).post('/submit').set('Cookie', cookie).type('form')
      .send({ feedback: 'z'.repeat(300 * 1024) });
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 413);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /Something went wrong/);
  assert.doesNotMatch(res.text, /zzz|entity|limit|stack/i);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(errors.every((line) => !line.includes('zzz')), 'body content is never logged');
  assert.equal(await rowCount(), 0);
});

test('HTML in feedback is escaped in the validation re-render', async () => {
  const cookie = await unlock();
  const payload = `<script>alert("x")</script><b onclick='y'>&</b>${'a'.repeat(20000)}`;
  const res = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: payload });
  assert.equal(res.status, 400);
  assert.ok(!res.text.includes('<script>alert'));
  assert.ok(!res.text.includes('<b onclick'));
  assert.ok(res.text.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;b onclick=&#39;y&#39;&gt;&amp;&lt;/b&gt;'));
  assert.equal(await rowCount(), 0);
});

test('responses carry security headers and no X-Powered-By', async () => {
  const cookie = await unlock();
  const responses = [
    await request(app).get('/'),
    await request(app).get('/').set('Cookie', cookie),
    await request(app).post('/unlock').type('form').send({ code: 'nope' }),
    await request(app).get('/public/style.css'),
    await request(app).get('/does-not-exist'),
  ];
  for (const res of responses) {
    assert.equal(res.headers['content-security-policy'], CSP);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
    if (/text\/html/.test(res.headers['content-type'])) {
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  }
});

test('submissions table has exactly id, submitted_on, body', async () => {
  const { rows } = await ownerPool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'submissions'
     ORDER BY ordinal_position`,
  );
  assert.deepEqual(rows.map((r) => r.column_name), ['id', 'submitted_on', 'body']);
});

test('pages have no inline scripts, only /app.js, and the gate has no script', async () => {
  const cookie = await unlock();
  const gates = [
    await request(app).get('/'),
    await request(app).post('/unlock').type('form').send({ code: 'nope' }),
  ];
  const pages = [
    ...gates,
    await request(app).get('/').set('Cookie', cookie),
    await request(app).get('/thanks').set('Cookie', cookie),
    await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: '' }),
    await request(app).get('/does-not-exist'),
  ];
  for (const res of gates) {
    assert.doesNotMatch(res.text, /<script/i);
  }
  for (const res of pages) {
    const scripts = res.text.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    assert.equal(scripts.length, (res.text.match(/<script\b/gi) ?? []).length, 'every <script> is closed');
    for (const tag of scripts) {
      assert.equal(tag, '<script src="/app.js" defer></script>');
    }
    assert.doesNotMatch(res.text, /\son[a-z]+=/i, 'no inline event handlers');
    assert.doesNotMatch(res.text, /(src|href)="(https?:)?\/\//i);
    assert.doesNotMatch(res.text, /style=/i);
  }
});

test('valid submit redirects to the thanks page', async () => {
  const cookie = await unlock();
  const res = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: 'Redirect me' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/thanks');
});

test('GET /thanks with cookie shows only the confirmation', async () => {
  const cookie = await unlock();
  await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: 'Secret sauce feedback' });

  const res = await request(app).get('/thanks').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<h1>Thanks — your feedback was submitted\.<\/h1>/);
  assert.match(res.text, /It's stored anonymously\. Nothing links it back to you\./);
  assert.match(res.text, /<a id="submit-another" class="button" href="\/">Submit another<\/a>/);
  assert.doesNotMatch(res.text, /<textarea|<form|<input/);
  assert.doesNotMatch(res.text, /Secret sauce/);
  assert.doesNotMatch(res.text, /logout|log out|sign out/i);
});

test('GET /thanks without cookie redirects to /', async () => {
  const res = await request(app).get('/thanks');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
});

test('GET / after a submit shows an empty form', async () => {
  const cookie = await unlock();
  await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: 'Do not echo me' });

  const res = await request(app).get('/').set('Cookie', cookie);
  assert.match(res.text, /<textarea[^>]*><\/textarea>/);
  assert.doesNotMatch(res.text, /Do not echo me|Thanks/);
});

test('GET /thanks and GET / are not cacheable and carry security headers', async () => {
  const cookie = await unlock();
  for (const path of ['/thanks', '/']) {
    const res = await request(app).get(path).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-security-policy'], CSP);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
});

test('form and thanks pages load /app.js', async () => {
  const cookie = await unlock();
  for (const path of ['/', '/thanks']) {
    const res = await request(app).get(path).set('Cookie', cookie);
    assert.match(res.text, /<script src="\/app\.js" defer><\/script>/);
  }
});

test('GET /app.js is plain same-origin JavaScript with no network or storage access', async () => {
  const res = await request(app).get('/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.equal(res.headers['content-security-policy'], CSP);
  for (const banned of ['fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.cookie', 'sendBeacon',
    'setTimeout', 'setInterval', 'WebSocket', 'import(']) {
    assert.ok(!res.text.includes(banned), `app.js must not contain ${banned}`);
  }
});

test('CSP allows only same-origin scripts', async () => {
  const res = await request(app).get('/');
  const csp = res.headers['content-security-policy'];
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.includes('unsafe-inline'));
  assert.ok(!csp.includes('unsafe-eval'));
});

test('form page has #feedback-form and thanks page has #submit-another linking to /', async () => {
  const cookie = await unlock();
  const form = await request(app).get('/').set('Cookie', cookie);
  assert.match(form.text, /<form id="feedback-form" method="post" action="\/submit"/);
  const thanks = await request(app).get('/thanks').set('Cookie', cookie);
  assert.match(thanks.text, /<a id="submit-another"[^>]*href="\/"/);
});

async function assertPermissionDenied(sql) {
  await assert.rejects(writerPool.query(sql), (err) => {
    assert.equal(err.code, '42501', `expected insufficient_privilege for: ${sql}`);
    return true;
  });
}

test('the app connects as the test writer role', async () => {
  const { rows } = await writerPool.query('SELECT current_user AS u');
  assert.equal(rows[0].u, WRITER_ROLE);
});

test('the writer role cannot read submissions', async () => {
  await ownerPool.query("INSERT INTO submissions (body) VALUES ('owner-only')");
  await assertPermissionDenied('SELECT * FROM submissions');
  await assertPermissionDenied('SELECT body FROM submissions');
  await assertPermissionDenied('SELECT count(*) FROM submissions');
  await assertPermissionDenied("INSERT INTO submissions (body) VALUES ('x') RETURNING id");
});

test('the writer role cannot update, delete or truncate submissions', async () => {
  await ownerPool.query("INSERT INTO submissions (body) VALUES ('keep me')");
  await assertPermissionDenied("UPDATE submissions SET body = 'changed'");
  await assertPermissionDenied('DELETE FROM submissions');
  await assertPermissionDenied('TRUNCATE submissions');
  await assertPermissionDenied("INSERT INTO submissions (id, body) OVERRIDING SYSTEM VALUE VALUES (999, 'x')");
  await assertPermissionDenied("INSERT INTO submissions (submitted_on, body) VALUES ('2000-01-01', 'x')");
  const { rows } = await ownerPool.query('SELECT body FROM submissions');
  assert.deepEqual(rows, [{ body: 'keep me' }]);
});

test('POST /submit inserts via the writer role (verified with the owner connection)', async () => {
  const cookie = await unlock();
  const res = await request(app).post('/submit').set('Cookie', cookie).type('form').send({ feedback: 'written by the writer' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/thanks');
  const { rows } = await ownerPool.query('SELECT id, body, submitted_on = current_date AS today FROM submissions');
  assert.deepEqual(rows, [{ id: '1', body: 'written by the writer', today: true }]);
});

test('startup check fails closed in production when the app role can read or modify submissions', async () => {
  await assert.rejects(checkWriterPrivileges(ownerPool, { production: true }),
    /has SELECT, UPDATE, DELETE, TRUNCATE on submissions/);
});

test('startup check only warns outside production', async () => {
  const warnings = [];
  await checkWriterPrivileges(ownerPool, { production: false, warn: (msg) => warnings.push(msg) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Warning: .*SELECT/);
});

test('startup check passes for the INSERT-only writer role in production', async () => {
  const warnings = [];
  await checkWriterPrivileges(writerPool, { production: true, warn: (msg) => warnings.push(msg) });
  assert.deepEqual(warnings, []);
});

test('migrations refuse to use the owner as the writer role', async () => {
  const { rows: [{ me }] } = await ownerPool.query('SELECT current_user AS me');
  await assert.rejects(runMigrations(ownerPool, { writerRole: me }), /must be a separate role/);
});
