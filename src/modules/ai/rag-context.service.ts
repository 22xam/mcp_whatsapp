import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { KnowledgeService, type KnowledgeSearchResult } from '../knowledge/knowledge.service';

interface KnowledgeSearchClient {
  search(query: string, allowedSources?: string[]): Promise<KnowledgeSearchResult | null>;
  searchMany?: (query: string, allowedSources?: string[], limit?: number) => Promise<KnowledgeSearchResult[]>;
}

export interface RagContextRequest {
  query: string;
  allowedSources?: string[];
  maxResults?: number;
  instruction?: string;
}

export interface RagCitation {
  index: number;
  label: string;
  source: string;
  score?: number;
  content: string;
}

export interface RagContextResponse {
  found: boolean;
  promptSection: string;
  citations: RagCitation[];
}

@Injectable()
export class RagContextService implements OnModuleInit {
  private readonly logger = new Logger(RagContextService.name);
  private knowledgeService?: KnowledgeSearchClient;

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    this.resolveKnowledgeService();
  }

  async buildContext(request: RagContextRequest): Promise<RagContextResponse> {
    const service = this.resolveKnowledgeService();
    if (!service) {
      return this.emptyContext();
    }

    const results = await this.searchKnowledge(service, request);
    if (!results.length) {
      return this.emptyContext();
    }

    const citations = results.map((result, index) => ({
      index: index + 1,
      label: `S${index + 1}`,
      source: result.source,
      score: result.score,
      content: result.content,
    }));

    return {
      found: true,
      citations,
      promptSection: this.formatPromptSection(citations, request.instruction),
    };
  }

  formatCitations(citations: RagCitation[]): string {
    return citations
      .map((citation) => {
        const score = typeof citation.score === 'number' ? ` | relevancia: ${citation.score.toFixed(3)}` : '';
        return `[${citation.label}] Fuente: ${citation.source}${score}\n${citation.content.trim()}`;
      })
      .join('\n\n');
  }

  private resolveKnowledgeService(): KnowledgeSearchClient | undefined {
    if (this.knowledgeService) {
      return this.knowledgeService;
    }

    try {
      this.knowledgeService = this.moduleRef.get(KnowledgeService, { strict: false });
    } catch {
      this.logger.warn('KnowledgeService not available; RAG context will be disabled');
    }

    return this.knowledgeService;
  }

  private async searchKnowledge(
    service: KnowledgeSearchClient,
    request: RagContextRequest,
  ): Promise<KnowledgeSearchResult[]> {
    const limit = Math.max(1, request.maxResults ?? 1);

    if (service.searchMany) {
      const many = await service.searchMany(request.query, request.allowedSources, limit);
      return many.filter(Boolean).slice(0, limit);
    }

    const single = await service.search(request.query, request.allowedSources);
    return single ? [single] : [];
  }

  private formatPromptSection(citations: RagCitation[], instruction?: string): string {
    const formattedCitations = this.formatCitations(citations);
    const customInstruction = instruction?.trim();

    return [
      'Contexto de conocimiento disponible:',
      formattedCitations,
      'Instrucciones RAG:',
      '- Respondé usando el contexto cuando sea relevante.',
      '- Citá las fuentes usadas con el formato [S1], [S2], etc.',
      '- No cites fuentes que no aparezcan en el contexto.',
      '- Si el contexto no alcanza para responder con certeza, aclaralo sin inventar datos.',
      customInstruction,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private emptyContext(): RagContextResponse {
    return {
      found: false,
      promptSection: '',
      citations: [],
    };
  }
}
