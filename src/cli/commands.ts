import { ApiClient } from './api-client';
import { c, ok, fail, info, warn, header, table } from './display';
import { readFileSync } from 'fs';

// ─── Status ───────────────────────────────────────────────────────────────────

export async function cmdStatus(client: ApiClient): Promise<void> {
  const s = await client.get<any>('/api/status');

  console.log(header('Estado del Bot'));
  console.log(`  ${c.bold}Nombre:${c.reset}   ${c.white}${s.botName}${c.reset} (${s.company})`);
  console.log(`  ${c.bold}Uptime:${c.reset}   ${c.green}${s.uptimeFormatted}${c.reset}`);
  console.log(`  ${c.bold}IA:${c.reset}       ${c.cyan}${s.aiProvider}${c.reset}`);
  console.log(`  ${c.bold}Modo:${c.reset}     ${c.yellow}${s.mode}${c.reset}`);
  console.log(`  ${c.bold}Sesiones:${c.reset} ${c.bold}${s.activeSessions}${c.reset} activas`);
  console.log(
    `  ${c.bold}Trello:${c.reset}   ${s.trelloEnabled ? c.green + '✓ conectado' : c.red + '✗ no configurado'}${c.reset}`,
  );

  if (s.pausedCount > 0) {
    console.log(
      `  ${c.bold}Pausados:${c.reset} ${c.yellow}${s.pausedCount}${c.reset} — ${s.pausedSenders.join(', ')}`,
    );
  }
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export async function cmdSessions(client: ApiClient): Promise<void> {
  const sessions = await client.get<any[]>('/api/sessions');

  if (sessions.length === 0) {
    console.log(info('No hay sesiones activas'));
    return;
  }

  console.log(header(`Sesiones activas (${sessions.length})`));

  const rows = sessions.map((s) => [
    s.senderId.replace('@c.us', '').replace('@lid', ''),
    s.clientName ?? '—',
    colorState(s.state),
    s.activeConditionalFlowId ?? s.activeFlowId ?? '—',
    s.activeStepId ?? '—',
    timeAgo(new Date(s.lastActivityAt)),
  ]);

  console.log(
    table(
      ['Número', 'Cliente', 'Estado', 'Flujo', 'Paso', 'Actividad'],
      rows,
    ),
  );
}

export async function cmdSessionClear(client: ApiClient, number: string): Promise<void> {
  if (!number) {
    console.log(fail('Indicá un número: session clear <número>'));
    return;
  }
  const res = await client.del<any>(`/api/sessions/${number}`);
  console.log(ok(res.message));
}

// ─── Flows ───────────────────────────────────────────────────────────────────

export async function cmdFlows(client: ApiClient): Promise<void> {
  const { conditionalFlows, legacyFlows } = await client.get<any>('/api/flows');

  if (conditionalFlows.length === 0 && legacyFlows.length === 0) {
    console.log(warn('No hay flujos configurados'));
    return;
  }

  if (conditionalFlows.length > 0) {
    console.log(header('Flujos condicionales'));
    for (const flow of conditionalFlows) {
      console.log(`  ${c.bold}${c.cyan}${flow.id}${c.reset}  ${c.dim}${flow.stepCount} pasos:${c.reset} ${flow.steps.join(' → ')}`);
    }
  }

  if (legacyFlows.length > 0) {
    console.log(header('Flujos legacy'));
    for (const flow of legacyFlows) {
      const typeColor = flow.type === 'guided' ? c.blue : c.magenta;
      console.log(`  ${c.bold}${c.cyan}${flow.id}${c.reset}  [${typeColor}${flow.type}${c.reset}]  ${c.dim}${flow.detail}${c.reset}`);
    }
  }
}

// ─── Pause / Resume ───────────────────────────────────────────────────────────

export async function cmdPause(client: ApiClient, number: string): Promise<void> {
  if (!number) {
    console.log(fail('Indicá un número: pause <número>'));
    return;
  }
  const res = await client.post<any>('/api/pause', { number });
  console.log(res.isNew ? ok(`Bot pausado para ${c.bold}${number}${c.reset}`) : info(`Ya estaba pausado para ${number}`));
}

export async function cmdResume(client: ApiClient, number: string): Promise<void> {
  if (!number) {
    console.log(fail('Indicá un número: resume <número>'));
    return;
  }
  if (number === 'all') {
    const res = await client.post<any>('/api/resume/all');
    console.log(ok(`Bot reanudado para ${res.resumed.length} senders`));
    if (res.resumed.length > 0) {
      console.log(`  ${c.dim}${res.resumed.join(', ')}${c.reset}`);
    }
    return;
  }

  const res = await client.post<any>('/api/resume', { number });
  console.log(res.existed ? ok(`Bot reanudado para ${c.bold}${number}${c.reset}`) : info(`No estaba pausado para ${number}`));
}

export async function cmdPaused(client: ApiClient): Promise<void> {
  const { senders } = await client.get<any>('/api/paused');
  if (senders.length === 0) {
    console.log(info('No hay senders pausados'));
    return;
  }
  console.log(header(`Senders pausados (${senders.length})`));
  for (const s of senders) {
    console.log(`  ${c.yellow}⏸${c.reset}  ${s}`);
  }
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export async function cmdClients(client: ApiClient): Promise<void> {
  const clients = await client.get<any[]>('/api/clients');

  printClients(clients);
}

export async function cmdClientShow(client: ApiClient, phone: string): Promise<void> {
  if (!phone) {
    console.log(fail('Indicá un teléfono: clients show <teléfono>'));
    return;
  }

  const clientData = await client.get<any>(`/api/clients/${encodeURIComponent(phone)}`);
  console.log(header(`Cliente ${phone}`));
  printObject(clientData);
}

export async function cmdClientAdd(client: ApiClient, args: string[]): Promise<void> {
  const json = readJsonFlag(args);
  const phone = args[0];
  const name = args.slice(1).join(' ');

  if (!json && (!phone || !name)) {
    console.log(fail('Uso: clients add <teléfono> <nombre>  |  clients add --json \'{"phone":"...","name":"..."}\''));
    return;
  }

  const body = json ?? { phone, name };
  const res = await client.post<any>('/api/clients', body);
  console.log(ok(res?.message ?? 'Cliente creado'));
  if (res && typeof res === 'object' && !res.message) printObject(res);
}

export async function cmdClientsImport(client: ApiClient, args: string[]): Promise<void> {
  const file = args[0];
  const commit = args.includes('--commit');
  if (!file) {
    console.log(fail('Uso: clients import <archivo.csv> [--commit]'));
    return;
  }

  const csv = readFileSync(file, 'utf-8');
  const endpoint = commit ? '/api/clients/import/commit' : '/api/clients/import/preview';
  const result = await client.post<any>(endpoint, { csv });

  if (commit) {
    if (result.invalid?.length) {
      console.log(fail(`Importacion cancelada: ${result.invalid.length} filas invalidas`));
      printImportPreview(result.invalid);
      return;
    }
    console.log(ok(`Clientes importados: ${result.imported}`));
    return;
  }

  printImportPreview(result);
  console.log(info('Para aplicar la importacion: clients import <archivo.csv> --commit'));
}

function printClients(clients: any[]): void {
  if (clients.length === 0) {
    console.log(info('No hay clientes configurados'));
    return;
  }

  console.log(header(`Clientes registrados (${clients.length})`));

  const rows = clients.map((c) => [
    c.name ?? '—',
    c.phone ?? '—',
    c.company ?? '—',
    Array.isArray(c.systems) && c.systems.length > 0 ? c.systems.join(', ') : '—',
    Array.isArray(c.tags) && c.tags.length > 0 ? c.tags.join(', ') : '—',
  ]);
  console.log(table(['Nombre', 'Teléfono', 'Empresa', 'Sistemas', 'Tags'], rows));
}

function printImportPreview(items: any[]): void {
  if (!items.length) {
    console.log(info('No hay filas para importar'));
    return;
  }

  console.log(header(`Preview importacion (${items.length})`));
  console.log(table(
    ['Telefono', 'Nombre', 'Accion', 'Valido', 'Errores', 'Tags'],
    items.map((item) => [
      item.phone ?? '-',
      item.name ?? '-',
      item.action ?? '-',
      item.valid ? 'si' : 'no',
      item.errors?.join(', ') ?? '-',
      item.tags?.join(', ') ?? '-',
    ]),
  ));
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

async function cmdCampaignsUnused(client: ApiClient): Promise<void> {
  const res = await client.get<any>('/api/campaigns');
  const campaigns = normalizeList(res, 'campaigns');

  if (campaigns.length === 0) {
    console.log(info('No hay campañas configuradas'));
    return;
  }

  console.log(header(`Campañas (${campaigns.length})`));
  const rows = campaigns.map((campaign) => [
    String(campaign.id ?? campaign.slug ?? '—'),
    campaign.name ?? campaign.title ?? '—',
    campaign.status ?? '—',
    String(campaign.audienceCount ?? campaign.recipientsCount ?? campaign.clientsCount ?? '—'),
    formatDate(campaign.createdAt ?? campaign.updatedAt),
  ]);
  console.log(table(['ID', 'Nombre', 'Estado', 'Audiencia', 'Fecha'], rows));
}

export async function cmdCampaignShow(client: ApiClient, campaignId: string): Promise<void> {
  if (!campaignId) {
    console.log(fail('Indicá una campaña: campaigns show <id>'));
    return;
  }

  const campaign = await client.get<any>(`/api/campaigns/${encodeURIComponent(campaignId)}`);
  console.log(header(`Campaña ${campaignId}`));
  printObject(campaign);
}

export async function cmdCampaignRun(client: ApiClient, args: string[]): Promise<void> {
  const campaignId = args[0];
  if (!campaignId) {
    console.log(fail('Uso: campaigns run <id> [--dry-run] [--phones=549...,549...]'));
    return;
  }

  const body: Record<string, unknown> = { campaignId };
  if (args.includes('--dry-run')) body.dryRun = true;
  const phones = readOption(args, '--phones');
  if (phones) body.phones = phones.split(',').map((phone) => phone.trim()).filter(Boolean);

  const res = await client.post<any>('/api/campaign-runs', body);
  console.log(ok(res?.message ?? 'Ejecución de campaña creada'));
  printRunSummary(res);
}

export async function cmdCampaignRuns(client: ApiClient, campaignId?: string): Promise<void> {
  const path = campaignId
    ? `/api/campaign-runs?campaignId=${encodeURIComponent(campaignId)}`
    : '/api/campaign-runs';
  const res = await client.get<any>(path);
  const runs = normalizeList(res, 'runs');

  if (runs.length === 0) {
    console.log(info('No hay ejecuciones de campañas'));
    return;
  }

  console.log(header(`Ejecuciones de campaña (${runs.length})`));
  const rows = runs.map((run) => [
    String(run.id ?? run.runId ?? '—'),
    String(run.campaignId ?? run.campaign?.id ?? '—'),
    run.status ?? '—',
    String(run.totals?.sent ?? run.sent ?? run.sentCount ?? 0),
    String(run.totals?.failed ?? run.failed ?? run.failedCount ?? 0),
    formatDate(run.createdAt ?? run.startedAt ?? run.finishedAt),
  ]);
  console.log(table(['Run', 'Campaña', 'Estado', 'Enviados', 'Fallidos', 'Fecha'], rows));
}

// ─── Opt-outs ────────────────────────────────────────────────────────────────

export async function cmdOptOuts(client: ApiClient): Promise<void> {
  const res = await client.get<any>('/api/opt-outs');
  const optOuts = normalizeList(res, 'optOuts');

  if (optOuts.length === 0) {
    console.log(info('No hay opt-outs registrados'));
    return;
  }

  console.log(header(`Opt-outs (${optOuts.length})`));
  const rows = optOuts.map((item) => [
    item.phone ?? item.number ?? item.senderId ?? '—',
    item.reason ?? '—',
    formatDate(item.createdAt ?? item.optedOutAt),
  ]);
  console.log(table(['Teléfono', 'Motivo', 'Fecha'], rows));
}

export async function cmdOptOutAdd(client: ApiClient, args: string[]): Promise<void> {
  const phone = args[0];
  const reason = args.slice(1).join(' ');

  if (!phone) {
    console.log(fail('Uso: optouts add <teléfono> [motivo]'));
    return;
  }

  const res = await client.post<any>('/api/opt-outs', { phone, reason: reason || undefined });
  console.log(ok(res?.message ?? `Opt-out registrado para ${phone}`));
}

export async function cmdOptOutRemove(client: ApiClient, phone: string): Promise<void> {
  if (!phone) {
    console.log(fail('Uso: optouts remove <teléfono>'));
    return;
  }

  const res = await client.del<any>(`/api/opt-outs/${encodeURIComponent(phone)}`);
  console.log(ok(res?.message ?? `Opt-out eliminado para ${phone}`));
}

// ─── Skills ──────────────────────────────────────────────────────────────────

export async function cmdSkills(client: ApiClient): Promise<void> {
  const res = await client.get<any>('/api/skills');
  const skills = normalizeList(res, 'skills');

  if (skills.length === 0) {
    console.log(info('No hay skills registrados'));
    return;
  }

  console.log(header(`Skills (${skills.length})`));
  const rows = skills.map((skill) => [
    String(skill.id ?? skill.name ?? '—'),
    skill.title ?? skill.description ?? '—',
    skill.enabled === false ? 'off' : 'on',
  ]);
  console.log(table(['ID', 'Descripción', 'Estado'], rows));
}

export async function cmdSkillShow(client: ApiClient, skillId: string): Promise<void> {
  if (!skillId) {
    console.log(fail('Uso: skills show <id>'));
    return;
  }

  const skill = await client.get<any>(`/api/skills/${encodeURIComponent(skillId)}`);
  console.log(header(`Skill ${skillId}`));
  printObject(skill);
}

export async function cmdSkillRun(client: ApiClient, args: string[]): Promise<void> {
  const skillId = args[0];
  const input = args.slice(1).join(' ');

  if (!skillId) {
    console.log(fail('Uso: skills run <id> [input]'));
    return;
  }

  const res = await client.post<any>(`/api/skills/${encodeURIComponent(skillId)}/run`, { input });
  console.log(ok(res?.message ?? `Skill ${skillId} ejecutado`));
  if (res && typeof res === 'object' && !res.message) printObject(res);
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function cmdConfig(client: ApiClient): Promise<void> {
  const cfg = await client.get<any>('/api/config');

  console.log(header('Identidad'));
  console.log(`  ${c.bold}Nombre:${c.reset}     ${cfg.identity.name}`);
  console.log(`  ${c.bold}Empresa:${c.reset}    ${cfg.identity.company}`);
  console.log(`  ${c.bold}Dev:${c.reset}        ${cfg.identity.developerName}`);
  if (cfg.identity.tone) console.log(`  ${c.bold}Tono:${c.reset}       ${cfg.identity.tone}`);

  console.log(header('Comportamiento'));
  console.log(`  ${c.bold}Modo:${c.reset}       ${c.yellow}${cfg.mode}${c.reset}`);
  console.log(`  ${c.bold}IA:${c.reset}         ${c.cyan}${cfg.ai.provider}${c.reset}`);
  console.log(`  ${c.bold}Conocimiento:${c.reset} ${cfg.ai.useKnowledge ? c.green + '✓ activo' : c.red + '✗ inactivo'}${c.reset}`);
  if (cfg.ai.useKnowledge) {
    console.log(`  ${c.bold}RAG top-K:${c.reset}  ${cfg.ai.ragTopK}  ${c.bold}score mín:${c.reset} ${cfg.ai.ragMinScore}`);
  }
  console.log(`  ${c.bold}Historial:${c.reset}  ${cfg.ai.maxHistoryMessages} mensajes`);
  console.log(`  ${c.bold}Timeout:${c.reset}    ${cfg.greeting.sessionTimeoutMinutes} minutos de sesión`);

  if (cfg.menu?.options?.length > 0) {
    console.log(header('Menú'));
    for (const opt of cfg.menu.options) {
      const dest = opt.conditionalFlowId ?? opt.flowId ?? opt.action ?? '—';
      console.log(`  ${c.bold}${opt.id}.${c.reset} ${opt.label}  ${c.gray}→ ${dest}${c.reset}`);
    }
  }

  if (cfg.escalation?.keywords?.length > 0) {
    console.log(header('Escalada'));
    console.log(`  ${c.bold}Keywords:${c.reset} ${cfg.escalation.keywords.join(', ')}`);
  }

  console.log(header('Delay humano'));
  console.log(`  ${cfg.humanDelay?.enabled ? ok('activado') : fail('desactivado')}`);

  console.log(header('Trello'));
  if (cfg.trello?.enabled) {
    console.log(`  ${ok('habilitado')}`);
    const lists = Object.entries(cfg.trello.lists ?? {});
    if (lists.length > 0) {
      for (const [key, id] of lists) {
        console.log(`  ${c.bold}${key}:${c.reset} ${c.gray}${id}${c.reset}`);
      }
    }
  } else {
    console.log(`  ${warn('no configurado')}`);
  }
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export async function cmdKnowledgeSearch(client: ApiClient, query: string): Promise<void> {
  if (!query.trim()) {
    console.log(fail('Indicá una búsqueda: knowledge search <query>'));
    return;
  }

  const { result, query: q } = await client.get<any>(
    `/api/knowledge/search?q=${encodeURIComponent(query)}`,
  );

  if (!result) {
    console.log(warn(`Sin resultados para: "${q}"`));
    return;
  }

  console.log(header('Resultado de búsqueda'));
  console.log(`  ${c.bold}Score:${c.reset}  ${c.green}${result.score.toFixed(3)}${c.reset}`);
  console.log(`  ${c.bold}Fuente:${c.reset} ${c.cyan}${result.source}${c.reset}`);
  const preview = result.content.length > 400
    ? result.content.slice(0, 400) + '…'
    : result.content;
  console.log(`\n${c.dim}${preview.split('\n').map((l: string) => '  ' + l).join('\n')}${c.reset}`);
}

export async function cmdKnowledgeRebuild(client: ApiClient): Promise<void> {
  console.log(info('Reconstruyendo índice de conocimiento...'));
  const res = await client.post<any>('/api/knowledge/rebuild');
  console.log(ok(res.message));
}

// ─── Trello ───────────────────────────────────────────────────────────────────

export async function cmdTrello(client: ApiClient): Promise<void> {
  const { enabled, boards } = await client.get<any>('/api/trello/boards');

  if (!enabled) {
    console.log(warn('Trello no está configurado. Agregá TRELLO_API_KEY y TRELLO_TOKEN al .env'));
    return;
  }

  if (boards.length === 0) {
    console.log(warn('No se encontraron tableros de Trello'));
    return;
  }

  console.log(header('Tableros de Trello'));

  for (const board of boards) {
    console.log(`\n  ${c.bold}${c.cyan}${board.name}${c.reset}  ${c.gray}${board.id}${c.reset}`);
    if (board.lists.length === 0) {
      console.log(`    ${c.dim}(sin columnas)${c.reset}`);
    } else {
      for (const list of board.lists) {
        console.log(`    ${c.dim}•${c.reset} ${c.bold}${list.name}${c.reset}  ${c.gray}${list.id}${c.reset}`);
      }
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

export async function cmdOpenRouterModels(client: ApiClient, kind = 'chat'): Promise<void> {
  const path = kind === 'embeddings'
    ? '/api/openrouter/embedding-models'
    : kind === 'all'
      ? '/api/openrouter/models?output=all'
      : '/api/openrouter/models';
  const { count, models } = await client.get<any>(path);

  if (count === 0) {
    console.log(warn('No se encontraron modelos de OpenRouter para ese filtro'));
    return;
  }

  console.log(header(`Modelos OpenRouter (${count})`));

  const rows = models.slice(0, 100).map((model: any) => [
    model.id,
    model.name ?? '-',
    model.context_length ? String(model.context_length) : '-',
    (model.architecture?.input_modalities ?? []).join(',') || '-',
    (model.architecture?.output_modalities ?? []).join(',') || '-',
  ]);

  console.log(
    table(
      ['ID', 'Nombre', 'Contexto', 'Input', 'Output'],
      rows,
    ),
  );

  if (models.length > rows.length) {
    console.log(info(`Mostrando ${rows.length} de ${models.length}. Usá /api/openrouter/models para ver el JSON completo.`));
  }
}

export async function cmdCampaigns(client: ApiClient): Promise<void> {
  const campaigns = await client.get<any[]>('/api/campaigns');
  if (campaigns.length === 0) {
    console.log(warn('No hay campañas configuradas. Creá config/campaigns.json desde campaigns.example.json.'));
    return;
  }
  console.log(header(`Campañas (${campaigns.length})`));
  console.log(table(
    ['ID', 'Nombre', 'Estado', 'Audiencia'],
    campaigns.map((campaign) => [
      campaign.id,
      campaign.name,
      campaign.enabled ? 'activa' : 'inactiva',
      campaign.audience?.mode ?? '-',
    ]),
  ));
}

export async function cmdCampaignPreview(client: ApiClient, id: string, limit = 5): Promise<void> {
  if (!id) {
    console.log(fail('Uso: campaign preview <id> [limit]'));
    return;
  }
  const items = await client.post<any[]>(`/api/campaigns/${id}/preview`, { limit });
  console.log(header(`Preview ${id}`));
  for (const item of items) {
    console.log(`\n${c.bold}${item.name ?? item.phone}${c.reset} ${c.dim}${item.phone}${c.reset}`);
    console.log(item.skipped ? warn(`Omitido: ${item.reason}`) : item.message);
  }
}

async function cmdCampaignRunUnused(client: ApiClient, id: string, dryRun = false): Promise<void> {
  if (!id) {
    console.log(fail('Uso: campaign run <id> [dry]'));
    return;
  }
  const run = await client.post<any>(`/api/campaigns/${id}/runs`, { dryRun });
  console.log(ok(`Corrida creada: ${run.id}`));
  console.log(`  Estado: ${run.status}`);
  console.log(`  Totales: ${JSON.stringify(run.totals)}`);
}

export async function cmdCampaignStatus(client: ApiClient, id?: string): Promise<void> {
  if (!id) {
    const runs = await client.get<any[]>('/api/campaign-runs');
    console.log(header(`Corridas (${runs.length})`));
    console.log(table(
      ['ID', 'Campaña', 'Estado', 'Totales'],
      runs.map((run) => [run.id, run.campaignId, run.status, JSON.stringify(run.totals)]),
    ));
    return;
  }
  const run = await client.get<any>(`/api/campaign-runs/${id}`);
  console.log(header(`Corrida ${id}`));
  console.log(`Estado: ${run.status}`);
  console.log(`Totales: ${JSON.stringify(run.totals)}`);
  console.log(table(
    ['ID', 'Teléfono', 'Estado', 'Intentos', 'Error'],
    run.jobs.map((job: any) => [job.id, job.phone, job.status, String(job.attempts), job.error ?? '-']),
  ));
}

export async function cmdCampaignAction(client: ApiClient, action: string, id: string): Promise<void> {
  if (action === 'process' || action === 'process-queued') {
    const result = await client.post<any>('/api/campaign-runs/process');
    console.log(ok(`Worker ejecutado: ${result.processed} procesados / ${result.activeRuns} corridas activas`));
    return;
  }

  if (!id || !['pause', 'resume', 'cancel', 'process-next'].includes(action)) {
    console.log(fail('Uso: campaign <pause|resume|cancel|process-next> <runId> | campaign process'));
    return;
  }
  const run = await client.post<any>(`/api/campaign-runs/${id}/${action}`);
  console.log(ok(`Corrida ${id}: ${run.status}`));
}

async function cmdOptOutsUnused(client: ApiClient): Promise<void> {
  const entries = await client.get<any[]>('/api/opt-outs');
  if (entries.length === 0) {
    console.log(info('No hay opt-outs registrados'));
    return;
  }
  console.log(header(`Opt-outs (${entries.length})`));
  console.log(table(
    ['Teléfono', 'Origen', 'Motivo'],
    entries.map((entry) => [entry.phone, entry.source, entry.reason ?? '-']),
  ));
}

async function cmdOptOutAddUnused(client: ApiClient, phone: string, reason?: string): Promise<void> {
  if (!phone) {
    console.log(fail('Uso: optout add <telefono> [motivo]'));
    return;
  }
  const entry = await client.post<any>('/api/opt-outs', { phone, reason });
  console.log(ok(`Opt-out registrado para ${entry.phone}`));
}

async function cmdOptOutRemoveUnused(client: ApiClient, phone: string): Promise<void> {
  if (!phone) {
    console.log(fail('Uso: optout remove <telefono>'));
    return;
  }
  const result = await client.del<any>(`/api/opt-outs/${phone}`);
  console.log(result.ok ? ok(`Opt-out removido para ${phone}`) : warn(`No existía opt-out para ${phone}`));
}

function colorState(state: string): string {
  switch (state) {
    case 'IDLE':                     return `${c.dim}${state}${c.reset}`;
    case 'AWAITING_MENU_SELECTION':  return `${c.yellow}${state}${c.reset}`;
    case 'FLOW_ACTIVE':              return `${c.blue}${state}${c.reset}`;
    case 'CONDITIONAL_FLOW_ACTIVE':  return `${c.cyan}${state}${c.reset}`;
    case 'ESCALATED':                return `${c.red}${state}${c.reset}`;
    default:                         return state;
  }
}

function timeAgo(date: Date): string {
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return `hace ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin}m`;
  return `hace ${Math.floor(diffMin / 60)}h`;
}

function normalizeList(res: any, key: string): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.[key])) return res[key];
  if (Array.isArray(res?.items)) return res.items;
  if (Array.isArray(res?.data)) return res.data;
  return [];
}

function readJsonFlag(args: string[]): any | undefined {
  const index = args.indexOf('--json');
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw) throw new Error('Falta el cuerpo JSON despues de --json');
  args.splice(index, 2);
  return JSON.parse(raw);
}

function readOption(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];

  return undefined;
}

function formatDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function printRunSummary(res: any): void {
  if (!res || typeof res !== 'object') return;

  const rows = [
    ['Enviados', res.sent ?? res.sentCount],
    ['Fallidos', res.failed ?? res.failedCount],
    ['Omitidos', res.skipped ?? res.skippedCount],
    ['Estado', res.status],
  ].filter(([, value]) => value !== undefined);

  if (rows.length > 0) {
    console.log(table(['Métrica', 'Valor'], rows.map(([name, value]) => [String(name), String(value)])));
  } else if (!res.message) {
    printObject(res);
  }
}

function printObject(value: unknown): void {
  console.log(`${c.dim}${JSON.stringify(value, null, 2)}${c.reset}`);
}
