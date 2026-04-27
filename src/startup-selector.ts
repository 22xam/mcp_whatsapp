/**
 * Interactive AI provider + model selector that runs before NestJS boots.
 * Reads current .env, lets the user pick provider and model, then patches
 * process.env so ConfigService picks up the new values without touching disk.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const DIM = '\x1b[2m';

function print(text: string) {
  process.stdout.write(text + '\n');
}
function header(text: string) {
  print(`\n${BOLD}${CYAN}${text}${RESET}`);
}
function info(text: string) {
  print(`  ${WHITE}${text}${RESET}`);
}
function ok(text: string) {
  print(`  ${GREEN}✔ ${text}${RESET}`);
}
function warn(text: string) {
  print(`  ${YELLOW}⚠ ${text}${RESET}`);
}
function err(text: string) {
  print(`  ${RED}✖ ${text}${RESET}`);
}
function dim(text: string) {
  print(`  ${DIM}${text}${RESET}`);
}

function banner() {
  print('');
  print(`${BOLD}${RED}╔══════════════════════════════════════════╗${RESET}`);
  print(`${BOLD}${RED}║             🤖  BOT-Oscar                ║${RESET}`);
  print(`${BOLD}${RED}║       Configuración de Proveedor IA      ║${RESET}`);
  print(`${BOLD}${RED}╚══════════════════════════════════════════╝${RESET}`);
  print('');
  return 'bot';
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) =>
    rl.question(question, (ans) => resolve(ans.trim())),
  );
}

function askNumber(
  rl: readline.Interface,
  prompt: string,
  max: number,
): Promise<number> {
  return new Promise((resolve) => {
    const attempt = () => {
      rl.question(prompt, (ans) => {
        const n = parseInt(ans.trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= max) {
          resolve(n);
        } else {
          warn(`Ingresá un número entre 1 y ${max}`);
          attempt();
        }
      });
    };
    attempt();
  });
}

// ─── .env reader/writer ───────────────────────────────────────────────────────

function readEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return result;
}

function writeEnv(values: Record<string, string>) {
  const envPath = path.join(process.cwd(), '.env');
  const existing = readEnv();
  const merged = { ...existing, ...values };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
  // Also patch process.env so NestJS picks up changes in the same process
  for (const [k, v] of Object.entries(values)) {
    process.env[k] = v;
  }
}

// ─── HTTP helper (uses Node https/http to respect NODE_TLS_REJECT_UNAUTHORIZED) ──

function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      rejectUnauthorized: false,
    };
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

// ─── Provider model fetchers ──────────────────────────────────────────────────

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const body = await httpGet(`${baseUrl}/api/tags`);
    const data = JSON.parse(body) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch (e) {
    warn(`Ollama no disponible: ${(e as Error).message}`);
    return [];
  }
}

async function fetchOpenRouterModels(
  apiKey: string,
): Promise<Array<{ id: string; name: string; free: boolean }>> {
  try {
    const body = await httpGet('https://openrouter.ai/api/v1/models', {
      Authorization: `Bearer ${apiKey}`,
    });
    const data = JSON.parse(body) as {
      data?: Array<{ id: string; name?: string; pricing?: { prompt: string } }>;
    };
    if (!data.data) {
      warn(`Respuesta inesperada de OpenRouter: ${body.slice(0, 200)}`);
      return [];
    }
    return data.data
      .filter((m) => m.id)
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        free: m.pricing?.prompt === '0',
      }))
      .sort((a, b) => {
        if (a.free && !b.free) return -1;
        if (!a.free && b.free) return 1;
        return a.id.localeCompare(b.id);
      });
  } catch (e) {
    warn(`Error consultando OpenRouter: ${(e as Error).message}`);
    return [];
  }
}

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

// ─── Provider flows ───────────────────────────────────────────────────────────

async function configureGemini(
  rl: readline.Interface,
  env: Record<string, string>,
): Promise<void> {
  header('📦 Proveedor: Google Gemini');

  let apiKey = env['GEMINI_API_KEY'] ?? '';
  if (apiKey) {
    ok(`API Key detectada: ${apiKey.slice(0, 8)}...`);
    const change = await ask(rl, `  ¿Cambiarla? (s/N): `);
    if (change.toLowerCase() === 's') apiKey = '';
  }

  if (!apiKey) {
    apiKey = await ask(rl, `  ${CYAN}Pegá tu Gemini API Key: ${RESET}`);
  }

  header('🤖 Modelos disponibles');
  GEMINI_MODELS.forEach((m, i) => info(`  ${BOLD}${i + 1}.${RESET} ${m}`));
  const choice = await askNumber(
    rl,
    `\n  ${CYAN}Elegí un modelo (1-${GEMINI_MODELS.length}): ${RESET}`,
    GEMINI_MODELS.length,
  );
  const model = GEMINI_MODELS[choice - 1];

  writeEnv({
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: apiKey,
  });

  // Update bot.config.json model
  patchBotConfigModel(model, 'text-embedding-004');

  ok(`Gemini configurado → modelo: ${BOLD}${model}${RESET}`);
}

async function configureOllama(
  rl: readline.Interface,
  env: Record<string, string>,
): Promise<void> {
  header('📦 Proveedor: Ollama (local)');

  const defaultUrl = env['OLLAMA_URL'] ?? 'http://localhost:11434';
  const urlInput = await ask(
    rl,
    `  ${CYAN}URL de Ollama [${defaultUrl}]: ${RESET}`,
  );
  const ollamaUrl = urlInput || defaultUrl;

  info('Consultando modelos instalados...');
  const models = await fetchOllamaModels(ollamaUrl);

  if (models.length === 0) {
    warn('No se encontraron modelos en Ollama o no está corriendo.');
    warn(`Asegurate de tener Ollama corriendo en ${ollamaUrl}`);
    const manual = await ask(
      rl,
      `  ${CYAN}Ingresá el nombre del modelo manualmente: ${RESET}`,
    );
    writeEnv({ AI_PROVIDER: 'ollama', OLLAMA_URL: ollamaUrl });
    patchBotConfigModel(manual, manual);
    ok(`Ollama configurado → modelo: ${BOLD}${manual}${RESET}`);
    return;
  }

  header('🤖 Modelos instalados en Ollama');
  models.forEach((m, i) => info(`  ${BOLD}${i + 1}.${RESET} ${m}`));
  const choice = await askNumber(
    rl,
    `\n  ${CYAN}Elegí un modelo (1-${models.length}): ${RESET}`,
    models.length,
  );
  const model = models[choice - 1];

  writeEnv({ AI_PROVIDER: 'ollama', OLLAMA_URL: ollamaUrl });
  patchBotConfigModel(model, model);

  ok(`Ollama configurado → modelo: ${BOLD}${model}${RESET}`);
}

async function configureOpenRouter(
  rl: readline.Interface,
  env: Record<string, string>,
): Promise<void> {
  header('📦 Proveedor: OpenRouter');

  let apiKey = env['OPENROUTER_API_KEY'] ?? '';
  if (apiKey) {
    ok(`API Key detectada: ${apiKey.slice(0, 12)}...`);
    const change = await ask(rl, `  ¿Cambiarla? (s/N): `);
    if (change.toLowerCase() === 's') apiKey = '';
  }

  if (!apiKey) {
    apiKey = await ask(rl, `  ${CYAN}Pegá tu OpenRouter API Key: ${RESET}`);
  }

  info('Consultando modelos en OpenRouter...');
  const models = await fetchOpenRouterModels(apiKey);

  if (models.length === 0) {
    err('No se pudieron obtener modelos. Verificá la API key y tu conexión.');
    const manual = await ask(
      rl,
      `  ${CYAN}Ingresá el ID del modelo manualmente (ej: minimax/minimax-m1): ${RESET}`,
    );
    writeEnv({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: apiKey });
    patchBotConfigModel(manual, 'text-embedding-004');
    ok(`OpenRouter configurado → modelo: ${BOLD}${manual}${RESET}`);
    return;
  }

  // Show free models first, then paginate
  const freeModels = models.filter((m) => m.free);
  const paidModels = models.filter((m) => !m.free);

  header(`🆓 Modelos GRATUITOS (${freeModels.length})`);
  freeModels
    .slice(0, 30)
    .forEach((m, i) =>
      info(
        `  ${BOLD}${i + 1}.${RESET} ${GREEN}[FREE]${RESET} ${m.id} ${DIM}${m.name !== m.id ? `— ${m.name}` : ''}${RESET}`,
      ),
    );

  const showPaid = await ask(rl, `\n  ¿Ver también modelos de pago? (s/N): `);
  let allDisplayed = [...freeModels.slice(0, 30)];

  if (showPaid.toLowerCase() === 's') {
    header(`💰 Modelos de pago (${paidModels.length} — mostrando primeros 50)`);
    paidModels
      .slice(0, 50)
      .forEach((m, i) =>
        info(
          `  ${BOLD}${freeModels.slice(0, 30).length + i + 1}.${RESET} ${m.id} ${DIM}${m.name !== m.id ? `— ${m.name}` : ''}${RESET}`,
        ),
      );
    allDisplayed = [...freeModels.slice(0, 30), ...paidModels.slice(0, 50)];
  }

  const choice = await askNumber(
    rl,
    `\n  ${CYAN}Elegí un modelo (1-${allDisplayed.length}): ${RESET}`,
    allDisplayed.length,
  );
  const selected = allDisplayed[choice - 1];

  writeEnv({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: apiKey });
  patchBotConfigModel(selected.id, 'text-embedding-004');

  ok(`OpenRouter configurado → modelo: ${BOLD}${selected.id}${RESET}`);
}

// ─── bot.config.json patcher ──────────────────────────────────────────────────

function patchBotConfigModel(model: string, embeddingModel: string) {
  const configPath = path.join(process.cwd(), 'config', 'bot.config.json');
  if (!fs.existsSync(configPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.ai = config.ai ?? {};
    config.ai.model = model;
    config.ai.embeddingModel = embeddingModel;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    warn('No se pudo actualizar bot.config.json — editalo manualmente.');
  }
}

// ─── Campaign configurator ────────────────────────────────────────────────────

interface CampaignEntry {
  id: string;
  name: string;
  enabled: boolean;
  messageMode?: string;
  template?: string;
  aiPrompt?: string;
  systemPrompt?: string;
  [key: string]: unknown;
}

function readCampaigns(): CampaignEntry[] {
  const p = path.join(process.cwd(), 'config', 'campaigns.json');
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CampaignEntry[];
  } catch {
    return [];
  }
}

function writeCampaigns(campaigns: CampaignEntry[]): void {
  const p = path.join(process.cwd(), 'config', 'campaigns.json');
  fs.writeFileSync(p, JSON.stringify(campaigns, null, 2), 'utf-8');
}

function resolveMode(c: CampaignEntry): string {
  if (c.messageMode) return c.messageMode;
  if (c.template) return 'template';
  return 'ai';
}

async function configureCampaigns(rl: readline.Interface): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const campaigns = readCampaigns();

    header('📣 Configuración de campañas');
    if (campaigns.length === 0) {
      warn('No hay campañas en config/campaigns.json');
      return;
    }

    campaigns.forEach((c, i) => {
      const mode = resolveMode(c);
      const estado = c.enabled
        ? `${GREEN}activa${RESET}`
        : `${RED}inactiva${RESET}`;
      const modeLabel =
        mode === 'template' ? `${YELLOW}Fijo${RESET}` : `${CYAN}IA${RESET}`;
      info(
        `  ${BOLD}${i + 1}.${RESET} ${c.name}  [${estado}]  modo: ${modeLabel}`,
      );
      dim(`       id: ${c.id}`);
    });
    info(`  ${BOLD}${campaigns.length + 1}.${RESET} Volver al menú principal`);

    const choice = await askNumber(
      rl,
      `\n  ${CYAN}Seleccioná una campaña (1-${campaigns.length + 1}): ${RESET}`,
      campaigns.length + 1,
    );
    if (choice === campaigns.length + 1) return;

    const campaign = campaigns[choice - 1];
    await editCampaign(rl, campaigns, campaign);
  }
}

async function editCampaign(
  rl: readline.Interface,
  all: CampaignEntry[],
  campaign: CampaignEntry,
): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const mode = resolveMode(campaign);
    const estado = campaign.enabled
      ? `${GREEN}activa${RESET}`
      : `${RED}inactiva${RESET}`;
    const modeLabel =
      mode === 'template'
        ? `${YELLOW}Fijo (template)${RESET}`
        : `${CYAN}IA (generado)${RESET}`;

    header(`✏️  ${campaign.name}`);
    dim(`     id: ${campaign.id}`);
    info('');
    info(`  ${BOLD}1.${RESET} Estado          → ${estado}`);
    info(`  ${BOLD}2.${RESET} Modo de mensaje → ${modeLabel}`);

    if (mode === 'template') {
      const preview = (campaign.template ?? '')
        .slice(0, 80)
        .replace(/\n/g, '↵');
      info(`  ${BOLD}3.${RESET} Editar mensaje fijo`);
      dim(
        `       ${preview}${(campaign.template ?? '').length > 80 ? '…' : ''}`,
      );
    } else {
      const preview = (campaign.aiPrompt ?? '')
        .slice(0, 80)
        .replace(/\n/g, '↵');
      info(`  ${BOLD}3.${RESET} Editar prompt de usuario (IA)`);
      dim(
        `       ${preview}${(campaign.aiPrompt ?? '').length > 80 ? '…' : ''}`,
      );
      info(`  ${BOLD}4.${RESET} Editar prompt de sistema (IA)`);
      const sysPreview = (campaign.systemPrompt ?? '')
        .slice(0, 60)
        .replace(/\n/g, '↵');
      dim(
        `       ${sysPreview}${(campaign.systemPrompt ?? '').length > 60 ? '…' : ''}`,
      );
    }

    const maxOpt = mode === 'template' ? 4 : 5;
    info(`  ${BOLD}${maxOpt - 1}.${RESET} Guardar y volver`);
    info(`  ${BOLD}${maxOpt}.${RESET} Volver sin guardar`);

    const opt = await askNumber(
      rl,
      `\n  ${CYAN}Opción (1-${maxOpt}): ${RESET}`,
      maxOpt,
    );

    if (opt === maxOpt) return; // volver sin guardar

    if (opt === maxOpt - 1) {
      // guardar
      const idx = all.findIndex((c) => c.id === campaign.id);
      if (idx !== -1) all[idx] = campaign;
      writeCampaigns(all);
      ok(`Campaña "${campaign.name}" guardada.`);
      return;
    }

    if (opt === 1) {
      // toggle estado
      campaign.enabled = !campaign.enabled;
      ok(`Estado cambiado a: ${campaign.enabled ? 'activa' : 'inactiva'}`);
    }

    if (opt === 2) {
      // toggle modo
      const newMode = mode === 'template' ? 'ai' : 'template';
      campaign.messageMode = newMode;
      ok(`Modo cambiado a: ${newMode}`);
      if (newMode === 'template' && !campaign.template) {
        warn(
          'No tenés mensaje fijo definido. Usá la opción 3 para escribirlo.',
        );
      }
    }

    if (opt === 3) {
      if (mode === 'template') {
        await editMultiline(rl, campaign, 'template', 'mensaje fijo');
      } else {
        await editMultiline(rl, campaign, 'aiPrompt', 'prompt de usuario (IA)');
      }
    }

    if (opt === 4 && mode === 'ai') {
      await editMultiline(
        rl,
        campaign,
        'systemPrompt',
        'prompt de sistema (IA)',
      );
    }
  }
}

async function editMultiline(
  rl: readline.Interface,
  campaign: CampaignEntry,
  field: 'template' | 'aiPrompt' | 'systemPrompt',
  label: string,
): Promise<void> {
  const current = campaign[field] ?? '';
  header(`📝 Editando: ${label}`);
  info('Texto actual:');
  print('');
  current.split('\n').forEach((line) => dim(`  ${line}`));
  print('');
  info('Opciones:');
  info('  1. Reemplazar completamente');
  info('  2. Dejar sin cambios');
  print('');

  const opt = await askNumber(rl, `  ${CYAN}Opción (1-2): ${RESET}`, 2);
  if (opt === 2) return;

  print('');
  warn(
    'Escribí el nuevo texto. Usá \\n para saltos de línea. Terminá con una línea que diga solo: END',
  );
  warn(
    'Para dividir en dos mensajes separados, usá una línea que diga solo: ---',
  );
  print('');

  const lines: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await ask(rl, '');
    if (line === 'END') break;
    lines.push(line);
  }

  // Join preserving --- separators and convert \n literals
  const raw = lines.join('\n').replace(/\\n/g, '\n');
  campaign[field] = raw;
  ok(`${label} actualizado (${raw.length} caracteres).`);
}

// ─── Anti-spam configurator ───────────────────────────────────────────────────

interface AntispamFile {
  delayMin_ms: number;
  delayMax_ms: number;
  delayFirstContact_ms: number;
  maxPerDay: number;
  maxPerHour: number;
  pauseAfterBatch: number;
  batchSize: number;
  sendWindowStart: string;
  sendWindowEnd: string;
  maxConsecutiveDays: number;
  warmupMode: boolean;
  warmupSchedule: number[];
  [key: string]: unknown;
}

const ANTISPAM_DEFAULTS: AntispamFile = {
  delayMin_ms: 4000,
  delayMax_ms: 9000,
  delayFirstContact_ms: 3000,
  maxPerDay: 200,
  maxPerHour: 80,
  pauseAfterBatch: 300000,
  batchSize: 30,
  sendWindowStart: '09:00',
  sendWindowEnd: '20:00',
  maxConsecutiveDays: 3,
  warmupMode: false,
  warmupSchedule: [20, 36, 65, 117, 210, 378, 680],
};

function readAntispam(): AntispamFile {
  const p = path.join(process.cwd(), 'config', 'antispam.json');
  if (!fs.existsSync(p)) return { ...ANTISPAM_DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as AntispamFile;
    // quitar claves de comentarios que empiezan con _
    const clean: AntispamFile = { ...ANTISPAM_DEFAULTS };
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_')) (clean as Record<string, unknown>)[k] = v;
    }
    return clean;
  } catch {
    return { ...ANTISPAM_DEFAULTS };
  }
}

function writeAntispam(cfg: AntispamFile): void {
  const p = path.join(process.cwd(), 'config', 'antispam.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
}

function msToSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
function msToMin(ms: number): string {
  return `${(ms / 60000).toFixed(1)}min`;
}

async function configureAntispam(rl: readline.Interface): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = readAntispam();

    header('🛡️  Configuración Anti-Spam');
    info('');
    info(
      `  ${BOLD}1.${RESET} Delay mínimo entre mensajes   → ${GREEN}${msToSec(cfg.delayMin_ms)}${RESET}  ${DIM}(rec: 4-5s)${RESET}`,
    );
    info(
      `  ${BOLD}2.${RESET} Delay máximo entre mensajes   → ${GREEN}${msToSec(cfg.delayMax_ms)}${RESET}  ${DIM}(rec: 8-12s)${RESET}`,
    );
    info(
      `  ${BOLD}3.${RESET} Delay extra primer contacto   → ${GREEN}${msToSec(cfg.delayFirstContact_ms)}${RESET}  ${DIM}(se suma al delay normal)${RESET}`,
    );
    info('');
    info(
      `  ${BOLD}4.${RESET} Máximo mensajes por día       → ${YELLOW}${cfg.maxPerDay}${RESET}  ${DIM}(rec: ≤200 cuenta personal)${RESET}`,
    );
    info(
      `  ${BOLD}5.${RESET} Máximo mensajes por hora      → ${YELLOW}${cfg.maxPerHour}${RESET}  ${DIM}(rec: ≤80)${RESET}`,
    );
    info('');
    info(
      `  ${BOLD}6.${RESET} Pausa larga cada N mensajes   → ${CYAN}${cfg.batchSize} msgs → pausa ${msToMin(cfg.pauseAfterBatch)}${RESET}  ${DIM}(simula descanso humano)${RESET}`,
    );
    info('');
    info(
      `  ${BOLD}7.${RESET} Ventana de envío              → ${CYAN}${cfg.sendWindowStart} a ${cfg.sendWindowEnd}${RESET}  ${DIM}(fuera de ese horario no envía)${RESET}`,
    );
    info('');
    info(
      `  ${BOLD}8.${RESET} Modo calentamiento (warmup)   → ${cfg.warmupMode ? `${GREEN}activado${RESET}` : `${RED}desactivado${RESET}`}  ${DIM}(límites progresivos para números nuevos)${RESET}`,
    );
    info('');
    info(`  ${BOLD}9.${RESET} Volver al menú principal`);
    info('');
    warn('  Cambios se guardan inmediatamente en config/antispam.json');

    const opt = await askNumber(rl, `\n  ${CYAN}Opción (1-9): ${RESET}`, 9);
    if (opt === 9) return;

    if (opt === 1) {
      const v = await ask(
        rl,
        `  ${CYAN}Delay mínimo en segundos [actual: ${cfg.delayMin_ms / 1000}]: ${RESET}`,
      );
      const n = parseFloat(v);
      if (!isNaN(n) && n >= 1.5) {
        cfg.delayMin_ms = Math.round(n * 1000);
        writeAntispam(cfg);
        ok(`delayMin_ms → ${cfg.delayMin_ms}ms`);
      } else
        warn(
          'Mínimo permitido: 1.5 segundos (bajo ese valor WhatsApp detecta bots)',
        );
    }
    if (opt === 2) {
      const v = await ask(
        rl,
        `  ${CYAN}Delay máximo en segundos [actual: ${cfg.delayMax_ms / 1000}]: ${RESET}`,
      );
      const n = parseFloat(v);
      if (!isNaN(n) && n >= cfg.delayMin_ms / 1000) {
        cfg.delayMax_ms = Math.round(n * 1000);
        writeAntispam(cfg);
        ok(`delayMax_ms → ${cfg.delayMax_ms}ms`);
      } else warn('El máximo debe ser mayor o igual al mínimo');
    }
    if (opt === 3) {
      const v = await ask(
        rl,
        `  ${CYAN}Delay extra primer contacto en segundos [actual: ${cfg.delayFirstContact_ms / 1000}]: ${RESET}`,
      );
      const n = parseFloat(v);
      if (!isNaN(n) && n >= 0) {
        cfg.delayFirstContact_ms = Math.round(n * 1000);
        writeAntispam(cfg);
        ok(`delayFirstContact_ms → ${cfg.delayFirstContact_ms}ms`);
      } else warn('Valor inválido');
    }
    if (opt === 4) {
      const v = await ask(
        rl,
        `  ${CYAN}Máximo por día [actual: ${cfg.maxPerDay}] (recomendado ≤200): ${RESET}`,
      );
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > 0) {
        if (n > 300)
          warn(`⚠️  Más de 300/día en cuenta personal aumenta riesgo de ban.`);
        cfg.maxPerDay = n;
        writeAntispam(cfg);
        ok(`maxPerDay → ${n}`);
      } else warn('Valor inválido');
    }
    if (opt === 5) {
      const v = await ask(
        rl,
        `  ${CYAN}Máximo por hora [actual: ${cfg.maxPerHour}] (recomendado ≤80): ${RESET}`,
      );
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > 0) {
        cfg.maxPerHour = n;
        writeAntispam(cfg);
        ok(`maxPerHour → ${n}`);
      } else warn('Valor inválido');
    }
    if (opt === 6) {
      const bs = await ask(
        rl,
        `  ${CYAN}Mensajes por batch [actual: ${cfg.batchSize}]: ${RESET}`,
      );
      const bsN = parseInt(bs, 10);
      const ps = await ask(
        rl,
        `  ${CYAN}Pausa post-batch en minutos [actual: ${cfg.pauseAfterBatch / 60000}]: ${RESET}`,
      );
      const psN = parseFloat(ps);
      if (!isNaN(bsN) && bsN > 0 && !isNaN(psN) && psN > 0) {
        cfg.batchSize = bsN;
        cfg.pauseAfterBatch = Math.round(psN * 60000);
        writeAntispam(cfg);
        ok(`batchSize → ${bsN}, pauseAfterBatch → ${cfg.pauseAfterBatch}ms`);
      } else warn('Valores inválidos');
    }
    if (opt === 7) {
      const s = await ask(
        rl,
        `  ${CYAN}Hora inicio (HH:MM) [actual: ${cfg.sendWindowStart}]: ${RESET}`,
      );
      const e = await ask(
        rl,
        `  ${CYAN}Hora fin   (HH:MM) [actual: ${cfg.sendWindowEnd}]: ${RESET}`,
      );
      if (/^\d{2}:\d{2}$/.test(s) && /^\d{2}:\d{2}$/.test(e)) {
        cfg.sendWindowStart = s;
        cfg.sendWindowEnd = e;
        writeAntispam(cfg);
        ok(`Ventana → ${s} a ${e}`);
      } else warn('Formato inválido, usá HH:MM (ej: 09:00)');
    }
    if (opt === 8) {
      cfg.warmupMode = !cfg.warmupMode;
      writeAntispam(cfg);
      ok(`Warmup mode → ${cfg.warmupMode ? 'activado' : 'desactivado'}`);
      if (cfg.warmupMode) {
        info('');
        info('  Plan de calentamiento:');
        cfg.warmupSchedule.forEach((limit, day) =>
          dim(`    Día ${day + 1}: máx ${limit} mensajes`),
        );
      }
    }

    print('');
  }
}

// ─── Main selector ────────────────────────────────────────────────────────────

export type StartupMode = 'bot' | 'mcp';

export async function runStartupSelector(): Promise<StartupMode> {
  const skipSelector =
    process.env['BOT_OSCAR_SKIP_STARTUP_SELECTOR'] === '1' ||
    process.env['BOT_OSCAR_STARTUP_SELECTOR'] === 'false' ||
    process.env['CI'] === 'true' ||
    !process.stdin.isTTY;

  if (skipSelector) {
    dim('Selector de proveedor IA omitido; usando la configuración actual.');
    return 'bot';
  }

  banner();

  const env = readEnv();
  const currentProvider =
    process.env['AI_PROVIDER'] ?? env['AI_PROVIDER'] ?? 'gemini';
  const currentModel = (() => {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), 'config', 'bot.config.json'),
          'utf-8',
        ),
      );
      return cfg?.ai?.model ?? '—';
    } catch {
      return '—';
    }
  })();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      info(
        `Proveedor actual: ${BOLD}${currentProvider}${RESET}  |  Modelo: ${BOLD}${currentModel}${RESET}`,
      );
      print('');

      const waEnabled =
        (process.env['WHATSAPP_ENABLED'] ??
          env['WHATSAPP_ENABLED'] ??
          'true') !== 'false';
      const waLabel = waEnabled
        ? `${GREEN}activado${RESET}`
        : `${RED}desactivado${RESET}`;

      const mcpLabel = `${CYAN}MCP Server${RESET}   ${DIM}(WhatsApp como herramienta para agentes IA)${RESET}`;
      const options = [
        'Configurar proveedor IA',
        'Configurar campañas',
        'Configurar Anti-Spam',
        `WhatsApp          → ${waLabel}`,
        `Iniciar como ${mcpLabel}`,
        'Iniciar bot',
      ];
      options.forEach((p, i) => info(`  ${BOLD}${i + 1}.${RESET} ${p}`));

      const choice = await askNumber(
        rl,
        `\n  ${CYAN}Seleccioná una opción (1-${options.length}): ${RESET}`,
        options.length,
      );

      if (choice === 1) {
        // IA provider submenu
        print('');
        const providers = [
          'Gemini (Google)',
          'Ollama (local)',
          'OpenRouter',
          'Volver',
        ];
        providers.forEach((p, i) => {
          const isCurrent =
            (i === 0 && currentProvider === 'gemini') ||
            (i === 1 && currentProvider === 'ollama') ||
            (i === 2 && currentProvider === 'openrouter');
          info(
            `  ${BOLD}${i + 1}.${RESET} ${p}${isCurrent ? ` ${GREEN}← actual${RESET}` : ''}`,
          );
        });
        const pChoice = await askNumber(
          rl,
          `\n  ${CYAN}Proveedor (1-4): ${RESET}`,
          4,
        );
        if (pChoice === 1) await configureGemini(rl, env);
        else if (pChoice === 2) await configureOllama(rl, env);
        else if (pChoice === 3) await configureOpenRouter(rl, env);
      } else if (choice === 2) {
        await configureCampaigns(rl);
      } else if (choice === 3) {
        await configureAntispam(rl);
      } else if (choice === 4) {
        const newVal = waEnabled ? 'false' : 'true';
        writeEnv({ WHATSAPP_ENABLED: newVal });
        ok(`WhatsApp → ${newVal === 'true' ? 'activado' : 'desactivado'}`);
        if (newVal === 'false') {
          warn(
            'El bot va a iniciar sin conectarse a WhatsApp Web (modo API-only).',
          );
        }
      } else if (choice === 5) {
        // ── Modo MCP ─────────────────────────────────────────────
        rl.close();
        print('');
        print(`${BOLD}${CYAN}▶ Iniciando WhatsApp MCP Server...${RESET}`);
        print(
          `${DIM}  Canal: stdio (Claude, Codex, Gemini, Copilot, etc.)${RESET}`,
        );
        print(
          `${DIM}  Tools disponibles: ${BOLD}13 herramientas de WhatsApp${RESET}`,
        );
        print(`${DIM}  QR y logs de conexión → stderr${RESET}`);
        print('');
        const { startMcpServer } = await import('./mcp/whatsapp-mcp-server.js');
        await startMcpServer();
        // startMcpServer no retorna — mantiene el proceso vivo
        return 'mcp';
      } else {
        ok(`Iniciando con ${currentProvider} / ${currentModel}`);
        break;
      }

      print('');
    }
  } finally {
    rl.close();
  }

  print('');
  print(`${BOLD}${GREEN}▶ Iniciando BOT-Oscar...${RESET}`);
  print('');
  return 'bot';
}
