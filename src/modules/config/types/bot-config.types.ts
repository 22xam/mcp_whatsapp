export interface BotIdentity {
  name: string;
  company: string;
  developerName: string;
  tone: string;
}

export interface GreetingConfig {
  enabled: boolean;
  message: string;
  unknownClientName: string;
  sessionTimeoutMinutes: number;
}

export interface MenuOption {
  id: string;
  label: string;
  /** Built-in actions that don't require a flow definition */
  action?: 'ESCALATE' | 'SHOW_MENU';
  /** ID of a legacy flow defined in the flows map */
  flowId?: string;
  /** ID of a conditional flow defined in the conditionalFlows map */
  conditionalFlowId?: string;
  /** Override the conditional flow's own startStep */
  conditionalFlowStartStep?: string;
}

export interface MenuConfig {
  message: string;
  invalidChoiceMessage: string;
  unrecognizedOptionMessage: string;
  options: MenuOption[];
}

// ─── Flow step (guided mode) ─────────────────────────────────────────────────

export interface FlowStep {
  key: string;
  prompt: string;
}

// ─── Guided flow ─────────────────────────────────────────────────────────────

export interface GuidedFlow {
  type: 'guided';
  steps: FlowStep[];
  /** Message sent to the client after all steps are collected */
  confirmationMessage: string;
  /** WhatsApp message sent to the developer. Supports {clientName}, {clientPhone}, plus any step key as {key} */
  developerNotification: string;
  /** Fallback text for optional media steps when no media is provided */
  noMediaFallback?: string;
}

// ─── AI flow ─────────────────────────────────────────────────────────────────

export interface AiFlow {
  type: 'ai';
  /** Prompt sent to the user asking for their query */
  inputPrompt: string;
  /** Sent when user sends non-text content in an ai flow */
  textOnlyMessage: string;
  /** Override the global ai.systemPrompt for this flow. Supports {company}, {botName}, {developerName}, {tone} */
  systemPromptOverride?: string;
  /** Whether to use the knowledge base (RAG) for this flow */
  useKnowledge: boolean;
  /** Sent when knowledge search yields no result and fallbackToEscalation is true */
  noResultMessage?: string;
  /** Developer notification when knowledge search yields no result. Supports {clientName}, {clientPhone}, {query} */
  noResultDeveloperNotification?: string;
  /** Additional instruction appended to the system prompt when a knowledge result is found */
  ragContextInstruction?: string;
  /** Whether to escalate to the developer when no knowledge result is found */
  fallbackToEscalation?: boolean;
  /** Prompt sent after a successful AI response to invite further interaction */
  continuePrompt: string;
}

export type FlowDefinition = GuidedFlow | AiFlow;

// ─── Top-level config ─────────────────────────────────────────────────────────

export interface AiConfig {
  model: string;
  embeddingModel: string;
  systemPrompt: string;
  ragMinScore: number;
  ragTopK: number;
  /** Global fallback: escalate when AI has no knowledge result (can be overridden per AiFlow) */
  fallbackToEscalation: boolean;
  maxHistoryMessages: number;
}

export interface HumanDelayConfig {
  enabled: boolean;
  readingDelayMinMs: number;
  readingDelayMaxMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  msPerCharacter: number;
}

export interface MediaConfig {
  processImages: boolean;
  processAudio: boolean;
  imagePrompt: string;
  audioPrompt: string;
  unsupportedMessage: string;
}

export interface EscalationConfig {
  keywords: string[];
  clientMessage: string;
  developerNotification: string;
  alreadyEscalatedMessage: string;
}

export interface TrelloConfig {
  /** Whether Trello integration is active */
  enabled: boolean;
  /**
   * Named list map: key is a logical name (e.g. "bugs", "pendientes"),
   * value is the Trello list ID where cards will be created.
   * Use the !trello command in the control group to discover list IDs.
   */
  lists: Record<string, string>;
}

export interface BotConfig {
  identity: BotIdentity;
  greeting: GreetingConfig;
  menu: MenuConfig;
  /** Map of flowId → legacy flow definition (guided or ai). */
  flows: Record<string, FlowDefinition>;
  /** Map of flowId → conditional (graph-based) flow definition. */
  conditionalFlows?: Record<string, import('./conditional-flow.types').ConditionalFlow>;
  humanDelay: HumanDelayConfig;
  ai: AiConfig;
  media: MediaConfig;
  escalation: EscalationConfig;
  /** Optional Trello integration config */
  trello?: TrelloConfig;
}

export interface ClientConfig {
  phone: string;
  name: string;
  company: string;
  systems: string[];
  notes?: string;
  /** Knowledge doc filenames this client is allowed to query (e.g. ["cima-knowledge.md"]) */
  knowledgeDocs?: string[];
}

export interface KnowledgeEntry {
  id: string;
  tags: string[];
  question: string;
  answer: string;
  steps?: string[];
}
