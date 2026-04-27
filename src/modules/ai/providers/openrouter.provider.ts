import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AIProvider, AIGenerateRequest, AIGenerateResponse, EmbeddingProvider } from '../../core/interfaces/ai-provider.interface';
import { BotConfigService } from '../../config/bot-config.service';
import { ConfigLoaderService } from '../../config/config-loader.service';

type OpenRouterRole = 'system' | 'user' | 'assistant';

interface OpenRouterTextContent {
  type: 'text';
  text: string;
}

interface OpenRouterImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

type OpenRouterMessageContent = string | Array<OpenRouterTextContent | OpenRouterImageContent>;

interface OpenRouterMessage {
  role: OpenRouterRole;
  content: OpenRouterMessageContent;
}

interface OpenRouterChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
  usage?: Record<string, unknown>;
}

interface OpenRouterEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  pricing?: Record<string, string>;
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

interface OpenRouterAttemptResult {
  response: AIGenerateResponse;
  model: string;
  latencyMs: number;
}

interface OpenRouterAttemptError {
  model: string;
  error: string;
  latencyMs: number;
}

@Injectable()
export class OpenRouterProvider implements AIProvider, EmbeddingProvider {
  readonly providerName = 'OpenRouter';
  private readonly logger = new Logger(OpenRouterProvider.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly botConfig: BotConfigService,
    private readonly configLoader: ConfigLoaderService,
  ) {}

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    const startedAt = Date.now();
    const { ai, identity } = this.configLoader.botConfig;
    const models = this.modelsWithFallbacks(ai.model);
    const raceMode = this.botConfig.openRouterRaceModels && models.length > 1;
    this.logger.debug(
      `OpenRouter generate start — models=${models.join(', ')} race=${raceMode} ` +
        `promptChars=${request.prompt.length} history=${request.history?.length ?? 0} timeoutMs=${this.botConfig.openRouterTimeoutMs}`,
    );

