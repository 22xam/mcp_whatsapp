import { Inject, Injectable } from '@nestjs/common';
import type { AIGenerateRequest, AIGenerateResponse, AIProvider } from '../core/interfaces/ai-provider.interface';
import { AI_PROVIDER } from '../core/tokens/injection-tokens';
import { ConfigLoaderService } from '../config/config-loader.service';
import { RagContextService, type RagCitation } from './rag-context.service';
import { ConversationMemoryService } from '../session/conversation-memory.service';

export interface AiConversationRequest extends Omit<AIGenerateRequest, 'systemPrompt'> {
  systemPrompt?: string;
  useKnowledge?: boolean;
  allowedSources?: string[];
  ragContextInstruction?: string;
  senderId?: string;
}

export interface AiConversationResponse extends AIGenerateResponse {
  rag: {
    used: boolean;
    citations: RagCitation[];
  };
}

@Injectable()
export class AiConversationService {
  constructor(
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
    private readonly configLoader: ConfigLoaderService,
    private readonly ragContext: RagContextService,
    private readonly memory: ConversationMemoryService,
  ) {}

  async generateResponse(request: AiConversationRequest): Promise<AiConversationResponse> {
    const baseSystemPrompt = this.resolveSystemPrompt(request.systemPrompt);
    const rag = request.useKnowledge
      ? await this.ragContext.buildContext({
          query: request.prompt,
          allowedSources: request.allowedSources,
          maxResults: this.configLoader.botConfig.ai.ragTopK,
          instruction: request.ragContextInstruction,
        })
      : { found: false, promptSection: '', citations: [] };

    const memoryContext = this.buildMemoryContext(request.senderId);
    const systemPromptParts = [baseSystemPrompt];
    if (memoryContext) systemPromptParts.push(memoryContext);
    if (rag.found) systemPromptParts.push(rag.promptSection);
    const systemPrompt = systemPromptParts.join('\n\n');

    const response = await this.aiProvider.generate({
      ...request,
      systemPrompt,
      history: this.buildHistory(request),
    });

    const citations = rag.citations;
    const text = rag.found ? this.appendSources(response.text, citations) : response.text;

    return {
      ...response,
      text,
      rag: {
        used: rag.found,
        citations,
      },
    };
  }

  async generate(request: AiConversationRequest): Promise<AiConversationResponse> {
    return this.generateResponse(request);
  }

  async summarizeIfNeeded(senderId: string): Promise<void> {
    const { ai } = this.configLoader.botConfig;
    if (ai.memoryEnabled === false) return;

    const threshold = ai.memorySummaryThreshold ?? 24;
    const memory = this.memory.getContext(senderId, 1);
    if (memory.unsummarizedCount < threshold) return;

    const previousSummary = this.memory.getSummary(senderId);
    const messages = this.memory.getUnsummarizedMessages(senderId);
    const transcript = messages.map((message) => `${message.role}: ${message.content}`).join('\n');
    const prompt = [
      'Resume esta conversación para que otro asistente pueda continuarla sin perder contexto.',
      'Conserva nombres, preferencias, problemas pendientes, decisiones y datos operativos importantes.',
      previousSummary ? `Resumen anterior:\n${previousSummary}` : '',
      `Mensajes nuevos:\n${transcript}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await this.aiProvider.generate({
      prompt,
      systemPrompt: 'Sos un asistente que resume conversaciones de soporte y ventas de forma breve y factual.',
    });
    this.memory.saveSummary(senderId, response.text.trim(), messages.length);
  }

  private resolveSystemPrompt(systemPrompt?: string): string {
    if (systemPrompt) return systemPrompt;

    const { ai, identity } = this.configLoader.botConfig;
    return this.configLoader.interpolate(ai.systemPrompt, {
      company: identity.company,
      developerName: identity.developerName,
      botName: identity.name,
      tone: identity.tone,
    });
  }

  private buildMemoryContext(senderId?: string): string | null {
    const { ai } = this.configLoader.botConfig;
    if (!senderId || ai.memoryEnabled === false) return null;

    const summary = this.memory.getSummary(senderId);
    if (!summary) return null;
    return `Memoria persistente de esta conversación:\n${summary}`;
  }

  private appendSources(text: string, citations: RagCitation[]): string {
    if (!citations.length) return text;
    if (/fuentes\s*:/i.test(text)) return text;

    const sources = citations
      .map((citation) => `[${citation.label}] ${citation.source}`)
      .join(', ');
    return `${text.trim()}\n\nFuentes: ${sources}`;
  }

  private buildHistory(request: AiConversationRequest): AIGenerateRequest['history'] {
    const { ai } = this.configLoader.botConfig;
    if (request.senderId && ai.memoryEnabled !== false) {
      const recentLimit = ai.memoryRecentMessages ?? ai.maxHistoryMessages;
      const context = this.memory.getContext(request.senderId, recentLimit);
      return this.limitHistory(context.recentMessages);
    }

    return this.limitHistory(request.history);
  }

  private limitHistory(history: AIGenerateRequest['history']): AIGenerateRequest['history'] {
    const maxHistoryMessages = this.configLoader.botConfig.ai.maxHistoryMessages;
    if (!history || maxHistoryMessages <= 0) {
      return history;
    }
    return history.slice(-maxHistoryMessages);
  }
}
