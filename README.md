<p align="center">
  <img src="https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white"/>
  <img src="https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white"/>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white"/>
</p>

<h1 align="center">BugMate 🤖</h1>
<p align="center">WhatsApp AI support bot — fully configurable via JSON, no code changes needed.</p>

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Environment Variables](#environment-variables)
3. [AI Providers](#ai-providers)
4. [Bot Configuration (bot.config.json)](#bot-configuration)
   - [identity](#identity)
   - [greeting](#greeting)
   - [menu](#menu)
   - [Conditional Flows](#conditional-flows)
   - [Legacy Flows](#legacy-flows)
   - [AI Settings](#ai-settings)
   - [humanDelay](#humandelay)
   - [media](#media)
   - [escalation](#escalation)
5. [Conditional Flow DSL — Complete Reference](#conditional-flow-dsl)
   - [Step types](#step-types)
   - [System variables](#system-variables)
   - [Actions](#actions)
   - [Full example](#full-example)
6. [Clients (clients.json)](#clients)
7. [Knowledge Base](#knowledge-base)
   - [FAQ (knowledge.json)](#faq)
   - [Documents (knowledge-docs/)](#documents)
   - [Per-client knowledge filtering](#per-client-knowledge-filtering)
8. [Control Group Commands](#control-group-commands)
9. [Human Takeover](#human-takeover)
10. [Designing Your Own Bot](#designing-your-own-bot)
11. [File Structure](#file-structure)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/bug-mate.git
cd bug-mate
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your settings

# 3. Run
npm run start:dev
# Scan the QR code with WhatsApp
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
# ── AI Provider ────────────────────────────────────────────
# Which AI provider to use: "gemini" or "ollama"
AI_PROVIDER=gemini

# ── Gemini (Google) ────────────────────────────────────────
# Get your free key at https://aistudio.google.com/app/apikey
GEMINI_API_KEY=your_key_here

# ── Ollama (local/open source) ─────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_AUTO_START=false

# ── Developer Contact ──────────────────────────────────────
# Your WhatsApp number (digits only, no + or spaces)
# Argentina (+54): 5491123456789
DEVELOPER_PHONE=5491123456789

# ── Control Group (optional) ───────────────────────────────
# WhatsApp group ID for sending admin commands to the bot.
# Run !grupos from any group to discover your group IDs.
# CONTROL_GROUP_ID=120363XXXXXXXXXX@g.us

# ── App ────────────────────────────────────────────────────
PORT=3000
```

---

## AI Providers

### Gemini (Google) — default

- Set `AI_PROVIDER=gemini` and `GEMINI_API_KEY=...`
- Default model: `gemini-2.0-flash`
- Embedding model: `text-embedding-004`
- Free tier available at [aistudio.google.com](https://aistudio.google.com)

### Ollama (local, open source)

- Set `AI_PROVIDER=ollama`
- Install Ollama: [ollama.ai](https://ollama.ai)
- Pull the models:
  ```bash
  ollama pull qwen3:8b          # chat model
  ollama pull nomic-embed-text  # embedding model (required for knowledge base)
  ```
- Configure models in `bot.config.json`:
  ```json
  "ai": {
    "model": "qwen3:8b",
    "embeddingModel": "nomic-embed-text"
  }
  ```

| | Gemini | Ollama |
|---|---|---|
| Cost | Free tier (limited) | Free (runs locally) |
| Privacy | Cloud (Google) | 100% local |
| Speed | Fast | Depends on hardware |
| Quality | High | Depends on model |
| Internet required | Yes | No |

---

## Bot Configuration

All bot behavior is configured in `config/bot.config.json`. **No code changes are needed** — swap the JSON to deploy a completely different bot.

### identity

```json
"identity": {
  "name": "BugMate",
  "company": "Your Company",
  "developerName": "Nacho",
  "tone": "amigable, empático, profesional y conciso."
}
```

| Field | Description |
|---|---|
| `name` | Bot name shown in messages |
| `company` | Company name used in templates |
| `developerName` | Developer name shown in escalation messages |
| `tone` | Tone instruction injected into the AI system prompt |

### greeting

```json
"greeting": {
  "enabled": true,
  "message": "¡Hola {clientName}! Soy *{botName}* de *{company}*.",
  "unknownClientName": "👋",
  "sessionTimeoutMinutes": 30
}
```

- `{clientName}` → resolved from `clients.json` by phone number, or `unknownClientName` if not found
- `sessionTimeoutMinutes` → inactivity timeout before the session resets and the greeting is sent again

### menu

The top-level menu shown after the greeting.

```json
"menu": {
  "message": "Elegí una opción respondiendo con el número:",
  "invalidChoiceMessage": "No entendí tu respuesta.",
  "unrecognizedOptionMessage": "Opción no reconocida.",
  "options": [
    { "id": "1", "label": "Soy cliente", "conditionalFlowId": "clientFlow" },
    { "id": "2", "label": "Tengo una consulta", "conditionalFlowId": "prospectFlow" },
    { "id": "3", "label": "Contactar atención", "action": "ESCALATE" }
  ]
}
```

Each option can use one of three routing mechanisms:

| Field | Type | Description |
|---|---|---|
| `action` | `"ESCALATE"` \| `"SHOW_MENU"` | Built-in action, no flow needed |
| `conditionalFlowId` | string | ID of a conditional flow in the `conditionalFlows` map |
| `conditionalFlowStartStep` | string | Override the flow's default `startStep` (optional) |
| `flowId` | string | ID of a legacy flow in the `flows` map |

**Minimal bot — no menus:** Set `"options": []` and the bot will only greet and wait. The developer can handle the conversation manually via human takeover.

---

## Conditional Flows

The conditional flow system is the recommended way to build complex, branching conversations. It uses a **named-step graph** — each step has an ID and declares where to go next.

```json
"conditionalFlows": {
  "myFlow": {
    "startStep": "firstStep",
    "steps": {
      "firstStep": { ... },
      "secondStep": { ... }
    }
  }
}
```

Flows are triggered from a menu option:

```json
{ "id": "1", "label": "Soy cliente", "conditionalFlowId": "clientFlow" }
```

---

## Conditional Flow DSL

### Step Types

#### `input` — Collect user text

Sends a prompt and waits for the user's response. The response is saved in `flowData`.

```json
{
  "type": "input",
  "prompt": "¿Cuál es tu consulta?",
  "saveAs": "userQuery",
  "acceptMedia": false,
  "mediaFallback": "[archivo adjunto]",
  "nextStep": "nextStepId"
}
```

| Field | Required | Description |
|---|---|---|
| `prompt` | ✅ | Text sent to user. Supports `{variable}` interpolation. |
| `saveAs` | ✅ | `flowData` key where the response is stored |
| `acceptMedia` | ❌ | Whether to accept images/audio (default: false) |
| `mediaFallback` | ❌ | Text stored when media is received instead of text |
| `nextStep` | ✅ | Next step ID or `"END"` |

---

#### `menu` — Present numbered options

Shows a numbered list and routes based on user choice.

```json
{
  "type": "menu",
  "message": "¿En qué te puedo ayudar?",
  "options": [
    { "id": "1", "label": "Reportar error", "nextStep": "askDescription" },
    { "id": "2", "label": "Hablar con desarrollo", "action": "ESCALATE", "notification": "..." }
  ],
  "invalidMessage": "Por favor elegí una opción válida."
}
```

Each option can have:

| Field | Description |
|---|---|
| `id` | Number/text the user types to select this option |
| `label` | Text shown in the menu |
| `nextStep` | Step to navigate to |
| `action` | Terminal action (`ESCALATE`, `END`, `SHOW_MENU`, `NOTIFY_DEVELOPER`) |
| `notification` | Developer notification template (used with `ESCALATE` or `NOTIFY_DEVELOPER`) |

---

#### `validate` — Match input against a data source

Checks a previously collected variable against a data source. Routes to `onMatch` or `onNoMatch` depending on the result.

Currently supported data source: `"clients"` (from `clients.json`).

Matching is fuzzy: case-insensitive, strips legal suffixes (S.A., S.R.L., etc.), checks both `name` and `company` fields. Also matches by exact phone number.

```json
{
  "type": "validate",
  "dataSource": "clients",
  "inputVar": "clientInput",
  "onMatch": {
    "saveAs": "matchedClient",
    "nextStep": "clientMenu"
  },
  "onNoMatch": {
    "message": "No encontré tu empresa. Voy a notificar a {developerName}.",
    "action": "ESCALATE",
    "notification": "⚠️ Empresa no encontrada: {clientInput} — {senderPhone}"
  }
}
```

When a match is found, the full client record is saved as an object under `saveAs`. You can then use `{matchedClient.name}`, `{matchedClient.company}`, `{matchedClient.phone}`, etc. in any subsequent template.

---

#### `message` — Send a static message + optional action

Sends a message and optionally triggers a side-effect (notify developer, escalate, end flow).

```json
{
  "type": "message",
  "text": "✅ Reporte registrado. Gracias! 🙏",
  "action": "NOTIFY_DEVELOPER",
  "notification": "🐛 Error de {matchedClient.name}: {errorDescription}",
  "nextStep": "END"
}
```

| Field | Required | Description |
|---|---|---|
| `text` | ✅ | Message sent to user. Supports `{variable}` interpolation. |
| `action` | ❌ | Side-effect triggered after message |
| `notification` | ❌ | Developer notification template |
| `nextStep` | ✅ | Next step ID or `"END"` |

---

#### `ai` — AI-powered response with optional RAG

Sends an input prompt, then processes the user's query with the AI provider, optionally searching the knowledge base first.

```json
{
  "type": "ai",
  "inputPrompt": "Contame tu consulta:",
  "textOnlyMessage": "Por favor escribí tu consulta con texto.",
  "useKnowledge": true,
  "systemPromptOverride": "Sos un asistente de soporte de {company}...",
  "ragContextInstruction": "Respondé de forma natural y conversacional.",
  "fallbackToEscalation": true,
  "noResultMessage": "No encontré información. Voy a notificar a {developerName}.",
  "noResultNotification": "❓ Consulta sin respuesta: {userQuery}",
  "continuePrompt": "¿Hay algo más en lo que pueda ayudarte?",
  "saveQueryAs": "userQuery",
  "nextStep": "END"
}
```

| Field | Description |
|---|---|
| `useKnowledge` | Search the knowledge base before calling the AI |
| `systemPromptOverride` | Custom system prompt for this step only |
| `ragContextInstruction` | Additional instruction appended to the system prompt when a knowledge result is found |
| `fallbackToEscalation` | Escalate to developer when no knowledge result found (overrides global setting) |
| `noResultMessage` | Message sent to user when no knowledge result found |
| `noResultNotification` | Developer notification when no knowledge result found |
| `saveQueryAs` | `flowData` key where the user's query is stored (default: `userQuery`) |
| `continuePrompt` | Message sent after a successful AI response inviting further interaction |

> **Note:** If the matched client has no `knowledgeDocs` configured in `clients.json`, the knowledge search is skipped entirely and the step falls through to escalation. This prevents clients from accessing other clients' documentation.

---

### System Variables

These variables are always available in any template (`{variable}` syntax):

| Variable | Value |
|---|---|
| `{senderPhone}` | User's phone number (digits only, no suffix) |
| `{clientName}` | Client name from `clients.json`, or the `unknownClientName` emoji |
| `{timestamp}` | Current date/time (Argentina timezone) |
| `{flowPath}` | Breadcrumb of steps visited, e.g. `askClientName → validateClient → clientMenu` |
| `{developerName}` | From `identity.developerName` |
| `{company}` | From `identity.company` |
| `{botName}` | From `identity.name` |

Plus any variable collected via `saveAs` in `input` steps, and dot-notation access to objects from `validate` steps (e.g. `{matchedClient.name}`, `{matchedClient.company}`).

---

### Actions

| Action | Description |
|---|---|
| `END` | Finish the flow, return session to IDLE |
| `ESCALATE` | Send `escalation.clientMessage` to user + `notification` to developer. Bot stops responding (state: ESCALATED) |
| `NOTIFY_DEVELOPER` | Send `notification` to developer, continue the flow normally |
| `SHOW_MENU` | Finish the flow and show the top-level menu again |

---

### Full Example — Client support flow with validation

```json
"conditionalFlows": {
  "clientFlow": {
    "startStep": "askClientName",
    "steps": {

      "askClientName": {
        "type": "input",
        "prompt": "Ingresá tu nombre o empresa para verificar tu cuenta:",
        "saveAs": "clientInput",
        "nextStep": "validateClient"
      },

      "validateClient": {
        "type": "validate",
        "dataSource": "clients",
        "inputVar": "clientInput",
        "onMatch": {
          "saveAs": "matchedClient",
          "nextStep": "clientMenu"
        },
        "onNoMatch": {
          "message": "No encontré tu empresa. Voy a notificar a {developerName}.",
          "action": "ESCALATE",
          "notification": "⚠️ Empresa no encontrada\n\nTeléfono: {senderPhone}\nIngresó: {clientInput}\nHora: {timestamp}"
        }
      },

      "clientMenu": {
        "type": "menu",
        "message": "¡Hola {matchedClient.name}! ¿En qué te ayudo?",
        "options": [
          { "id": "1", "label": "Reportar error", "nextStep": "askError" },
          { "id": "2", "label": "Consulta técnica", "nextStep": "aiQuery" },
          { "id": "3", "label": "Hablar con desarrollo", "action": "ESCALATE",
            "notification": "👨‍💻 Solicitud de {matchedClient.name} ({matchedClient.company}) — {senderPhone}" }
        ],
        "invalidMessage": "Elegí una opción del 1 al 3."
      },

      "askError": {
        "type": "input",
        "prompt": "Describí el error:",
        "saveAs": "errorDescription",
        "nextStep": "askScreenshot"
      },

      "askScreenshot": {
        "type": "input",
        "prompt": "¿Captura de pantalla? Sino escribí *no tengo*.",
        "saveAs": "errorScreenshot",
        "acceptMedia": true,
        "mediaFallback": "[imagen adjunta]",
        "nextStep": "confirmError"
      },

      "confirmError": {
        "type": "message",
        "text": "✅ Reporte registrado. Te contactamos a la brevedad. 🙏",
        "action": "NOTIFY_DEVELOPER",
        "notification": "🐛 Error de {matchedClient.name} ({matchedClient.company})\nTeléfono: {senderPhone}\nDescripción: {errorDescription}\nCaptura: {errorScreenshot}\nHora: {timestamp}\nRuta: {flowPath}",
        "nextStep": "END"
      },

      "aiQuery": {
        "type": "ai",
        "inputPrompt": "Contame tu consulta:",
        "textOnlyMessage": "Por favor escribí tu consulta con texto.",
        "useKnowledge": true,
        "fallbackToEscalation": true,
        "noResultMessage": "No encontré información. Voy a notificar a {developerName}.",
        "noResultNotification": "❓ Consulta sin respuesta\nCliente: {matchedClient.name}\nConsulta: {userQuery}",
        "continuePrompt": "¿Algo más en lo que pueda ayudarte?",
        "nextStep": "END"
      }
    }
  }
}
```

---

## Legacy Flows

The original flow system is still fully supported. Good for simple, straightforward use cases.

### Guided flow — sequential Q&A

Asks questions one by one, collects answers, then notifies the developer.

```json
"flows": {
  "reportError": {
    "type": "guided",
    "steps": [
      { "key": "description", "prompt": "Describí el error:" },
      { "key": "screenshot", "prompt": "¿Captura de pantalla?" }
    ],
    "noMediaFallback": "No adjuntó captura",
    "confirmationMessage": "Reporte registrado. Gracias! 🙏",
    "developerNotification": "🐛 Error de {clientName} ({clientPhone})\n{description}\n{screenshot}"
  }
}
```

### AI flow — single AI-powered response

```json
"flows": {
  "queryKnowledge": {
    "type": "ai",
    "inputPrompt": "Contame tu consulta:",
    "textOnlyMessage": "Por favor escribí tu consulta con texto.",
    "useKnowledge": true,
    "fallbackToEscalation": true,
    "noResultMessage": "No encontré información. Notifico a {developerName}.",
    "noResultDeveloperNotification": "❓ Sin respuesta: {query} — {clientPhone}",
    "continuePrompt": "¿Algo más?"
  }
}
```

---

## AI Settings

```json
"ai": {
  "model": "gemini-2.0-flash",
  "embeddingModel": "text-embedding-004",
  "systemPrompt": "Sos BugMate, asistente de soporte de {company}...",
  "ragMinScore": 0.72,
  "ragTopK": 3,
  "fallbackToEscalation": true,
  "maxHistoryMessages": 10
}
```

| Field | Description |
|---|---|
| `model` | Chat model name (provider-specific) |
| `embeddingModel` | Embedding model for vector search |
| `systemPrompt` | Global system prompt. Supports `{company}`, `{developerName}`, `{botName}`, `{tone}` |
| `ragMinScore` | Minimum cosine similarity score (0–1) to accept a knowledge result |
| `ragTopK` | Number of top knowledge chunks to retrieve |
| `fallbackToEscalation` | Global default: escalate when AI has no knowledge result |
| `maxHistoryMessages` | Number of message pairs kept in conversation history for AI context |

---

## humanDelay

Simulates realistic human typing behavior.

```json
"humanDelay": {
  "enabled": true,
  "readingDelayMinMs": 1000,
  "readingDelayMaxMs": 3500,
  "minDelayMs": 2000,
  "maxDelayMs": 12000,
  "msPerCharacter": 55
}
```

| Field | Description |
|---|---|
| `enabled` | Enable/disable all delays |
| `readingDelayMinMs` / `readingDelayMaxMs` | Random delay before typing starts (simulates reading) |
| `minDelayMs` / `maxDelayMs` | Clamp range for typing delay |
| `msPerCharacter` | Typing speed — multiplied by response length |

---

## media

```json
"media": {
  "processImages": true,
  "processAudio": true,
  "imagePrompt": "Analizá esta imagen...",
  "audioPrompt": "Transcribí exactamente el audio en español.",
  "unsupportedMessage": "Recibí tu {mediaType}, pero no puedo procesarlo. ¿Podés describirlo?"
}
```

When `processImages: true`, images received by the bot are analyzed by the AI using `imagePrompt` and the description is used as the user's message. Same for audio with `audioPrompt`.

---

## escalation

Triggered when the user types a keyword from the list, or when a flow step uses `action: "ESCALATE"`.

```json
"escalation": {
  "keywords": ["hablar con alguien", "soporte humano", "quiero hablar con una persona"],
  "clientMessage": "Voy a notificar a *{developerName}* para que te contacte. 🙏",
  "developerNotification": "🔔 Solicitud de soporte\n{clientName} ({clientPhone})\n\"{message}\"",
  "alreadyEscalatedMessage": "Tu consulta ya fue enviada a {developerName}. 🙏"
}
```

After escalation the bot stops responding to the user (state: `ESCALATED`). Use `!reactivar <phone>` from the control group to re-enable it.

---

## Clients

`config/clients.json` — array of known clients used for validation and knowledge filtering:

```json
[
  {
    "phone": "5491123456789",
    "name": "María García",
    "company": "Empresa S.A.",
    "systems": ["Sistema de Facturación"],
    "knowledgeDocs": ["medilab-knowledge.md"],
    "notes": "Usuaria principal del módulo de facturación"
  }
]
```

| Field | Description |
|---|---|
| `phone` | Phone in international format (digits only, no +) |
| `name` | Client's name — used in `{clientName}` and `{matchedClient.name}` |
| `company` | Company name — used in `{matchedClient.company}` and for fuzzy validation |
| `systems` | List of systems this client uses (informational) |
| `knowledgeDocs` | Knowledge doc filenames this client can query (see below) |
| `notes` | Internal notes (not shown to users) |

The `validate` step matches against `name` and `company` using fuzzy matching (case-insensitive, strips S.A./S.R.L. etc), and also matches by exact phone number.

---

## Knowledge Base

### FAQ

`config/knowledge.json` — instant keyword-based answers (no AI cost):

```json
[
  {
    "id": "reset-password",
    "question": "¿Cómo reseteo mi contraseña?",
    "tags": ["contraseña", "password", "resetear", "olvidé"],
    "answer": "Para resetear tu contraseña, seguí estos pasos:",
    "steps": [
      "Ir a la pantalla de login",
      "Hacer click en 'Olvidé mi contraseña'",
      "Ingresar tu email y seguir las instrucciones"
    ]
  }
]
```

FAQ matching checks if the user's query contains any `tag` or the first 20 characters of `question`. Returns score 1.0 — no embedding needed.

### Documents

Place `.md` or `.txt` files in `config/knowledge-docs/`. They are automatically indexed at startup:

1. Text is split into chunks (~500 words each)
2. Each chunk is embedded via the configured `embeddingModel`
3. Vectors are stored in `data/knowledge.sqlite`
4. On queries, cosine similarity is computed against stored chunks

**Tips for best results:**
- Use blank lines between topics — the chunker splits on line breaks
- Prefer descriptive headings over generic ones ("Cómo crear una orden" vs "Sección 3")
- Avoid complex tables — convert to prose
- If you update a doc, delete `data/knowledge.sqlite` and restart to re-index

**To convert a Word document:** Save as plain text (`.txt`) or copy-paste content into a `.md` file in `knowledge-docs/`.

### Per-client knowledge filtering

Each client can be restricted to only query their own documentation via the `knowledgeDocs` field in `clients.json`:

```json
{
  "name": "Ignacio Becher",
  "company": "Cima Tecno",
  "knowledgeDocs": ["cima-knowledge.md"]
}
```

**Behavior:**
- Client has `knowledgeDocs` with files → only searches those files
- Client has `knowledgeDocs: []` (empty) → no search, escalates to developer
- Client has no `knowledgeDocs` field → no search, escalates to developer

This ensures clients cannot access documentation from other companies' systems.

To add knowledge for a new client:
1. Create `config/knowledge-docs/cima-knowledge.md`
2. Add `"knowledgeDocs": ["cima-knowledge.md"]` to that client in `clients.json`
3. Delete `data/knowledge.sqlite` and restart to re-index

---

## Control Group Commands

Create a WhatsApp group, add the bot's number, and set `CONTROL_GROUP_ID` in `.env`. Then send these commands from the group:

| Command | Description |
|---|---|
| `!ayuda` | List all available commands |
| `!estado` | Bot status: uptime, AI provider, active sessions, paused senders |
| `!sesiones` | List all active sessions with their current state and step |
| `!flujos` | List all configured flows (conditional and legacy) with their steps |
| `!pausar <phone>` | Pause the bot for a specific phone number |
| `!reactivar <phone>` | Resume the bot for a specific phone number |
| `!grupos` | List all WhatsApp groups the bot is in (with their IDs) |

**Finding your group ID:** Send `!grupos` from any group the bot is in — it will reply with all group names and IDs.

---

## Human Takeover

When you reply manually to a client from the bot's WhatsApp number:

1. The bot **automatically pauses** for that conversation
2. A notification is sent to the control group (if configured): `⏸️ Bot pausado para 549XXXXXX`
3. To re-enable: send `!reactivar 549XXXXXX` from the control group

The bot stays paused even if the client sends more messages — it only resumes when you run `!reactivar`.

---

## Designing Your Own Bot

BugMate is fully configurable — you can deploy completely different bots just by editing the JSON files, with zero code changes.

### Minimal bot — greet only

Set `options: []` in the menu. The bot will greet every new user and wait. You handle conversations manually via human takeover.

```json
"menu": {
  "message": "",
  "invalidChoiceMessage": "",
  "unrecognizedOptionMessage": "",
  "options": []
}
```

### Simple report bot — no validation

```json
"conditionalFlows": {
  "simpleReport": {
    "startStep": "ask",
    "steps": {
      "ask": {
        "type": "input",
        "prompt": "Describí tu problema:",
        "saveAs": "problem",
        "nextStep": "done"
      },
      "done": {
        "type": "message",
        "text": "Recibido. Te contactamos pronto!",
        "action": "NOTIFY_DEVELOPER",
        "notification": "📩 Nuevo reporte\nTeléfono: {senderPhone}\nProblema: {problem}\nHora: {timestamp}",
        "nextStep": "END"
      }
    }
  }
}
```

### Direct AI chat — no knowledge base

```json
"conditionalFlows": {
  "directAI": {
    "startStep": "chat",
    "steps": {
      "chat": {
        "type": "ai",
        "inputPrompt": "¿En qué puedo ayudarte?",
        "textOnlyMessage": "Por favor escribí tu consulta.",
        "useKnowledge": false,
        "continuePrompt": "¿Algo más?",
        "nextStep": "END"
      }
    }
  }
}
```

### Full client support — validation + sub-menu + AI + knowledge filtering

See the full example in the [Conditional Flow DSL](#full-example) section.

---

## File Structure

```
bug-mate/
├── config/
│   ├── bot.config.json          # Main bot configuration (behavior, flows, messages)
│   ├── clients.json             # Known clients + their allowed knowledge docs
│   ├── knowledge.json           # FAQ entries (instant keyword matching)
│   └── knowledge-docs/          # Documents for vector search (one per system)
│       ├── medilab-knowledge.md
│       └── cima-knowledge.md
├── data/
│   └── knowledge.sqlite         # Auto-generated vector database (delete to re-index)
├── src/
│   └── modules/
│       ├── ai/                  # Gemini & Ollama providers
│       ├── bot/
│       │   ├── bot.service.ts              # Main message router
│       │   ├── conditional-flow.service.ts # Conditional flow interpreter
│       │   └── validate.service.ts         # Client data source validation
│       ├── config/              # Config loading, types, interpolation
│       ├── knowledge/           # Vector search & FAQ engine
│       ├── messaging/           # WhatsApp adapter & control group commands
│       └── session/             # In-memory session management
├── .env                         # Your environment variables (not committed)
├── .env.example                 # Template
└── README.md
```