    const systemPrompt =
      request.systemPrompt ??
      this.configLoader.interpolate(ai.systemPrompt, {
        company: identity.company,
        developerName: identity.developerName,
        botName: identity.name,
        tone: identity.tone,
      });

    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(request.history ?? []).map((h) => ({
        role: h.role,
        content: h.content,
      })),
      {
        role: 'user',
        content: this.buildUserContent(request),
      },
    ];

    if (raceMode) {
      return this.generateRace(models, messages, startedAt);
    }

    return this.generateSequential(models, messages, startedAt);
  }

  async embed(text: string): Promise<number[]> {
    const { ai } = this.configLoader.botConfig;
    const body: Record<string, unknown> = {
      model: ai.embeddingModel,
      input: text,
    };

    if (this.botConfig.openRouterEmbeddingDimensions) {
      body.dimensions = this.botConfig.openRouterEmbeddingDimensions;
    }

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<OpenRouterEmbeddingResponse>(
          `${this.botConfig.openRouterBaseUrl}/embeddings`,
          body,
          { headers: this.headers() },
        ),
      );

      const embedding = data.data?.[0]?.embedding;
      if (!embedding) {
        throw new Error('OpenRouter returned no embedding vector');
      }
      return embedding;
    } catch (error: any) {
      const msg = error.response?.data?.error?.message || error.response?.data?.message || error.message || 'Unknown error';
      this.logger.error(`OpenRouter embedding failed: ${msg}`);
      throw new Error(`Embedding error: ${msg}`);
    }
  }

  async listModels(outputModalities = 'text'): Promise<OpenRouterModel[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<OpenRouterModelsResponse>(
        `${this.botConfig.openRouterBaseUrl}/models`,
        {
          headers: this.headers(Boolean(this.botConfig.openRouterApiKeyOptional)),
          params: { output_modalities: outputModalities },
        },
      ),
    );
    return data.data ?? [];
  }

  async listChatModels(): Promise<OpenRouterModel[]> {
    const models = await this.listModels('text');
    return models.filter((model) => {
      const output = model.architecture?.output_modalities ?? [];
      return output.length === 0 || output.includes('text');
    });
  }

  async listEmbeddingModels(): Promise<OpenRouterModel[]> {
    const models = await this.listModels('embeddings');
    return models.filter((model) => {
      const output = model.architecture?.output_modalities ?? [];
      return output.includes('embedding') || output.includes('embeddings');
    });
  }

  private buildUserContent(request: AIGenerateRequest): OpenRouterMessageContent {
    if (!request.imageBase64 || !request.imageMimeType) {
      return request.prompt;
    }

    return [
      { type: 'text', text: request.prompt },
      {
        type: 'image_url',
        image_url: {
          url: `data:${request.imageMimeType};base64,${request.imageBase64}`,
        },
      },
    ];
  }

  private extractText(data: OpenRouterChatResponse): string {
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => part.text ?? '').join('');
    }
    return '';
  }

  private async generateRace(
    models: string[],
    messages: OpenRouterMessage[],
    startedAt: number,
  ): Promise<AIGenerateResponse> {
    this.logger.debug(`Racing ${models.length} OpenRouter models: ${models.join(', ')}`);
    const errors: OpenRouterAttemptError[] = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      let remaining = models.length;

      for (const model of models) {
        void this.tryModel(model, messages, this.botConfig.openRouterTimeoutMs)
          .then((result) => {
            if (settled) return;
            settled = true;
            this.logger.log(
              `OpenRouter race winner="${result.model}" totalMs=${Date.now() - startedAt} ` +
                `modelMs=${result.latencyMs} chars=${result.response.text.length} remaining=${remaining - 1}/${models.length}`,
            );
            resolve({
              ...result.response,
              metadata: {
                ...result.response.metadata,
                raceMode: true,
                raceModels: models,
                winnerModel: result.model,
                latencyMs: result.latencyMs,
              },
            });
          })
          .catch((err: OpenRouterAttemptError) => {
            errors.push(err);
            remaining--;
            if (!settled && remaining === 0) {
              settled = true;
              const allFailed = this.buildAllModelsFailedError(errors);
              this.logger.error(`OpenRouter race failed after ${Date.now() - startedAt}ms — ${allFailed.message}`);
              reject(allFailed);
            }
          });
      }
    });
  }

  private async generateSequential(
    models: string[],
    messages: OpenRouterMessage[],
    startedAt: number,
  ): Promise<AIGenerateResponse> {
    const attempts: OpenRouterAttemptError[] = [];

    for (const model of models) {
      try {
        const result = await this.tryModel(model, messages);
        this.logger.log(
          `OpenRouter generate success — model=${result.model} totalMs=${Date.now() - startedAt} ` +
            `modelMs=${result.latencyMs} chars=${result.response.text.length}`,
        );
        return result.response;
      } catch (error) {
        attempts.push(error as OpenRouterAttemptError);
      }
    }

    const error = this.buildAllModelsFailedError(attempts);
    this.logger.error(`OpenRouter generate failed after ${Date.now() - startedAt}ms — ${error.message}`);
    throw error;
  }

  private async tryModel(
    model: string,
    messages: OpenRouterMessage[],
    timeoutMs = this.botConfig.openRouterTimeoutMs,
  ): Promise<OpenRouterAttemptResult> {
    const startedAt = Date.now();
    this.logger.debug(`Sending prompt to OpenRouter model "${model}"`);

    const requestPromise = firstValueFrom(
      this.httpService.post<OpenRouterChatResponse>(
        `${this.botConfig.openRouterBaseUrl}/chat/completions`,
        { model, messages },
        { headers: this.headers(), timeout: timeoutMs },
      ),
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs),
    );

    try {
      const { data } = await Promise.race([requestPromise, timeoutPromise]);
      const latencyMs = Date.now() - startedAt;
      return {
        model,
        latencyMs,
        response: {
          text: this.extractText(data),
          metadata: {
            id: data.id,
            model: data.model ?? model,
            requestedModel: model,
            usage: data.usage,
            latencyMs,
          },
        },
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startedAt;
      const msg = error.response?.data?.error?.message || error.response?.data?.message || error.message || 'Unknown error';
      this.logger.warn(`OpenRouter model "${model}" failed in ${latencyMs}ms: ${msg}`);
      throw { model, error: msg, latencyMs } satisfies OpenRouterAttemptError;
    }
  }

  private buildAllModelsFailedError(attempts: OpenRouterAttemptError[]): Error {
    const details = attempts.map((attempt) => `${attempt.model}: ${attempt.error}`).join(' | ');
    return new Error(`AI provider error: all OpenRouter models failed. ${details}`);
  }

  private modelsWithFallbacks(primaryModel: string): string[] {
    const fallbackModels = this.openRouterFallbackModels();
    return Array.from(new Set([primaryModel, ...fallbackModels].filter(Boolean)));
  }

  private openRouterFallbackModels(): string[] {
    const aiConfig = this.configLoader.botConfig.ai as { fallbackModels?: string[] | string };
    const fromConfig = aiConfig.fallbackModels;
    const rawModels = Array.isArray(fromConfig)
      ? fromConfig
      : typeof fromConfig === 'string'
        ? fromConfig.split(',')
        : (process.env.OPENROUTER_FALLBACK_MODELS ?? '').split(',');

    return rawModels.map((model) => model.trim()).filter(Boolean);
  }

  private headers(includeAuth = true): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Title': this.botConfig.openRouterAppName,
    };

    if (includeAuth) {
      headers.Authorization = `Bearer ${this.botConfig.openRouterApiKey}`;
    }

    if (this.botConfig.openRouterSiteUrl) {
      headers['HTTP-Referer'] = this.botConfig.openRouterSiteUrl;
    }

    return headers;
  }
}
