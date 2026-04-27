import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import type { AIProvider, AIGenerateRequest, AIGenerateResponse } from '../../core/interfaces/ai-provider.interface';
import { BotConfigService } from '../../config/bot-config.service';
import { ConfigLoaderService } from '../../config/config-loader.service';

@Injectable()
export class GeminiProvider implements AIProvider, OnModuleInit {
  readonly providerName = 'Gemini';
  private readonly logger = new Logger(GeminiProvider.name);
  private genAI?: GoogleGenAI;
  private modelName: string;
  private embeddingModelName: string;

  constructor(
    private readonly botConfig: BotConfigService,
    private readonly configLoader: ConfigLoaderService,
  ) {}

  onModuleInit(): void {
    this.modelName = this.configLoader.botConfig.ai.model;
    this.embeddingModelName = this.configLoader.botConfig.ai.embeddingModel;
    if (this.botConfig.aiProvider === 'gemini') {
      this.genAI = new GoogleGenAI({ apiKey: this.requireApiKey(), apiVersion: 'v1' });
    }
    this.logger.log(`Gemini initialized - model: ${this.modelName}`);
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    const { ai, identity } = this.configLoader.botConfig;

    const systemPrompt =
      request.systemPrompt ??
      this.configLoader.interpolate(ai.systemPrompt, {
        company: identity.company,
        developerName: identity.developerName,
        botName: identity.name,
        tone: identity.tone,
      });

    const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [];

    if (request.imageBase64 && request.imageMimeType) {
      parts.push({
        inlineData: {
          data: request.imageBase64,
          mimeType: request.imageMimeType,
        },
      });
    }

    parts.push({ text: `${systemPrompt}\n\nUsuario: ${request.prompt}` });

    this.logger.debug(`Generating response${request.imageBase64 ? ' (with image)' : ''}`);

    const maxAttempts = 3;
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.getClient().models.generateContent({
          model: this.modelName,
          contents: [{ role: 'user', parts }],
        });
        return {
          text: result.text ?? '',
          metadata: { model: ai.model },
        };
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Gemini attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    this.logger.error(`Gemini generation failed after ${maxAttempts} attempts: ${lastError.message}`);
    throw new Error(`AI provider error: ${lastError.message}`);
  }

  async embed(text: string): Promise<number[]> {
    try {
      const result = await this.getClient().models.embedContent({
        model: this.embeddingModelName,
        contents: text,
      });
      return result.embeddings?.[0]?.values ?? [];
    } catch (error) {
      this.logger.error(`Gemini embedding failed: ${(error as Error).message}`);
      throw new Error(`Embedding error: ${(error as Error).message}`);
    }
  }

  private getClient(): GoogleGenAI {
    if (!this.genAI) {
      this.genAI = new GoogleGenAI({ apiKey: this.requireApiKey(), apiVersion: 'v1' });
    }
    return this.genAI;
  }

  private requireApiKey(): string {
    const apiKey = this.botConfig.geminiApiKey;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required when AI_PROVIDER=gemini');
    }
    return apiKey;
  }
}
