<p align="center">
  <img src="assets/bug-mate-logo.png" alt="Bug-Mate Logo" width="180" />
</p>

# Bug-Mate

**Bug-Mate** es un bot de soporte técnico para WhatsApp, de código abierto, potenciado por IA. Está pensado para fábricas de software que quieren automatizar la atención al cliente: responder consultas, recolectar reportes de errores y escalar problemas a un desarrollador, todo desde WhatsApp.

Construido con [NestJS](https://nestjs.com/), [whatsapp-web.js](https://wwebjs.dev/) y la API de Google Gemini.

> Todo el comportamiento del bot — mensajes, opciones del menú, flujos de conversación, prompts de IA, palabras clave de escalación — se configura desde archivos JSON y variables de entorno. No hace falta tocar el código.

---

## Tabla de contenidos

- [Características](#características)
- [Cómo funciona](#cómo-funciona)
- [Stack tecnológico](#stack-tecnológico)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Requisitos previos](#requisitos-previos)
- [Instalación](#instalación)
- [Configuración](#configuración)
  - [Variables de entorno](#variables-de-entorno)
  - [Comportamiento del bot (bot.config.json)](#comportamiento-del-bot-botconfigjson)
  - [Base de clientes (clients.json)](#base-de-clientes-clientsjson)
  - [Preguntas frecuentes (knowledge.json)](#preguntas-frecuentes-knowledgejson)
  - [Documentos de conocimiento](#documentos-de-conocimiento)
- [Ejecutar el bot](#ejecutar-el-bot)
- [Despliegue con Docker](#despliegue-con-docker)
- [Arquitectura](#arquitectura)
- [Puntos de extensión](#puntos-de-extensión)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

---

## Características

- **Integración con WhatsApp** — Cliente de WhatsApp completo con autenticación por QR code
- **Respuestas con IA** — Usa Google Gemini para generar respuestas en lenguaje natural
- **Búsqueda semántica (RAG)** — Indexa tu documentación como embeddings vectoriales en SQLite para respuestas contextuales
- **Flujos de conversación con estado** — Flujos multi-paso para reportar errores y consultar la base de conocimiento
- **Reporte de errores** — Recolecta descripción y captura de pantalla, y notifica al desarrollador por WhatsApp
- **Escalación inteligente** — Detecta palabras clave configurables y deriva la conversación a un humano
- **Gestión de sesiones** — Estado de conversación por usuario con timeout y limpieza automática
- **Personalización por cliente** — Saluda a los clientes por nombre si están registrados en la base de datos
- **Proveedores de IA intercambiables** — Cambiá entre Gemini (cloud) y Ollama (local/sin internet) sin tocar el código
- **100% configurable** — Todos los mensajes, menús, flujos, prompts, palabras clave y parámetros de IA se definen en archivos de configuración

---

## Cómo funciona

Cuando un cliente manda un mensaje de WhatsApp, Bug-Mate:

1. Lo saluda por nombre (si está registrado en `clients.json`)
2. Muestra un menú con opciones configurables:
   - 🐛 Reportar un error
   - ❓ Consultar una duda
   - 👨‍💻 Hablar con el desarrollador
3. Según la elección del cliente:
   - **Reportar error** → Pide descripción y captura de pantalla → Envía el reporte al desarrollador
   - **Consultar** → Busca en FAQ y documentación → Genera una respuesta con IA basada en tu contenido
   - **Escalar** → Detecta keywords o solicitud explícita → Notifica al desarrollador con contexto
4. Las sesiones se reinician automáticamente tras el timeout configurado (por defecto: 30 minutos)

```
El cliente envía un mensaje
           │
           ▼
  Adaptador de WhatsApp (whatsapp-web.js)
           │
           ▼
  BotService (máquina de estados)
     ├── IDLE ──────────────────────────► Saludo + menú
     ├── AWAITING_MENU_SELECTION ───────► Parsear opción / detectar escalación
     ├── FLOW_REPORT_ERROR ─────────────► Recolectar datos del error ──► notificar al dev
     ├── FLOW_QUERY_KNOWLEDGE ──────────► Buscar en base de conocimiento + respuesta IA
     └── ESCALATED ─────────────────────► Confirmar escalación + notificar al dev
```

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| WhatsApp | whatsapp-web.js 1.34.6 |
| IA / LLM | Google Gemini 2.0 Flash |
| Embeddings | Gemini Embedding 001 |
| IA local (opcional) | Ollama (cualquier modelo compatible) |
| Base de datos | SQLite via better-sqlite3 |
| Runtime | Node.js 22 LTS |
| Contenedores | Docker + Docker Compose |

---

## Estructura del proyecto

```
bug-mate/
├── src/
│   ├── main.ts                        # Bootstrap de NestJS
│   ├── app.module.ts                  # Módulo raíz
│   └── modules/
│       ├── ai/                        # Abstracción del proveedor de IA
│       │   └── providers/
│       │       ├── gemini.provider.ts # Google Gemini (cloud)
│       │       └── ollama.provider.ts # Ollama (local/offline)
│       ├── bot/                       # Lógica central de conversación
│       │   └── bot.service.ts         # Máquina de estados y flujos
│       ├── config/                    # Carga de configuración (env + JSON)
│       │   ├── bot-config.service.ts  # Variables de entorno (.env)
│       │   ├── config-loader.service.ts # Archivos JSON de config
│       │   └── types/
│       │       └── bot-config.types.ts  # Interfaces TypeScript de la config
│       ├── core/                      # Interfaces e injection tokens
│       ├── knowledge/                 # Búsqueda FAQ + búsqueda vectorial semántica
│       ├── messaging/                 # Adaptador de WhatsApp (I/O de mensajes)
│       └── session/                   # Estado de sesión por usuario (en memoria)
├── config/
│   ├── bot.config.json                # Todo el comportamiento del bot
│   ├── clients.json                   # Base de datos de clientes
│   ├── knowledge.json                 # Preguntas frecuentes (FAQ)
│   └── knowledge-docs/                # Archivos .md / .txt para RAG
│       ├── preguntas-frecuentes.md    # Ejemplo: documentación FAQ
│       └── sistema-general.md         # Ejemplo: documentación del sistema
├── data/                              # Base de datos SQLite de vectores (auto-creada)
├── .wwebjs_auth/                      # Sesión de WhatsApp (auto-creada)
├── .env.example                       # Plantilla de variables de entorno
├── Dockerfile
└── docker-compose.yml
```

---

## Requisitos previos

- **Node.js 22+** — [Descargá aquí](https://nodejs.org/)
- **npm** (incluido con Node.js)
- **Clave de API de Google Gemini** — [Obtené una gratis en Google AI Studio](https://aistudio.google.com/app/apikey)
- **Una cuenta de WhatsApp** para usar como bot (se recomienda un número dedicado o secundario)

> **Opcional:** [Ollama](https://ollama.com/) si querés correr la IA completamente local, sin API key ni internet.

---

## Instalación

### 1. Clonar el repositorio

```bash
git clone https://github.com/tu-usuario/bug-mate.git
cd bug-mate
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Abrí `.env` y completá los valores. Como mínimo necesitás:

```env
GEMINI_API_KEY=tu_clave_de_gemini
DEVELOPER_PHONE=5491123456789        # Formato internacional, solo dígitos, sin + ni espacios
DEVELOPER_NAME=Juan
```

Ver [Variables de entorno](#variables-de-entorno) para la lista completa.

### 4. Configurar el bot

Editá los archivos dentro de la carpeta `/config/`. Ver [Configuración](#configuración) para los detalles de cada archivo.

### 5. Iniciar el bot

```bash
npm run start
```

### 6. Escanear el código QR

En el primer arranque, aparecerá un código QR en la terminal. Abrí WhatsApp en tu celular:

**Ajustes → Dispositivos vinculados → Vincular un dispositivo → Escaneá el QR**

La sesión se guarda en `.wwebjs_auth/` y se reutiliza en los próximos arranques. Solo necesitás escanear una vez.

---

## Configuración

Bug-Mate está diseñado para configurarse completamente desde archivos, sin modificar el código. Hay dos capas de configuración:

- **`.env`** — Secretos y configuración de infraestructura (API keys, números de teléfono, URLs)
- **`config/*.json`** — Comportamiento del bot (mensajes, menús, flujos, prompts, FAQ, clientes)

---

### Variables de entorno

| Variable | Requerida | Por defecto | Descripción |
|---|---|---|---|
| `GEMINI_API_KEY` | Sí* | — | Clave de API de Google Gemini ([obtener en AI Studio](https://aistudio.google.com/)) |
| `DEVELOPER_PHONE` | Sí | — | Número de WhatsApp del desarrollador (formato internacional, solo dígitos, ej: `5491123456789`) |
| `DEVELOPER_NAME` | No | `Developer` | Nombre del desarrollador, usado en notificaciones |
| `BOT_NAME` | No | `Bug-Mate` | Nombre del bot |
| `BOT_SYSTEM_PROMPT` | No | — | Overridea el system prompt de IA definido en `bot.config.json` |
| `ESCALATION_KEYWORDS` | No | — | Keywords separadas por coma que disparan escalación (ej: `urgente,roto,no funciona`) |
| `PORT` | No | `3000` | Puerto del servidor HTTP |
| `OLLAMA_URL` | No | `http://localhost:11434` | URL del servidor Ollama (si usás IA local) |
| `OLLAMA_MODEL` | No | `qwen3:8b` | Nombre del modelo Ollama |
| `OLLAMA_AUTO_START` | No | `false` | Inicia el proceso de Ollama automáticamente al arrancar |

> \*Requerida si usás Gemini (proveedor por defecto). No es necesaria si cambiás a Ollama.

---

### Comportamiento del bot (bot.config.json)

`config/bot.config.json` es el archivo de configuración principal. Controla absolutamente todo el comportamiento del bot: identidad, mensajes de bienvenida, opciones del menú, flujos de conversación, configuración de IA y reglas de escalación.

```jsonc
{
  "identity": {
    "name": "BugMate",
    "company": "Mi Empresa",
    "developerName": "Juan",
    "tone": "amigable, empático, profesional y conciso"
  },
  "greeting": {
    "enabled": true,
    "message": "¡Hola {clientName}! 👋 Soy *{botName}*, el asistente de *{company}*. ¿En qué te puedo ayudar?",
    "unknownClientName": "👋",
    "sessionTimeoutMinutes": 30
  },
  "menu": {
    "message": "Elegí una opción respondiendo con el número:",
    "invalidChoiceMessage": "No entendí tu respuesta.",
    "unrecognizedOptionMessage": "Opción no reconocida.",
    "options": [
      { "id": "1", "label": "🐛 Reportar un error",  "action": "REPORT_ERROR" },
      { "id": "2", "label": "❓ Consultar una duda",  "action": "QUERY_KNOWLEDGE" },
      { "id": "3", "label": "👨‍💻 Hablar con el dev",  "action": "ESCALATE" }
    ]
  },
  "flows": {
    "reportError": {
      "steps": [
        { "key": "description", "prompt": "Describí el error con el mayor detalle posible." },
        { "key": "screenshot",  "prompt": "¿Podés mandar una captura? Si no tenés, escribí *no tengo*." }
      ],
      "confirmationMessage": "Registré el reporte. Voy a notificar a *{developerName}* a la brevedad. 🙏",
      "developerNotification": "🐛 *Nuevo error*\n\n📱 *Cliente:* {clientName} ({clientPhone})\n📝 {description}\n📎 {screenshot}"
    },
    "queryKnowledge": {
      "inputPrompt": "Contame tu consulta y voy a buscar la información para ayudarte:",
      "textOnlyMessage": "Por favor escribí tu consulta con texto.",
      "noResultMessage": "No encontré información específica. Voy a notificar a *{developerName}*.",
      "noResultDeveloperNotification": "❓ *Consulta sin respuesta*\n\n📱 {clientName} ({clientPhone})\n💬 \"{query}\"",
      "ragContextInstruction": "Respondé de forma natural y conversacional.",
      "continuePrompt": "¿Hay algo más en lo que pueda ayudarte? Respondé *menú* para ver las opciones.",
      "resultPrefix": "Encontré esto que puede ayudarte:"
    }
  },
  "ai": {
    "model": "gemini-2.0-flash",
    "embeddingModel": "gemini-embedding-001",
    "systemPrompt": "Sos {botName}, el asistente de soporte de {company}. Respondé en español rioplatense.",
    "ragMinScore": 0.72,
    "ragTopK": 3,
    "fallbackToEscalation": true,
    "maxHistoryMessages": 10
  },
  "media": {
    "processImages": true,
    "processAudio": true,
    "imagePrompt": "Analizá esta imagen en detalle. Si es una captura de un sistema, describí qué ves.",
    "audioPrompt": "Transcribí exactamente el mensaje de audio en español.",
    "unsupportedMessage": "Recibí tu {mediaType}, pero por ahora no puedo procesarlo. ¿Podés describirlo con texto?"
  },
  "escalation": {
    "keywords": ["urgente", "roto", "no funciona", "hablar con alguien"],
    "clientMessage": "Entendido. Voy a notificar a *{developerName}* para que se comunique con vos. 🙏",
    "developerNotification": "🔔 *Solicitud de soporte humano*\n\n📱 {clientName} ({clientPhone})\n💬 \"{message}\"",
    "alreadyEscalatedMessage": "Tu consulta ya fue enviada a *{developerName}*. En cuanto pueda se comunica con vos. 🙏"
  }
}
```

> **Placeholders disponibles:** `{clientName}`, `{clientPhone}`, `{botName}`, `{company}`, `{developerName}`, `{message}`, `{query}`, `{description}`, `{screenshot}`, `{mediaType}`. Son reemplazados automáticamente en tiempo de ejecución.

---

### Base de clientes (clients.json)

Agregá a tus clientes para que el bot los salude por nombre y sepa qué sistemas usan:

```json
[
  {
    "phone": "5491123456789",
    "name": "Alicia",
    "company": "Widgets S.A.",
    "systems": ["sistema-facturacion", "inventario"]
  },
  {
    "phone": "5499876543210",
    "name": "Roberto",
    "company": "La Panadería de Roberto",
    "systems": ["pos-system"]
  }
]
```

Si el número no está en este archivo, el bot funciona igual pero usa el saludo genérico configurado en `greeting.unknownClientName`.

---

### Preguntas frecuentes (knowledge.json)

Agregá las preguntas frecuentes que el bot va a usar para responder consultas. La búsqueda usa tanto matching por palabras clave (tags) como búsqueda semántica:

```json
[
  {
    "id": "faq-login",
    "tags": ["login", "contraseña", "acceso", "no puedo entrar", "olvidé mi contraseña"],
    "question": "¿Cómo reseteo mi contraseña?",
    "answer": "Podés resetear tu contraseña desde la pantalla de login. Hacé click en 'Olvidé mi contraseña', ingresá tu email y seguí las instrucciones.",
    "steps": [
      "Andá a la pantalla de login",
      "Hacé click en 'Olvidé mi contraseña'",
      "Ingresá tu email registrado",
      "Revisá tu bandeja de entrada y seguí el link"
    ]
  }
]
```

---

### Documentos de conocimiento

Agregá cualquier archivo `.md` o `.txt` a la carpeta `config/knowledge-docs/`. Son indexados automáticamente en la base de datos SQLite de vectores al iniciar la aplicación y se usan como contexto (RAG) para las respuestas de IA.

Ejemplos de contenido útil:
- Documentación del producto
- Guías paso a paso
- Notas de versión
- Wikis internas

**Cómo funciona:** Cuando el usuario hace una consulta, el bot calcula un embedding semántico de la pregunta y busca los fragmentos más relevantes de tus documentos por similitud coseno. Los mejores resultados se inyectan como contexto en el prompt de IA, así el bot responde basándose en **tu documentación real** y no solo en su conocimiento general.

---

## Ejecutar el bot

### Desarrollo (con hot reload)

```bash
npm run start:dev
```

### Producción

```bash
npm run build
npm run start:prod
```

### Modo debug

```bash
npm run start:debug
```

### Tests

```bash
npm run test          # Tests unitarios
npm run test:watch    # Modo watch
npm run test:cov      # Reporte de cobertura
npm run test:e2e      # Tests end-to-end
```

### Calidad de código

```bash
npm run lint          # ESLint con auto-fix
npm run format        # Formato con Prettier
```

---

## Despliegue con Docker

La forma más fácil de correr Bug-Mate en producción es con Docker Compose. Todo (Node.js, Chromium para WhatsApp y opcionalmente Ollama) corre en contenedores.

### 1. Configurar el archivo `.env`

Completá tu `.env` con los valores reales antes de buildear.

### 2. Buildear e iniciar

```bash
docker-compose up --build
```

Esto levanta dos servicios:
- **ollama** — servidor de IA local (usado si `OLLAMA_AUTO_START=true` o si cambiás el proveedor de IA)
- **bugmate** — la aplicación NestJS

### 3. Escanear el QR en el primer arranque

```bash
docker-compose logs -f bugmate
```

Mirá los logs hasta que aparezca el QR, escanealo con WhatsApp. La sesión se persiste en `./wwebjs_auth/` (volumen montado), así que solo necesitás hacerlo una vez.

### Detener

```bash
docker-compose down
```

---

## Arquitectura

Bug-Mate usa una **arquitectura modular de NestJS** con separación clara de responsabilidades. Cada módulo tiene una sola responsabilidad y se comunican mediante el sistema de inyección de dependencias.

```
AppModule
├── AppConfigModule    → Carga variables de .env y archivos JSON de config
├── CoreModule         → Interfaces compartidas, tokens de inyección, manager de Ollama
├── AiModule           → Capa de abstracción de proveedores de IA (Gemini / Ollama)
├── SessionModule      → Estado de conversación por usuario en memoria, con auto-limpieza
├── KnowledgeModule    → Búsqueda en dos niveles: keywords FAQ + búsqueda vectorial semántica
├── BotModule          → Máquina de estados y orquestación de flujos de conversación
└── MessagingModule    → Adaptador de WhatsApp (recibe y envía mensajes)
```

### Máquina de estados de conversación

Cada sesión de usuario pasa por estos estados:

```
IDLE
 └─(primer mensaje)──────────────► AWAITING_MENU_SELECTION
                                         ├─(opción 1)──► FLOW_REPORT_ERROR ──► IDLE
                                         ├─(opción 2)──► FLOW_QUERY_KNOWLEDGE ──► IDLE
                                         └─(opción 3 o keyword)──► ESCALATED
```

Las sesiones expiran automáticamente tras el timeout configurado. Una tarea en background limpia las sesiones viejas cada 5 minutos.

### Búsqueda vectorial (RAG)

Cuando el usuario hace una consulta, el servicio de conocimiento ejecuta una búsqueda en dos niveles:

1. **Matching por keywords/tags** — rápido y gratuito, busca en los tags y preguntas de la FAQ
2. **Búsqueda semántica vectorial** — genera un embedding de Gemini para la consulta y calcula similitud coseno contra todos los documentos indexados en SQLite
3. Se seleccionan los Top-K resultados (por defecto: 3) con un score mínimo configurable (por defecto: 0.72)
4. El contenido encontrado se inyecta en el prompt de Gemini como contexto (RAG)

Así el bot responde consultas fundamentadas en **tu documentación real**, no solo en su conocimiento de entrenamiento.

---

## Puntos de extensión

Bug-Mate está diseñado para extenderse sin modificar la lógica central:

| Qué extender | Cómo |
|---|---|
| Agregar un nuevo proveedor de IA | Implementar la interfaz `AIProvider` en `src/modules/ai/providers/` |
| Agregar una nueva plataforma de mensajería | Implementar la interfaz `MessageAdapter` en `src/modules/messaging/adapters/` |
| Agregar un nuevo flujo de conversación | Agregar un nuevo estado y handler en `BotService` |
| Agregar contenido de conocimiento | Dejar archivos `.md` o `.txt` en `config/knowledge-docs/` |
| Agregar o actualizar clientes | Editar `config/clients.json` |
| Personalizar todos los mensajes y prompts | Editar `config/bot.config.json` |

---

## Contribuir

¡Las contribuciones son bienvenidas! Así podés empezar:

1. Forkear el repositorio
2. Crear una rama: `git checkout -b feature/mi-feature`
3. Hacer los cambios y agregar tests si aplica
4. Correr `npm run test` y `npm run lint` para verificar que todo pasa
5. Commitear usando [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: agregar mi feature"`
6. Pushear y abrir un Pull Request

---

## Licencia

Este proyecto es de código abierto y está disponible bajo la [Licencia MIT](LICENSE).

---

> Hecho para fábricas de software que quieren soporte más inteligente sin salir de WhatsApp.
