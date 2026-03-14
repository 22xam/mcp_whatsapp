// ─── Step actions ─────────────────────────────────────────────────────────────

/**
 * Terminal or side-effect actions that can be attached to steps.
 * - ESCALATE: notify developer + mark session as ESCALATED (bot stops responding)
 * - NOTIFY_DEVELOPER: send a notification to the developer but continue the flow
 * - END: finish the flow and return session to IDLE
 * - SHOW_MENU: finish the flow and re-show the top-level menu
 */
export type StepAction = 'ESCALATE' | 'NOTIFY_DEVELOPER' | 'END' | 'SHOW_MENU' | 'CREATE_TRELLO_CARD';

// ─── Message step ─────────────────────────────────────────────────────────────

/**
 * Sends a static text message to the user.
 * Supports {variable} interpolation from flowData and system vars.
 *
 * @example
 * {
 *   "type": "message",
 *   "text": "Perfecto, voy a notificar a {developerName}. 🙏",
 *   "action": "NOTIFY_DEVELOPER",
 *   "notification": "🐛 Error reportado por {clientName} ({senderPhone}): {errorDescription}",
 *   "nextStep": "END"
 * }
 */
export interface TrelloCardConfig {
  /**
   * Key of the list defined in bot.config.json trello.lists
   * where the card will be created (e.g. "bugs", "pendientes").
   */
  listKey: string;
  /** Card title. Supports {variable} interpolation. */
  title: string;
  /** Card description (body). Supports {variable} interpolation. */
  description: string;
}

export interface MessageStep {
  type: 'message';
  /** Text sent to the user. Supports {variable} interpolation. */
  text: string;
  /** Optional side-effect triggered after the message is sent */
  action?: StepAction;
  /**
   * Developer notification template — used when action is NOTIFY_DEVELOPER or ESCALATE.
   * Supports {variable} interpolation.
   */
  notification?: string;
  /**
   * Trello card to create when action is CREATE_TRELLO_CARD.
   * Supports {variable} interpolation in title and description.
   */
  trelloCard?: TrelloCardConfig;
  /** Next step ID or "END" to finish the flow */
  nextStep: string | 'END';
}

// ─── Input step ───────────────────────────────────────────────────────────────

/**
 * Sends a prompt to the user and waits for their response.
 * The response is saved in flowData under the key specified by saveAs.
 *
 * @example
 * {
 *   "type": "input",
 *   "prompt": "Describí el error con el mayor detalle posible:",
 *   "saveAs": "errorDescription",
 *   "nextStep": "reportError_screenshot"
 * }
 */
export interface InputStep {
  type: 'input';
  /** Prompt sent to the user. Supports {variable} interpolation. */
  prompt: string;
  /** flowData key under which the user's response is stored */
  saveAs: string;
  /** Whether to accept media (images/audio) for this step */
  acceptMedia?: boolean;
  /** Text stored as the value when media is received and acceptMedia is true */
  mediaFallback?: string;
  /** Next step ID or "END" to finish the flow */
  nextStep: string | 'END';
}

// ─── Menu step ────────────────────────────────────────────────────────────────

export interface ConditionalMenuOption {
  /** Number or short string the user types to choose this option */
  id: string;
  /** Label shown to the user */
  label: string;
  /** Step to go to when this option is chosen */
  nextStep?: string | 'END';
  /** Built-in terminal action (overrides nextStep) */
  action?: StepAction;
  /**
   * Developer notification sent when this option is chosen (only used when action
   * is ESCALATE or NOTIFY_DEVELOPER). Supports {variable} interpolation.
   */
  notification?: string;
  /**
   * Trello card to create when action is CREATE_TRELLO_CARD.
   * Supports {variable} interpolation in title and description.
   */
  trelloCard?: TrelloCardConfig;
}

/**
 * Presents a numbered list of options to the user and routes based on their choice.
 *
 * @example
 * {
 *   "type": "menu",
 *   "message": "¿En qué te puedo ayudar?",
 *   "options": [
 *     { "id": "1", "label": "Reportar error", "nextStep": "askDescription" },
 *     { "id": "2", "label": "Hablar con desarrollo", "action": "ESCALATE" }
 *   ],
 *   "invalidMessage": "Elegí una opción válida."
 * }
 */
export interface MenuStep {
  type: 'menu';
  /** Message shown above the options list. Supports {variable} interpolation. */
  message: string;
  options: ConditionalMenuOption[];
  /** Sent when the user's input doesn't match any option */
  invalidMessage: string;
}

// ─── Validate step ────────────────────────────────────────────────────────────

/** Currently supported data sources for validation */
export type ValidateDataSource = 'clients';

