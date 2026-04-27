export type CampaignAudienceMode = 'all' | 'phones' | 'systems' | 'companies' | 'tags';

export interface CampaignAudience {
  mode: CampaignAudienceMode;
  phones?: string[];
  systems?: string[];
  companies?: string[];
  tags?: string[];
}

export interface CampaignRateLimitConfig {
  delayMs: number;
  maxPerRun?: number;
}

export interface CampaignRetryConfig {
  maxAttempts: number;
  backoffMs: number;
}

export interface CampaignOptOutConfig {
  enabled: boolean;
  keywords: string[];
  confirmationMessage: string;
}

/**
 * 'ai'       → genera el mensaje con IA usando aiPrompt + systemPrompt
 * 'template' → usa un mensaje fijo con variables {name}, {company}, {phone}, {systems}, {tags}
 * Si se omite, se infiere: template presente → 'template', aiPrompt presente → 'ai'
 */
export type CampaignMessageMode = 'ai' | 'template';

export interface CampaignConfig {
  id: string;
  name: string;
  enabled: boolean;
  audience: CampaignAudience;
  messageMode?: CampaignMessageMode;
  template?: string;
  aiPrompt?: string;
  systemPrompt?: string;
  rateLimit: CampaignRateLimitConfig;
  retry: CampaignRetryConfig;
  optOut?: CampaignOptOutConfig;
}
