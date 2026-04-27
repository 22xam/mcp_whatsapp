import { Injectable, Logger } from '@nestjs/common';
import type { ConversationSession, ConversationState, FlowData } from './session.types';
import { ConfigLoaderService } from '../config/config-loader.service';
import { ClientsService } from '../clients/clients.service';
import { ConversationMemoryService } from './conversation-memory.service';

export interface SessionSummary {
  senderId: string;
  clientName: string;
  state: ConversationState;
  activeStepId: string | null;
  activeFlowId: string | null;
  activeConditionalFlowId: string | null;
  lastActivityAt: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly startedAt = new Date();

  constructor(
    private readonly configLoader: ConfigLoaderService,
    private readonly clientsService: ClientsService,
    private readonly memory: ConversationMemoryService,
  ) {
    // Clean up expired sessions every 5 minutes
    setInterval(() => this.cleanExpired(), 5 * 60 * 1000);
  }

  /**
   * Returns the session for a sender, creating a new one if it doesn't exist
   * or if the previous session has expired.
   */
  getOrCreate(senderId: string): { session: ConversationSession; isNew: boolean } {
    const existing = this.sessions.get(senderId);
    const timeoutMs = this.configLoader.botConfig.greeting.sessionTimeoutMinutes * 60 * 1000;

    if (existing) {
      const elapsed = Date.now() - existing.lastActivityAt.getTime();
      if (elapsed < timeoutMs) {
        existing.lastActivityAt = new Date();
        return { session: existing, isNew: false };
      }
      this.logger.debug(`Session expired for ${senderId}`);
    }

    const client = this.clientsService.findByPhone(senderId) ?? this.configLoader.findClient(senderId);
    const session: ConversationSession = {
      senderId,
      clientName: client?.name ?? this.configLoader.botConfig.greeting.unknownClientName,
      state: 'IDLE',
      activeFlowId: null,
      flowStep: 0,
      activeConditionalFlowId: null,
      activeStepId: null,
      flowPath: [],
      flowStartedAt: null,
      flowData: {},
      history: [],
      lastActivityAt: new Date(),
    };

    this.sessions.set(senderId, session);
    this.logger.debug(`New session created for ${senderId} (${session.clientName})`);
    return { session, isNew: true };
  }

  // ─── Legacy flow state ────────────────────────────────────────

  setState(senderId: string, state: ConversationState, flowId: string | null = null): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.state = state;
      session.activeFlowId = flowId;
      session.flowStep = 0;
      session.flowData = {};
      session.activeConditionalFlowId = null;
      session.activeStepId = null;
      session.flowPath = [];
      session.flowStartedAt = null;
    }
  }

  advanceFlowStep(senderId: string, key: string, value: string): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.flowData[key] = value;
      session.flowStep++;
    }
  }

  setFlowData(senderId: string, data: Partial<FlowData>): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.flowData = { ...session.flowData, ...(data as Record<string, string>) };
    }
  }

  // ─── Conditional flow state ───────────────────────────────────

  /** Start a conditional flow — sets state and initializes step tracking */
  startConditionalFlow(senderId: string, flowId: string, startStepId: string): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.state = 'CONDITIONAL_FLOW_ACTIVE';
      session.activeConditionalFlowId = flowId;
      session.activeStepId = startStepId;
      session.flowPath = [startStepId];
      session.flowStartedAt = new Date();
      session.flowData = {};
      session.activeFlowId = null;
      session.flowStep = 0;
    }
  }

  /** Advance to a new step within the current conditional flow */
  advanceConditionalStep(senderId: string, nextStepId: string): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.activeStepId = nextStepId;
      session.flowPath.push(nextStepId);
    }
  }

  /** Save a string value to flowData (from input steps) */
  saveFlowVar(senderId: string, key: string, value: string): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.flowData[key] = value;
    }
  }

  /** Save an object value to flowData (from validate steps) */
  saveFlowObject(senderId: string, key: string, value: Record<string, unknown>): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.flowData[key] = value;
    }
  }

  // ─── Shared ───────────────────────────────────────────────────

  addToHistory(senderId: string, role: 'user' | 'assistant', content: string): void {
    const session = this.sessions.get(senderId);
    if (!session) return;

    const maxHistory = this.configLoader.botConfig.ai.maxHistoryMessages;
    session.history.push({ role, content });
    this.memory.record(senderId, role, content);

    if (session.history.length > maxHistory * 2) {
      session.history = session.history.slice(-maxHistory * 2);
    }
  }

  reset(senderId: string): void {
    const session = this.sessions.get(senderId);
    if (session) {
      session.state = 'IDLE';
      session.activeFlowId = null;
      session.flowStep = 0;
      session.activeConditionalFlowId = null;
      session.activeStepId = null;
      session.flowPath = [];
      session.flowStartedAt = null;
      session.flowData = {};
    }
  }

  /** Returns a read-only summary of all active sessions (for control group !sesiones command) */
  getAllSessions(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      senderId: s.senderId,
      clientName: s.clientName,
      state: s.state,
      activeStepId: s.activeStepId,
      activeFlowId: s.activeFlowId,
      activeConditionalFlowId: s.activeConditionalFlowId,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  get uptime(): number {
    return Date.now() - this.startedAt.getTime();
  }

  private cleanExpired(): void {
    const timeoutMs = this.configLoader.botConfig.greeting.sessionTimeoutMinutes * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() > timeoutMs) {
        this.sessions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug(`Cleaned ${removed} expired sessions`);
    }
  }
}
