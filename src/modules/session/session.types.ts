export type ConversationState =
  | 'IDLE'
  | 'AWAITING_MENU_SELECTION'
  | 'FLOW_ACTIVE'
  | 'ESCALATED';

export interface FlowData {
  [key: string]: string;
}

export interface ConversationSession {
  senderId: string;
  clientName: string;
  state: ConversationState;
  /** ID of the active flow (matches a key in bot.config.json flows map) */
  activeFlowId: string | null;
  /** Current step index within a guided flow */
  flowStep: number;
  /** Data collected during a flow */
  flowData: FlowData;
  /** Conversation history for AI context */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastActivityAt: Date;
}
