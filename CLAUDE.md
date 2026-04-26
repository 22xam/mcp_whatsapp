# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript (nest build)
npm run start:dev      # Watch mode with hot reload
node dist/main.js      # Run compiled bot (production-style)
npm run lint           # ESLint
npm test               # Jest unit tests
npm run test:e2e       # End-to-end tests
npm run cli            # Run CLI via ts-node (dev)
```

**After any source change:** always run `npm run build` before `node dist/main.js` — the app runs from `dist/`, not `src/`.

## Architecture

### Runtime flow

1. `src/main.ts` bootstraps NestJS and sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (required on Windows for Node's native fetch to reach Google APIs).
2. `ConfigLoaderService` reads all JSON files from `config/` at startup — `bot.config.json`, `clients.json`, `knowledge.json`, and `.md`/`.txt` files under `config/knowledge-docs/`.
3. `WhatsAppAdapter` launches a Puppeteer/Chromium browser session for WhatsApp Web. Session is persisted in `.wwebjs_auth/`. If Chromium crashes and leaves a lock, delete `.wwebjs_auth/session/SingletonLock`.
4. `BotService` is the main message router. It reads `bot.config.json → mode`:
   - `"flow"` — menu-driven state machine (default)
   - `"ai"` — pure AI mode, skips menu
5. `ConditionalFlowService` handles the modern `conditionalFlows` system (step graph with branching). `BotService` also handles legacy `flows` (linear guided/ai flows).

### Conversation state machine

```
IDLE → AWAITING_MENU_SELECTION → FLOW_ACTIVE | CONDITIONAL_FLOW_ACTIVE → IDLE
                                                                        → ESCALATED
```

State lives in `SessionService` (in-memory, keyed by WhatsApp sender ID). Sessions expire after `sessionTimeoutMinutes` from `bot.config.json`.

### AI provider selection

`AI_PROVIDER` and `EMBEDDING_PROVIDER` tokens are resolved in `AiModule` based on `AI_PROVIDER` env var (`"gemini"`, `"ollama"`, or `"openrouter"`). Both tokens resolve to the same provider instance. The Gemini provider uses `@google/genai` SDK (not the deprecated `@google/generative-ai`). OpenRouter uses its OpenAI-compatible HTTP API.

### Dependency injection tokens

All cross-cutting providers are injected via string tokens (see `src/modules/core/tokens/injection-tokens.ts`): `AI_PROVIDER`, `EMBEDDING_PROVIDER`, `MESSAGE_ADAPTER`, `TICKET_PROVIDER`.

### Knowledge / RAG

`KnowledgeService` runs a two-stage search on every AI query:
1. Keyword match against `knowledge.json` FAQ tags (free, no API call).
2. Vector cosine similarity in SQLite (`data/knowledge.sqlite`) — **only called if vectors are indexed** (guard added to skip embed when table is empty).

Vectors are indexed from `.md`/`.txt` files in `config/knowledge-docs/`. To force re-index: `POST /api/knowledge/rebuild`.

### Configuration

Everything is JSON-driven — no code changes needed for content:

| File | Purpose |
|------|---------|
| `config/bot.config.json` | Bot identity, menu, flows, AI model, escalation keywords |
| `config/clients.json` | Client phone numbers, company, assigned knowledge docs |
| `config/knowledge.json` | FAQ entries with tags for keyword search |
| `config/knowledge-docs/*.md` | Full-text docs indexed as vectors |

`ConfigLoaderService.interpolate()` replaces `{placeholders}` in all config strings. Available variables include `{company}`, `{developerName}`, `{botName}`, `{clientName}`, `{senderPhone}`, `{timestamp}`, `{flowPath}`, and any `saveAs` keys from flow steps.

### REST API

All endpoints are under `/api`. Key ones: `GET /api/status`, `GET /api/clients`, `GET /api/sessions`, `POST /api/pause`, `POST /api/resume`, `POST /api/test/message` (simulate a WhatsApp message without a real phone).

### Control group

Set `CONTROL_GROUP_ID=<id>@g.us` in `.env` to enable bot commands (`!status`, `!paused`, `!sessions`) from a WhatsApp group. Group IDs are printed to the console at startup.

## Key environment variables

| Variable | Notes |
|----------|-------|
| `AI_PROVIDER` | `gemini`, `ollama`, or `openrouter` |
| `GEMINI_API_KEY` | Required only when `AI_PROVIDER=gemini` |
| `OPENROUTER_API_KEY` | Required only when `AI_PROVIDER=openrouter` |
| `OPENROUTER_BASE_URL` | Defaults to `https://openrouter.ai/api/v1` |
| `DEVELOPER_PHONE` | Digits only, international format (e.g. `5493874043810`) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to `0` on Windows to fix Node fetch SSL issues |
| `CONTROL_GROUP_ID` | WhatsApp group ID for bot control commands |

Windows note: system-level env vars override `.env` — check with PowerShell: `[System.Environment]::GetEnvironmentVariable("GEMINI_API_KEY", "User")`.
