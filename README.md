# anon-feedback

A minimal anonymous feedback app. People unlock it with one shared organisation access code and submit free-text feedback. The app stores only the feedback text and the date it was submitted. It stores no names, IP addresses, user agents, timestamps or per-user sessions.

- Node 20+, Express 5, `pg`. Those are the only two runtime dependencies.
- The HTML is rendered on the server. The pages load no external assets. One small self-hosted script (`public/app.js`, served at `/app.js`) clears the form when the browser restores it from the back-forward cache and keeps the thanks page out of history. It makes no network calls, uses no storage and the app works fully without it.
- Postgres 13+

## Setup

```sh
cp .env.example .env        # then fill in the values (see below)
createdb anon_feedback
npm install
npm run migrate             # as the owner: applies sql/*.sql, creates/grants the writer role
npm start                   # as the writer role: http://localhost:$PORT
```

### Database roles

The app connects with a role that can only insert feedback, never read it:

| Variable | Used by | Role |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | `npm run migrate` only | The table owner. It needs `CREATEROLE` the first time, to create the writer role. |
| `WRITER_ROLE` | `npm run migrate` | Name of the writer role. Defaults to `feedback_writer`. |
| `DATABASE_URL` | the running app | Must connect as `WRITER_ROLE` |
| `WRITER_PASSWORD` | `npm run migrate` | Optional. If set, migrate sets the writer role's password on every run. |

`npm run migrate` creates the writer role if it doesn't exist. It gives the role `INSERT (body)` on `submissions` and `USAGE` on its id sequence, and nothing else: no `SELECT`, `UPDATE`, `DELETE` or `TRUNCATE`. That's why the app uses a plain `INSERT` with no `RETURNING`. Migrate refuses a writer role that is a superuser, the table owner, or the user running the migration.

On startup the app checks the catalog with `has_table_privilege`; it never reads `submissions`. If the `DATABASE_URL` role has `SELECT`, `UPDATE`, `DELETE` or `TRUNCATE` on `submissions`, the app does one of two things:
- With `NODE_ENV=production`, it logs one error line and exits with code 1. It also exits if the check can't run at all.
- Otherwise it prints a warning and starts anyway.

#### Setting the writer password

The preferred way, and the one to use in production, is to leave `WRITER_PASSWORD` unset and set the password yourself in `psql`, connected as the owner:

```
\password feedback_writer
```

`psql` hashes the password (SCRAM) on your machine before sending it, so the plain text never reaches the server and never appears in its logs. If you leave `WRITER_PASSWORD` unset, migrate reminds you to do this.

Setting `WRITER_PASSWORD` is convenient for local development. Migrate then runs `ALTER ROLE ... PASSWORD '<literal>'`, so the server receives the password in plain text and would log it if statement logging were on.

### Production notes

- **Use password authentication for the writer role.** In `pg_hba.conf`, the entries that match the writer role must use `scram-sha-256`, never `trust`. Also set `password_encryption = scram-sha-256`.
- **Keep owner credentials off the app server.** `MIGRATION_DATABASE_URL` must not be in the app server's runtime environment. Run migrations from an admin machine or a one-off job, then discard the owner credentials from that environment. The app needs only `DATABASE_URL` (the writer role), `ACCESS_CODE`, `SESSION_SECRET` and `PORT`.
- **Set `NODE_ENV=production`.** The app then exits at startup if its role can read or modify submissions, and the cookie is marked `Secure`.

Generate a `SESSION_SECRET` with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Everyone who unlocks the app gets the same `fb_access` cookie, which is an HMAC of the access code. If you change `ACCESS_CODE` or `SESSION_SECRET`, every existing cookie stops working at once.

## Reading feedback

The app has no admin UI and can't read feedback itself. People who are allowed to read it connect as the owner role and query directly:

```sql
SELECT submitted_on, body FROM submissions ORDER BY submitted_on DESC;
```

## Tests

The tests need their own database. They run `TRUNCATE submissions` before each test, so they refuse to run unless the database name contains `test`. The tests take an owner connection in `MIGRATION_DATABASE_URL`. They apply the migrations with it, then run the app through a separate connection as their own writer role, `feedback_writer_test`. They use their own access code and secret, so `.env` isn't needed. Postgres roles belong to the whole server, so the tests use their own role and never touch `feedback_writer` or its password.

```sh
createdb anon_feedback_test
MIGRATION_DATABASE_URL=postgres://localhost:5432/anon_feedback_test npm test
```

## Docker

```sh
docker build -t anon-feedback .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://feedback_writer:...@db/anon_feedback \
  -e ACCESS_CODE=... -e SESSION_SECRET=... -e PORT=3000 \
  anon-feedback
# Migrations (run as a one-off with owner credentials, never set on the app container).
# Then set the writer password with psql: \password feedback_writer
docker run --rm -e MIGRATION_DATABASE_URL=... anon-feedback node scripts/migrate.js
```

The image sets `NODE_ENV=production`, so the cookie is marked `Secure`. Serve it over HTTPS.

## What the app does and doesn't record

- Database: `submissions(id, submitted_on date, body)`. Nothing else.
- Console output: one startup line, plus error messages and stack traces. Nothing about requests is printed: no request lines, headers or bodies.
- The app ignores client addresses and browser headers. It reads only the cookie to check access.
- Every response carries a strict CSP (`script-src 'self'`, no inline scripts), `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. HTML responses also carry `Cache-Control: no-store`.

### Hosting anonymity checklist
- Reverse proxy (nginx/Caddy/Traefik): disable access logs for this site, or use a log format without client IP and user-agent.
- If behind Cloudflare/CDN/PaaS: check and disable request logging / analytics for this host.
- Postgres: log_statement = none, log_connections = off, track_commit_timestamp = off.
- Container logs: app prints nothing per request; don't add a log shipper that captures proxy logs.
- HTTPS only.
- Restrict DB access to the people who are supposed to read feedback.
- App runs as feedback_writer (INSERT-only). Only the owner role can read submissions — keep its credentials off the app server.
