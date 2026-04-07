import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AIProvider, AIGenerateRequest, AIGenerateResponse, EmbeddingProvider } from '../../core/interfaces/ai-provider.interface';
import { BotConfigService } from '../../config/bot-config.service';
import { ConfigLoaderService } from '../../config/config-loader.service';

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
}

interface OllamaEmbedResponse {
  embedding: number[];
}

@Injectable()
export class OllamaProvider implements AIProvider, EmbeddingProvider {
  readonly providerName = 'Ollama';
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly botConfig: BotConfigService,
    private readonly configLoader: ConfigLoaderService,
  ) {}

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    const url = `${this.botConfig.ollamaUrl}/api/generate`;
    const { ai, identity } = this.configLoader.botConfig;
    const model = ai.model;

    const systemPrompt =
      request.systemPrompt ??
      this.configLoader.interpolate(ai.systemPrompt, {
        company: identity.company,
        developerName: identity.developerName,
        botName: identity.name,
        tone: identity.tone,
      });

    const historyText =
      request.history && request.history.length > 0
        ? request.history
            .map((h) => `${h.role === 'user' ? 'Usuario' : 'Asistente'}: ${h.content}`)
            .join('\n') + '\n'
        : '';

    const fullPrompt = `${systemPrompt}\n\n${historyText}Usuario: ${request.prompt}`;

    this.logger.debug(`Sending prompt to Ollama model "${model}"`);

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<OllamaGenerateResponse>(url, {
          model,
          prompt: fullPrompt,
          stream: false,
        }),
      );

      this.logger.debug('Received response from Ollama');
      return {
        text: data.response,
        metadata: { model: data.model, done: data.done },
      };
    } catch (error) {
      this.logger.error(`Failed to communicate with Ollama: ${(error as Error).message}`);
      throw new Error(`AI provider error: ${(error as Error).message}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const url = `${this.botConfig.ollamaUrl}/api/embeddings`;
    const model = this.configLoader.botConfig.ai.embeddingModel;

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<OllamaEmbedResponse>(url, { model, prompt: text }),
      );
      return data.embedding;
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message || 'Unknown error';
      this.logger.error(`Ollama embedding failed: ${msg}`);
      throw new Error(`Embedding error: ${msg}`);
    }
  }
}