export interface ValidateOnMatch {
  /**
   * flowData key under which the matched record is stored as an object.
   * Access individual fields via {key.field} in templates, e.g. {matchedClient.name}
   */
  saveAs: string;
  /** Step to go to when validation succeeds */
  nextStep: string | 'END';
}

export interface ValidateOnNoMatch {
  /** Message sent to the user when no match is found. Supports {variable} interpolation. */
  message?: string;
  /** Action to take when no match is found */
  action?: StepAction;
  /** Developer notification when no match is found. Supports {variable} interpolation. */
  notification?: string;
  /** Step to go to when no match is found (used when action is not terminal) */
  nextStep?: string | 'END';
}

/**
 * Validates a collected variable against a data source.
 * On match, saves the matched record and routes to onMatch.nextStep.
 * On no match, triggers onNoMatch behavior.
 *
 * Matching is fuzzy: ignores case, strips common legal suffixes (S.A., S.R.L., etc.)
 * and checks both the name and company fields of each record.
 *
 * @example
 * {
 *   "type": "validate",
 *   "dataSource": "clients",
 *   "inputVar": "clientInput",
 *   "onMatch": { "saveAs": "matchedClient", "nextStep": "clientMenu" },
 *   "onNoMatch": {
 *     "message": "No encontré tu empresa. Voy a notificar a {developerName}.",
 *     "action": "ESCALATE",
 *     "notification": "⚠️ Empresa no encontrada: {clientInput} — {senderPhone}"
 *   }
 * }
 */
export interface ValidateStep {
  type: 'validate';
  /** Which registered data source to query */
  dataSource: ValidateDataSource;
  /**
   * Name of the flowData variable containing the user's input to match.
   * The matching checks name, company, and phone fields of each record.
   */
  inputVar: string;
  onMatch: ValidateOnMatch;
  onNoMatch: ValidateOnNoMatch;
}

// ─── AI step ──────────────────────────────────────────────────────────────────

/**
 * Sends an input prompt, then processes the response using the AI provider
 * with optional RAG (knowledge base) lookup.
 *
 * @example
 * {
 *   "type": "ai",
 *   "inputPrompt": "Contame tu consulta:",
 *   "textOnlyMessage": "Por favor escribí tu consulta con texto.",
 *   "useKnowledge": true,
 *   "fallbackToEscalation": true,
 *   "noResultMessage": "No encontré información. Voy a notificar a {developerName}.",
 *   "noResultNotification": "❓ Consulta sin respuesta: {userQuery} — {senderPhone}",
 *   "continuePrompt": "¿Necesitás algo más?",
 *   "nextStep": "END"
 * }
 */
export interface AiStep {
  type: 'ai';
  /** Prompt sent to the user before they enter their query */
  inputPrompt: string;
  /** Sent when user sends non-text content */
  textOnlyMessage: string;
  /** Overrides the global ai.systemPrompt for this step. Supports {company} etc. */
  systemPromptOverride?: string;
  /** Whether to search the knowledge base before calling the AI */
  useKnowledge: boolean;
  /** Additional instruction appended to the system prompt when a knowledge result is found */
  ragContextInstruction?: string;
  /** Whether to escalate to the developer when no knowledge result is found */
  fallbackToEscalation?: boolean;
  /** Message sent to the user when no knowledge result is found */
  noResultMessage?: string;
  /** Developer notification when no knowledge result is found. Supports {variable} interpolation. */
  noResultNotification?: string;
  /** Message sent after a successful AI response */
  continuePrompt: string;
  /** flowData key under which the user's query is stored (defaults to "userQuery") */
  saveQueryAs?: string;
  /** Next step ID or "END" to finish the flow */
  nextStep: string | 'END';
}

// ─── Union type ───────────────────────────────────────────────────────────────

export type ConditionalFlowStep = MessageStep | InputStep | MenuStep | ValidateStep | AiStep;

// ─── Flow definition ──────────────────────────────────────────────────────────

/**
 * A conditional flow is a named graph of steps.
 * Execution begins at startStep and follows nextStep / branch routing
 * until it reaches a terminal action (END, ESCALATE) or a step with nextStep: "END".
 *
 * All steps in a flow share a flowData store.
 * Variables collected via InputStep.saveAs and ValidateStep.onMatch.saveAs
 * are available as {varName} or {varName.field} throughout all subsequent steps.
 *
 * System variables always available: {senderPhone}, {timestamp}, {flowPath},
 * {developerName}, {company}, {botName}, {clientName}
 */
export interface ConditionalFlow {
  /** ID of the first step to execute when this flow starts */
  startStep: string;
  /** Named steps — each key is a step ID referenced by nextStep fields */
  steps: Record<string, ConditionalFlowStep>;
}
