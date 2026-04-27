import Joi from 'joi';

/**
 * Joi validation schema for .env variables.
 * Only secrets and infrastructure config live here.
 * All bot behavior config lives in config/*.json
 */
export const botConfigSchema = Joi.object({
  PORT: Joi.number().default(3000),
  BOT_OSCAR_DB_PATH: Joi.string().optional(),
  WHATSAPP_ENABLED: Joi.boolean().default(true),
  WHATSAPP_SESSION_ID: Joi.string().allow('').optional(),
  CAMPAIGN_WORKER_ENABLED: Joi.boolean().default(true),
  CAMPAIGN_WORKER_INTERVAL_MS: Joi.number().integer().min(1000).default(5000),
  BOT_OSCAR_ADMIN_TOKEN: Joi.string().allow('').optional(),

  // ── Gemini ───────────────────────────────────────────────────
  GEMINI_API_KEY: Joi.string()
    .empty('')
    .when('AI_PROVIDER', {
      is: 'gemini',
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .description('Google Gemini API key'),

  // ── Ollama (optional, kept for backwards compat) ─────────────
  OLLAMA_URL: Joi.string().uri().default('http://localhost:11434'),
  OLLAMA_MODEL: Joi.string().default('qwen3:8b'),
  OLLAMA_AUTO_START: Joi.boolean().default(false),

  // OpenRouter
  OPENROUTER_API_KEY: Joi.string()
    .empty('')
    .when('AI_PROVIDER', {
      is: 'openrouter',
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .description('OpenRouter API key'),
  OPENROUTER_BASE_URL: Joi.string().uri().default('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: Joi.string().uri().allow('').optional(),
  OPENROUTER_APP_NAME: Joi.string().default('BOT-Oscar'),
  OPENROUTER_EMBEDDING_DIMENSIONS: Joi.number().integer().positive().optional(),
  OPENROUTER_TIMEOUT_MS: Joi.number().integer().min(1000).default(60000),
  OPENROUTER_RACE_MODELS: Joi.boolean().default(true),

  // ── AI provider selection ────────────────────────────────────
  AI_PROVIDER: Joi.string().valid('gemini', 'ollama', 'openrouter').default('gemini'),

  // ── Developer contact (secrets, not in JSON) ─────────────────
  DEVELOPER_NAME: Joi.string().required(),
  DEVELOPER_PHONE: Joi.string().pattern(/^\d+$/, 'digits only').required(),

  // ── Control group (optional) ─────────────────────────────────
  // WhatsApp group ID used to send control commands to the bot.
  // Format: <digits>@g.us  — obtain it by running the bot and sending !grupos from any group.
  CONTROL_GROUP_ID: Joi.string().optional(),
});
