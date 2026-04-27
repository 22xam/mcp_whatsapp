import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, MessageAdapter } from '../core/interfaces/message-adapter.interface';
import type { AIProvider } from '../core/interfaces/ai-provider.interface';
import { AI_PROVIDER } from '../core/tokens/injection-tokens';
import { BotConfigService } from '../config/bot-config.service';
import { ConfigLoaderService } from '../config/config-loader.service';
import { SessionService } from '../session/session.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ConditionalFlowService } from './conditional-flow.service';
import type { ConversationSession } from '../session/session.types';
import type { AiFlow, GuidedFlow } from '../config/types/bot-config.types';
import { AiConversationService } from '../ai/ai-conversation.service';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
    private readonly botConfig: BotConfigService,
    private readonly configLoader: ConfigLoaderService,
    private readonly sessionService: SessionService,
    private readonly knowledgeService: KnowledgeService,
    private readonly conditionalFlowService: ConditionalFlowService,
    private readonly aiConversation: AiConversationService,
  ) {}

  async handleMessage(incoming: IncomingMessage, adapter: MessageAdapter): Promise<void> {
    this.logger.log(`[${adapter.channelName}] Message from ${incoming.senderId}`);

    const { session, isNew } = this.sessionService.getOrCreate(incoming.senderId);
    if (await this.handleGlobalCommand(incoming, session, adapter)) {
      return;
    }
    this.sessionService.addToHistory(incoming.senderId, 'user', incoming.text || '[media]');

    const mode = this.configLoader.botConfig.mode ?? 'flow';
    if (mode === 'ai') {
      await this.handleFullAiMode(incoming, session, adapter);
      return;
    }

    if (isNew || session.state === 'IDLE') {
      await this.sendGreetingAndMenu(session, adapter);
      return;
    }

    if (session.state === 'AWAITING_MENU_SELECTION') {
      await this.handleMenuSelection(incoming, session, adapter);
      return;
    }

    if (session.state === 'FLOW_ACTIVE') {
      await this.handleActiveFlow(incoming, session, adapter);
      return;
    }

    if (session.state === 'CONDITIONAL_FLOW_ACTIVE') {
      await this.conditionalFlowService.handleStep(incoming, session, adapter);
      return;
    }

    if (session.state === 'ESCALATED') {
      const { escalation, identity } = this.configLoader.botConfig;
      await this.send(
        adapter,
        session.senderId,
        this.configLoader.interpolate(escalation.alreadyEscalatedMessage, {
          developerName: identity.developerName,
        }),
      );
      return;
    }
  }

  // ─── Greeting ────────────────────────────────────────────────

  private async handleGlobalCommand(
    incoming: IncomingMessage,
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<boolean> {
    const input = this.normalizeCommand(incoming.text);
    if (!input) return false;

    const commands = this.configLoader.botConfig.commands?.global;
    const menuAliases = commands?.menuAliases ?? ['menu', 'menú', 'volver', 'inicio'];
    const cancelAliases = commands?.cancelAliases ?? ['cancelar', 'salir', 'terminar'];
    const allowMenuWhenEscalated = commands?.allowMenuWhenEscalated ?? false;

    if (menuAliases.map((a) => this.normalizeCommand(a)).includes(input)) {
      if (session.state === 'ESCALATED' && !allowMenuWhenEscalated) {
        return false;
      }
      this.sessionService.reset(session.senderId);
      const { session: resetSession } = this.sessionService.getOrCreate(session.senderId);
      await this.sendGreetingAndMenu(resetSession, adapter);
      return true;
    }

    if (cancelAliases.map((a) => this.normalizeCommand(a)).includes(input)) {
      this.sessionService.reset(session.senderId);
      const message =
        commands?.cancelMessage ??
        'Listo, cancelé la operación actual. Escribí *menú* cuando quieras volver a empezar.';
      await this.send(adapter, session.senderId, message);
      return true;
    }

    return false;
  }

  private normalizeCommand(text: string | undefined): string {
    return (text ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private async sendGreetingAndMenu(
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<void> {
    const { greeting, identity, menu } = this.configLoader.botConfig;

    const greetingText = this.configLoader.interpolate(greeting.message, {
      clientName: session.clientName,
      company: identity.company,
      botName: identity.name,
    });

    const menuText = this.buildMenuText(
      menu.message,
      menu.options.map((o) => `*${o.id}*. ${o.label}`),
    );

    await this.send(adapter, session.senderId, `${greetingText}\n\n${menuText}`);
    this.sessionService.setState(session.senderId, 'AWAITING_MENU_SELECTION');
  }

  private buildMenuText(header: string, options: string[]): string {
    return `${header}\n\n${options.join('\n')}`;
  }

  // ─── Menu selection ──────────────────────────────────────────

  private async handleMenuSelection(
    incoming: IncomingMessage,
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<void> {
    const { menu } = this.configLoader.botConfig;
    const input = incoming.text?.trim();

    if (this.shouldEscalate(input)) {
      await this.escalate(incoming, session, adapter);
      return;
    }

    const option = menu.options.find(
      (o) =>
        o.id === input ||
        input?.toLowerCase().includes(o.label.toLowerCase().slice(2, 10)),
    );

    if (!option) {
      const menuText = this.buildMenuText(
        `${menu.invalidChoiceMessage} ${menu.message}`,
        menu.options.map((o) => `*${o.id}*. ${o.label}`),
      );
      await this.send(adapter, session.senderId, menuText);
      return;
    }

    // Built-in actions
    if (option.action === 'ESCALATE') {
      await this.escalate(incoming, session, adapter);
      return;
    }

    if (option.action === 'SHOW_MENU') {
      const menuText = this.buildMenuText(
        menu.message,
        menu.options.map((o) => `*${o.id}*. ${o.label}`),
      );
      await this.send(adapter, session.senderId, menuText);
      return;
    }

    // Conditional flow-based options
    if (option.conditionalFlowId) {
      await this.conditionalFlowService.startFlow(
        option.conditionalFlowId,
        option.conditionalFlowStartStep,
        session,
        adapter,
      );
      return;
    }

    // Legacy flow-based options
    if (option.flowId) {
      const flow = this.configLoader.botConfig.flows[option.flowId];
      if (!flow) {
        this.logger.error(`Flow "${option.flowId}" not found in config`);
        await this.send(adapter, session.senderId, menu.unrecognizedOptionMessage);
        return;
      }
      await this.startFlow(option.flowId, flow, session, adapter);
      return;
    }

    await this.send(adapter, session.senderId, menu.unrecognizedOptionMessage);
  }

  // ─── Flow dispatcher ─────────────────────────────────────────

  private async startFlow(
    flowId: string,
    flow: GuidedFlow | AiFlow,
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<void> {
    this.sessionService.setState(session.senderId, 'FLOW_ACTIVE', flowId);

    const prompt = flow.type === 'guided' ? flow.steps[0].prompt : flow.inputPrompt;
    await this.send(adapter, session.senderId, prompt);
  }

  private async handleActiveFlow(
    incoming: IncomingMessage,
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<void> {
    const flowId = session.activeFlowId;
    if (!flowId) {
      this.sessionService.reset(session.senderId);
      await this.sendGreetingAndMenu(session, adapter);
      return;
    }

    const flow = this.configLoader.botConfig.flows[flowId];
    if (!flow) {
      this.logger.error(`Active flow "${flowId}" not found in config`);
      this.sessionService.reset(session.senderId);
      return;
    }

    if (flow.type === 'guided') {
      await this.handleGuidedFlow(incoming, session, flow, adapter);
    } else {
      await this.handleAiFlow(incoming, session, flow, adapter);
    }
  }

  // ─── Guided flow ─────────────────────────────────────────────

  private async handleGuidedFlow(
    incoming: IncomingMessage,
    session: ConversationSession,
    flow: GuidedFlow,
    adapter: MessageAdapter,
  ): Promise<void> {
    const currentStep = flow.steps[session.flowStep];
    const value =
      incoming.text ||
      (incoming.mediaBase64 ? '[imagen adjunta]' : flow.noMediaFallback ?? '[media]');

    this.sessionService.advanceFlowStep(session.senderId, currentStep.key, value);

    const nextStepIndex = session.flowStep; // already advanced by advanceFlowStep
    if (nextStepIndex < flow.steps.length) {
      await this.send(adapter, session.senderId, flow.steps[nextStepIndex].prompt);
      return;
    }

    // All steps complete — notify developer
    const { identity } = this.configLoader.botConfig;
    const vars = {
      clientName: session.clientName,
      clientPhone: incoming.senderId.replace('@c.us', '').replace('@lid', ''),
      developerName: identity.developerName,
      ...session.flowData,
    };

    await this.send(
      adapter,
      this.botConfig.developerWhatsAppId,
      this.configLoader.interpolate(flow.developerNotification, vars),
    );

    await this.send(
      adapter,
      session.senderId,
      this.configLoader.interpolate(flow.confirmationMessage, vars),
    );

    this.sessionService.setState(session.senderId, 'IDLE');
  }

  // ─── AI flow ─────────────────────────────────────────────────

  private async handleAiFlow(
    incoming: IncomingMessage,
    session: ConversationSession,
    flow: AiFlow,
    adapter: MessageAdapter,
  ): Promise<void> {
    const { identity, ai } = this.configLoader.botConfig;

    const query = incoming.text?.trim();
    if (!query) {
      await this.send(adapter, session.senderId, flow.textOnlyMessage);
      return;
    }

    const fallbackToEscalation = flow.fallbackToEscalation ?? ai.fallbackToEscalation;

    const systemPrompt = this.configLoader.interpolate(
      flow.systemPromptOverride ?? ai.systemPrompt,
      { company: identity.company, developerName: identity.developerName, botName: identity.name, tone: identity.tone },
    );

    const response = await this.aiConversation.generateResponse({
      senderId: session.senderId,
      prompt: query,
      systemPrompt,
      history: session.history.slice(0, -1),
      useKnowledge: flow.useKnowledge,
      ragContextInstruction: flow.ragContextInstruction,
    });

    if (response.rag.used || !flow.useKnowledge) {
      this.sessionService.addToHistory(session.senderId, 'assistant', response.text);
      await this.send(adapter, session.senderId, response.text);
      await this.aiConversation.summarizeIfNeeded(session.senderId);
    } else if (fallbackToEscalation) {
      const noResultMsg = this.configLoader.interpolate(flow.noResultMessage ?? '', {
        developerName: identity.developerName,
      });
      if (noResultMsg) await this.send(adapter, session.senderId, noResultMsg);

      if (flow.noResultDeveloperNotification) {
        await this.send(
          adapter,
          this.botConfig.developerWhatsAppId,
          this.configLoader.interpolate(flow.noResultDeveloperNotification, {
            clientName: session.clientName,
            clientPhone: incoming.senderId.replace('@c.us', '').replace('@lid', ''),
            query,
          }),
        );
      }

      this.sessionService.setState(session.senderId, 'ESCALATED');
      return;
    } else {
      this.sessionService.addToHistory(session.senderId, 'assistant', response.text);
      await this.send(adapter, session.senderId, response.text);
      await this.aiConversation.summarizeIfNeeded(session.senderId);
    }

    await this.send(adapter, session.senderId, flow.continuePrompt);
    this.sessionService.setState(session.senderId, 'IDLE');
  }

  // ─── Full AI mode ────────────────────────────────────────────

  private async handleFullAiMode(
    incoming: IncomingMessage,
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<void> {
    const { identity, ai, escalation } = this.configLoader.botConfig;

    if (session.state === 'ESCALATED') {
      await this.send(
        adapter,
        session.senderId,
        this.configLoader.interpolate(escalation.alreadyEscalatedMessage, {
          developerName: identity.developerName,
        }),
      );
      return;
    }

    if (this.shouldEscalate(incoming.text)) {
      await this.escalate(incoming, session, adapter);
      return;
    }

    const query = incoming.text?.trim();
    if (!query) {
      return;
    }

    const baseSystemPrompt = this.configLoader.interpolate(ai.systemPrompt, {
      company: identity.company,
      developerName: identity.developerName,
      botName: identity.name,
      tone: identity.tone,
    });

    try {
      const response = await this.aiConversation.generateResponse({
        senderId: session.senderId,
        prompt: query,
        systemPrompt: baseSystemPrompt,
        history: session.history.slice(0, -1),
        useKnowledge: ai.useKnowledge,
      });
      this.sessionService.addToHistory(session.senderId, 'assistant', response.text);
      await this.send(adapter, session.senderId, response.text);
      await this.aiConversation.summarizeIfNeeded(session.senderId);
    } catch (error) {
      this.logger.error(`AI generation failed for ${session.senderId}: ${(error as Error).message}`);
      const { identity } = this.configLoader.botConfig;
      await this.send(
        adapter,
        session.senderId,
        `Disculpá, compañero/a 🙏 En este momento estoy teniendo problemas para procesar tu consulta. Por favor intentá de nuevo en unos segundos, o escribí *menú* para volver al inicio.\n\nSi el problema persiste, podés contactar directamente a *${identity.developerName}*.`,
      );
    }
  }

  // ─── Escalation ──────────────────────────────────────────────

  private shouldEscalate(text: string | undefined): boolean {
    if (!text) return false;
    const normalized = text.toLowerCase();
    return this.configLoader.botConfig.escalation.keywords.some((kw) =>
      normalized.includes(kw.toLowerCase()),
    );
  }

  private async escalate(
    incoming: IncomingMessage,
    session: ConversationSession,
    adapter: MessageAdapter,
  ): Promise<void> {
    const { escalation, identity } = this.configLoader.botConfig;

    await this.send(
      adapter,
      session.senderId,
      this.configLoader.interpolate(escalation.clientMessage, {
        developerName: identity.developerName,
      }),
    );

    await this.send(
      adapter,
      this.botConfig.developerWhatsAppId,
      this.configLoader.interpolate(escalation.developerNotification, {
        clientName: session.clientName,
        clientPhone: incoming.senderId.replace('@c.us', '').replace('@lid', ''),
        message: incoming.text || '[media]',
      }),
    );

    this.sessionService.setState(session.senderId, 'ESCALATED');
    this.logger.log(`Escalated ${session.senderId} to developer`);
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private async send(adapter: MessageAdapter, recipientId: string, text: string): Promise<void> {
    await adapter.sendMessage({ recipientId, text });
  }
}
