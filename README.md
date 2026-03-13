# 🤖 Bug-Mate

**Bug-Mate** is an open-source AI-powered WhatsApp support bot built for software factories. It automates technical support by answering questions, collecting bug reports, and escalating issues to a developer — all through WhatsApp.

Built with [NestJS](https://nestjs.com/), [whatsapp-web.js](https://wwebjs.dev/), and Google's Gemini API.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Bot Behavior (bot.config.json)](#bot-behavior-botconfigjson)
  - [Client Database (clients.json)](#client-database-clientsjson)
  - [FAQ Knowledge Base (knowledge.json)](#faq-knowledge-base-knowledgejson)
  - [Knowledge Documents](#knowledge-documents)
- [Running the Bot](#running-the-bot)
- [Docker Deployment](#docker-deployment)
- [Architecture Overview](#architecture-overview)
- [Extension Points](#extension-points)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **WhatsApp Integration** — Fully functional WhatsApp client using QR code authentication
- **AI-Powered Responses** — Uses Google Gemini to generate natural language answers
- **Semantic Search (RAG)** — Indexes your documentation as vector embeddings in SQLite for context-aware responses
- **Multi-Step Conversation Flows** — Stateful flows for bug reporting and knowledge querying
- **Bug Reporting** — Collects error descriptions and screenshots, then notifies the developer via WhatsApp
- **Smart Escalation** — Detects configurable keywords and routes the conversation to a human developer
- **Session Management** — Per-user conversation state with automatic timeout and cleanup
- **Client Personalization** — Greet clients by name by adding them to the client database
- **Pluggable AI Providers** — Switch between Gemini (cloud) and Ollama (local/offline) with zero code changes
- **Fully Configurable** — All bot behavior, prompts, menus, and flows are defined in JSON files — no code changes needed

---

## How It Works

When a client sends a WhatsApp message, Bug-Mate:

1. Greets them by name (if registered in `clients.json`)
2. Shows a main menu with options:
   - 🐛 Report an error
   - ❓ Ask a question
   - 👨‍💻 Speak with a developer
3. Depending on their choice:
   - **Report Error** → Asks for a description and optional screenshot → Sends a structured report to the developer
   - **Ask a Question** → Searches the FAQ and documentation → Generates an AI-powered contextual answer
   - **Escalate** → Detects urgent keywords or the user's explicit request → Notifies the developer immediately
4. Sessions expire after a configurable timeout (default: 30 minutes), resetting the conversation automatically

```
User sends message
        │
        ▼
WhatsApp Adapter (whatsapp-web.js)
        │
        ▼
Bot Service (conversation state machine)
   ├── IDLE ──────────────────────► Greet + show menu
   ├── AWAITING_MENU_SELECTION ───► Parse choice / detect escalation keywords
   ├── FLOW_REPORT_ERROR ─────────► Collect description & screenshot ──► notify developer
   ├── FLOW_QUERY_KNOWLEDGE ──────► Search knowledge base + generate AI answer
   └── ESCALATED ─────────────────► Acknowledge + notify developer
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| WhatsApp | whatsapp-web.js 1.34.6 |
| AI / LLM | Google Gemini 2.0 Flash |
| Embeddings | Gemini Embedding 001 |
| Local AI (optional) | Ollama (qwen3:8b or any compatible model) |
| Database | SQLite via better-sqlite3 |
| Runtime | Node.js 22 LTS |
| Containerization | Docker + Docker Compose |

---

## Project Structure

```
bug-mate/
├── src/
│   ├── main.ts                        # NestJS bootstrap
│   ├── app.module.ts                  # Root module
│   └── modules/
│       ├── ai/                        # AI provider abstraction
│       │   └── providers/
│       │       ├── gemini.provider.ts # Google Gemini (cloud)
│       │       └── ollama.provider.ts # Ollama (local/offline)
│       ├── bot/                       # Core conversation logic
│       │   └── bot.service.ts         # State machine & flows
│       ├── config/                    # Config loading (env + JSON files)
│       ├── core/                      # Interfaces & injection tokens
│       ├── knowledge/                 # FAQ keyword match + vector search
│       ├── messaging/                 # WhatsApp adapter (message I/O)
│       └── session/                   # Per-user in-memory session state
├── config/
│   ├── bot.config.json                # All bot behavior, prompts & flows
│   ├── clients.json                   # Client phone/name/company database
│   ├── knowledge.json                 # FAQ entries
│   └── knowledge-docs/                # .md / .txt files for RAG (vector search)
│       ├── preguntas-frecuentes.md    # Example: FAQ document
│       └── sistema-general.md         # Example: system documentation
├── data/                              # SQLite vector database (auto-created)
├── .wwebjs_auth/                      # WhatsApp session cache (auto-created)
├── .env.example                       # Environment variable template
├── Dockerfile
└── docker-compose.yml
```

---

## Prerequisites

- **Node.js 22+** — [Download here](https://nodejs.org/)
- **npm** (included with Node.js)
- **Google Gemini API Key** — [Get one for free at Google AI Studio](https://aistudio.google.com/app/apikey)
- **A WhatsApp account** to run as the bot (a second/dedicated number is recommended)

> **Optional:** [Ollama](https://ollama.com/) if you want to run the AI fully locally without any cloud API key.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/bug-mate.git
cd bug-mate
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values. At minimum you need:

```env
GEMINI_API_KEY=your_google_gemini_api_key
DEVELOPER_PHONE=5491123456789        # International format, digits only, no + or spaces
DEVELOPER_NAME=John
```

See [Environment Variables](#environment-variables) for the full list.

### 4. Configure the bot

Edit the files inside the `/config/` folder to customize the bot's behavior, clients, and knowledge base. See [Configuration](#configuration) for details.

### 5. Start the bot

```bash
npm run start
```

### 6. Scan the QR code

On first run, a QR code will appear in the terminal. Open WhatsApp on your phone:

**Settings → Linked Devices → Link a Device → Scan the QR code**

The session is saved to `.wwebjs_auth/` automatically and reused on all subsequent runs, so you only need to do this once.

---

## Configuration

Bug-Mate is designed to be configured entirely through files — no code changes are needed for most use cases.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes* | — | Google Gemini API key from [AI Studio](https://aistudio.google.com/) |
| `DEVELOPER_PHONE` | Yes | — | Developer's WhatsApp number (international format, digits only, e.g. `5491123456789`) |
| `DEVELOPER_NAME` | No | `Developer` | Developer's display name used in notifications |
| `BOT_NAME` | No | `Bug-Mate` | Bot's display name |
| `BOT_SYSTEM_PROMPT` | No | — | Override the default AI system prompt |
| `ESCALATION_KEYWORDS` | No | — | Comma-separated keywords that trigger escalation (e.g. `urgent,critical,broken`) |
| `PORT` | No | `3000` | HTTP server port |
| `OLLAMA_URL` | No | `http://localhost:11434` | Ollama server URL (if using local AI) |
| `OLLAMA_MODEL` | No | `qwen3:8b` | Ollama model name |
| `OLLAMA_AUTO_START` | No | `false` | Auto-spawn the Ollama process on startup |

> \*Required when using Gemini (the default provider). Not required if you switch to Ollama.

---

### Bot Behavior (bot.config.json)

`config/bot.config.json` is the main configuration file. It controls everything about how the bot behaves: identity, greeting messages, menu options, conversation flows, AI settings, and escalation rules.

```jsonc
{
  "identity": {
    "botName": "Bug-Mate",
    "company": "Acme Software",
    "developer": {
      "name": "John",
      "phone": "5491123456789"
    }
  },
  "greeting": {
    "welcomeMessage": "Hello {{clientName}}! I'm Bug-Mate, your support assistant. How can I help you today?",
    "sessionTimeoutMinutes": 30
  },
  "menu": {
    "options": [
      { "key": "1", "label": "🐛 Report an error", "action": "FLOW_REPORT_ERROR" },
      { "key": "2", "label": "❓ Ask a question",  "action": "FLOW_QUERY_KNOWLEDGE" },
      { "key": "3", "label": "👨‍💻 Talk to a developer", "action": "ESCALATED" }
    ]
  },
  "ai": {
    "provider": "gemini",
    "model": "gemini-2.0-flash",
    "systemPrompt": "You are a helpful technical support assistant for Acme Software..."
  },
  "escalation": {
    "keywords": ["urgent", "critical", "broken", "emergency", "not working"]
  }
}
```

> **Tip:** Placeholders like `{{clientName}}` and `{{botName}}` are automatically replaced with real values at runtime.

---

### Client Database (clients.json)

Add your customers so the bot can greet them by name and know which systems they use:

```json
[
  {
    "phone": "5491123456789",
    "name": "Alice",
    "company": "Widgets Inc.",
    "systems": ["billing-app", "inventory-manager"]
  },
  {
    "phone": "5499876543210",
    "name": "Bob",
    "company": "Bob's Bakery",
    "systems": ["pos-system"]
  }
]
```

If a phone number isn't in this file, the bot still works — it just falls back to a generic greeting.

---

### FAQ Knowledge Base (knowledge.json)

Add frequently asked questions. The bot will match these against user queries using keyword and tag matching:

```json
[
  {
    "id": "faq-login",
    "tags": ["login", "password", "access", "can't log in", "forgot password"],
    "question": "How do I reset my password?",
    "answer": "You can reset your password from the login screen. Click 'Forgot Password', enter your email, and follow the instructions sent to your inbox.",
    "steps": [
      "Go to the login page",
      "Click 'Forgot Password'",
      "Enter your registered email address",
      "Check your inbox and follow the reset link"
    ]
  }
]
```

---

### Knowledge Documents

Drop any `.md` or `.txt` files into `config/knowledge-docs/`. They are automatically indexed into the SQLite vector database on startup and used as context for AI responses.

This is great for:
- Product documentation
- How-to guides and tutorials
- Release notes and changelogs
- Internal technical wikis

**How it works:** When a user asks a question, the bot computes a semantic embedding of the query and finds the most relevant chunks from your documents using cosine similarity. The top matching chunks are injected as context into the AI prompt, so the bot answers based on **your actual documentation** rather than generic knowledge.

---

## Running the Bot

### Development (hot reload)

```bash
npm run start:dev
```

### Production

```bash
npm run build
npm run start:prod
```

### Debug mode

```bash
npm run start:debug
```

### Tests

```bash
npm run test          # Unit tests
npm run test:watch    # Watch mode
npm run test:cov      # Coverage report
npm run test:e2e      # End-to-end tests
```

### Code quality

```bash
npm run lint          # ESLint with auto-fix
npm run format        # Prettier formatting
```

---

## Docker Deployment

The easiest way to run Bug-Mate in production is with Docker Compose. Everything (Node.js, Chromium for WhatsApp, and optionally Ollama) runs in containers.

### 1. Configure your `.env` file

Make sure your `.env` is filled in with real values before building.

### 2. Build and start

```bash
docker-compose up --build
```

This starts two services:
- **ollama** — local Ollama AI server (used if `OLLAMA_AUTO_START=true` or you switch the AI provider)
- **bugmate** — the NestJS application

### 3. Scan the QR code on first run

```bash
docker-compose logs -f bugmate
```

Watch the logs for the QR code, then scan it with WhatsApp. The session is saved to `./wwebjs_auth/` (a mounted volume) so you only need to do this once.

### Stop

```bash
docker-compose down
```

---

## Architecture Overview

Bug-Mate uses a **modular NestJS architecture** with clean separation of concerns. Each module handles one responsibility and they communicate through NestJS's dependency injection system.

```
AppModule
├── AppConfigModule    → Loads .env variables and JSON config files
├── CoreModule         → Shared interfaces, injection tokens, Ollama process manager
├── AiModule           → AI provider abstraction layer (Gemini / Ollama)
├── SessionModule      → In-memory per-user conversation state with auto-cleanup
├── KnowledgeModule    → Two-tier search: FAQ keyword matching + semantic vector search
├── BotModule          → Conversation state machine, flow orchestration
└── MessagingModule    → WhatsApp adapter (receives and sends messages)
```

### Conversation State Machine

Each user session moves through these states:

```
IDLE
 └─(first message)──────────► AWAITING_MENU_SELECTION
                                    ├─(option 1)──► FLOW_REPORT_ERROR ──► IDLE
                                    ├─(option 2)──► FLOW_QUERY_KNOWLEDGE ──► IDLE
                                    └─(option 3 or escalation keyword)──► ESCALATED
```

Sessions auto-expire after the configured timeout. A background task cleans up stale sessions every 5 minutes.

### Vector Search (RAG)

When a user asks a question, the knowledge service runs a two-tier search:

1. **Keyword/tag match** — fast and free, scans FAQ entries for matching tags and questions
2. **Semantic vector search** — generates a Gemini embedding for the query, then computes cosine similarity against all stored document embeddings in SQLite
3. Top-K results (default: 3) with a minimum similarity score (default: 0.72) are selected
4. The matched content is injected into the Gemini prompt as context (RAG)

This means the bot answers questions grounded in **your actual product documentation**.

---

## Extension Points

Bug-Mate is built to be extended without modifying core logic:

| What to extend | How |
|---|---|
| Add a new AI provider | Implement the `AIProvider` interface in `src/modules/ai/providers/` |
| Add a new messaging platform | Implement the `MessageAdapter` interface in `src/modules/messaging/adapters/` |
| Add a new conversation flow | Add a new state and handler in `BotService` |
| Add knowledge content | Drop `.md` or `.txt` files in `config/knowledge-docs/` |
| Add or update clients | Edit `config/clients.json` |
| Customize all prompts and messages | Edit `config/bot.config.json` |

---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork this repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests if applicable
4. Run `npm run test` and `npm run lint` to verify everything passes
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: add my feature"`
6. Push and open a Pull Request

---

## License

This project is open-source and available under the [MIT License](LICENSE).

---

> Built for software factories that want smarter, automated support — without leaving WhatsApp.
