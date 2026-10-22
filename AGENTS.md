# sms-worker

Cloudflare Worker that sends SMS for registered apps through BulkSMSBD and MiMSMS, with an admin UI.
README.md covers setup and the HTTP API. CONTEXT.md is the glossary: use its terms in code, API
fields and UI labels. docs/adr/ records design decisions; read the relevant ADR before changing
auth caching, provider credentials, or send rounds.

## Commands
- `npm run typecheck` and `npm run typecheck:test`: type-check the app and the tests
- `npm test`: vitest (the Git deploy build runs `npm run typecheck && npm test`)
- After editing `src/db/schema.ts`: `npm run db:generate`, then `npm run db:migrate:local`
- After changing bindings in `wrangler.jsonc`: `npm run types`

## Rules
Do not write tests unless asked.
Don't run `npm run deploy` or `npm run db:migrate:remote`; both change production.
