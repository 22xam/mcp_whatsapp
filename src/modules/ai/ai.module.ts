import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeminiProvider } from './providers/gemini.provider';
import { OllamaProvider } from './providers/ollama.provider';
import { AI_PROVIDER, EMBEDDING_PROVIDER } from '../core/tokens/injection-tokens';
import { AppConfigModule } from '../config/config.module';
import { BotConfigService } from '../config/bot-config.service';

@Module({
  imports: [HttpModule, AppConfigModule],
  providers: [
    GeminiProvider,
    OllamaProvider,
    {
      provide: AI_PROVIDER,
      inject: [BotConfigService, GeminiProvider, OllamaProvider],
      useFactory: (config: BotConfigService, gemini: GeminiProvider, ollama: OllamaProvider) => {
        return config.aiProvider === 'ollama' ? ollama : gemini;
      },
    },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [BotConfigService, GeminiProvider, OllamaProvider],
      useFactory: (config: BotConfigService, gemini: GeminiProvider, ollama: OllamaProvider) => {
        return config.aiProvider === 'ollama' ? ollama : gemini;
      },
    },
  ],
  exports: [AI_PROVIDER, EMBEDDING_PROVIDER, GeminiProvider, OllamaProvider],
})
export class AiModule {}
