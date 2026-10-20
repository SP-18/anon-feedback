# CLAUDE.md

## Database safety

Never run TRUNCATE, DELETE, DROP, or any destructive SQL against a database whose name does not contain 'test'. Never clean up rows in dev or production databases. If a smoke test needs to insert data, use the test database. If unsure, ask.
