#!/usr/bin/env node
/**
 * BOT-Oscar CLI — Control tu bot de WhatsApp desde la consola.
 *
 * Modo interactivo (sin argumentos):
 *   npm run cli
 *
 * Modo directo (con subcomando):
 *   npm run cli -- status
 *   npm run cli -- sessions
 *   npm run cli -- pause 5491112345678
 *   npm run cli -- resume 5491112345678
 *   npm run cli -- flows
 *   npm run cli -- clients
 *   npm run cli -- clients add 5491112345678 "Juan Perez"
 *   npm run cli -- campaigns
 *   npm run cli -- campaigns run bienvenida
 *   npm run cli -- optouts add 5491112345678 "pidio baja"
 *   npm run cli -- skills
 *   npm run cli -- config
 *   npm run cli -- trello
 *   npm run cli -- openrouter models
 *   npm run cli -- knowledge search "mi consulta"
 *   npm run cli -- knowledge rebuild
 *   npm run cli -- paused
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { spawn, type ChildProcess } from 'child_process';
import { ApiClient } from './api-client';
import { startRepl } from './repl';
import { c, fail, info, spinner } from './display';
import * as cmds from './commands';

// ─── Server auto-start ────────────────────────────────────────────────────────

async function ensureServerRunning(client: ApiClient): Promise<void> {
  if (await client.isConnected()) return;

  const stop = spinner('Iniciando servidor BOT-Oscar...');

  const proc: ChildProcess = spawn('npm', ['run', 'start:dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env },
  });

  // Kill server when CLI exits
  const cleanup = () => { try { proc.kill(); } catch { /* already dead */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // Wait up to 60 s for the server to respond
  const deadline = Date.now() + 60_000;
  let ready = false;

  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    ready = await client.isConnected();
  }

  stop();

  if (!ready) {
    cleanup();
    console.error('\n' + fail('El servidor no arrancó en 60 s. Revisá los logs con: npm run start:dev'));
    process.exit(1);
  }
}

// ─── Direct command runner ────────────────────────────────────────────────────

async function runDirect(client: ApiClient, args: string[]): Promise<void> {
  const connected = await client.isConnected();
  if (!connected) {
    console.error(fail('No se pudo conectar al servidor BOT-Oscar.'));
    console.error(`Asegurate de que el bot esté corriendo con ${c.cyan}npm run start${c.reset}`);
    console.error(`o configurá ${c.cyan}BUGMATE_URL${c.reset} si usa otro puerto.`);
    process.exit(1);
  }

  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'status':
      await cmds.cmdStatus(client);
      break;

    case 'sessions':
      await cmds.cmdSessions(client);
      break;

    case 'session':
      if (rest[0] === 'clear') {
        await cmds.cmdSessionClear(client, rest[1]);
      } else {
        console.log(info('Uso: session clear <número>'));
        process.exit(1);
      }
      break;

    case 'flows':
      await cmds.cmdFlows(client);
      break;

    case 'pause':
      await cmds.cmdPause(client, rest[0]);
      break;

    case 'resume':
      await cmds.cmdResume(client, rest[0]);
      break;

    case 'paused':
      await cmds.cmdPaused(client);
      break;

    case 'clients':
      if (!rest[0] || rest[0] === 'list') {
        await cmds.cmdClients(client);
      } else if (rest[0] === 'show') {
        await cmds.cmdClientShow(client, rest[1]);
      } else if (rest[0] === 'add') {
        await cmds.cmdClientAdd(client, rest.slice(1));
      } else if (rest[0] === 'import') {
        await cmds.cmdClientsImport(client, rest.slice(1));
      } else {
        console.log(info('Uso: clients [list] | clients show <telefono> | clients add <telefono> <nombre> | clients import <archivo.csv> [--commit]'));
        process.exit(1);
      }
      break;

    case 'campaigns':
      if (!rest[0] || rest[0] === 'list') {
        await cmds.cmdCampaigns(client);
      } else if (rest[0] === 'show') {
        await cmds.cmdCampaignShow(client, rest[1]);
      } else if (rest[0] === 'preview') {
        await cmds.cmdCampaignPreview(client, rest[1], Number(rest[2] ?? '5'));
      } else if (rest[0] === 'run') {
        await cmds.cmdCampaignRun(client, rest.slice(1));
      } else if (rest[0] === 'runs') {
        await cmds.cmdCampaignRuns(client, rest[1]);
      } else if (rest[0] === 'status') {
        await cmds.cmdCampaignStatus(client, rest[1]);
      } else if (['pause', 'resume', 'cancel', 'process-next', 'process', 'process-queued'].includes(rest[0])) {
        await cmds.cmdCampaignAction(client, rest[0], rest[1]);
      } else {
        console.log(info('Uso: campaigns [list] | campaigns show <id> | campaigns preview <id> [limit] | campaigns run <id> | campaigns runs [id]'));
        process.exit(1);
      }
      break;

    case 'optouts':
    case 'opt-outs':
      if (!rest[0] || rest[0] === 'list') {
        await cmds.cmdOptOuts(client);
      } else if (rest[0] === 'add') {
        await cmds.cmdOptOutAdd(client, rest.slice(1));
      } else if (rest[0] === 'remove' || rest[0] === 'delete') {
        await cmds.cmdOptOutRemove(client, rest[1]);
      } else {
        console.log(info('Uso: optouts [list] | optouts add <teléfono> [motivo] | optouts remove <teléfono>'));
        process.exit(1);
      }
      break;

    case 'skills':
      if (!rest[0] || rest[0] === 'list') {
        await cmds.cmdSkills(client);
      } else if (rest[0] === 'show') {
        await cmds.cmdSkillShow(client, rest[1]);
      } else if (rest[0] === 'run') {
        await cmds.cmdSkillRun(client, rest.slice(1));
      } else {
        console.log(info('Uso: skills [list] | skills show <id> | skills run <id> [input]'));
        process.exit(1);
      }
      break;

    case 'config':
      await cmds.cmdConfig(client);
      break;

    case 'trello':
      await cmds.cmdTrello(client);
      break;

    case 'campaign':
      if (rest.length === 0) {
        await cmds.cmdCampaigns(client);
      } else if (rest[0] === 'preview') {
        await cmds.cmdCampaignPreview(client, rest[1], Number(rest[2] ?? '5'));
      } else if (rest[0] === 'run') {
        await cmds.cmdCampaignRun(client, rest.slice(1));
      } else if (rest[0] === 'status') {
        await cmds.cmdCampaignStatus(client, rest[1]);
      } else if (rest[0] === 'process' || rest[0] === 'process-queued') {
        await cmds.cmdCampaignAction(client, rest[0], rest[1]);
      } else {
        await cmds.cmdCampaignAction(client, rest[0], rest[1]);
      }
      break;

    case 'optout':
      if (rest[0] === 'add') {
        await cmds.cmdOptOutAdd(client, rest.slice(1));
      } else if (rest[0] === 'remove') {
        await cmds.cmdOptOutRemove(client, rest[1]);
      } else {
        console.log(info('Uso: optout add <telefono> [motivo] | optout remove <telefono>'));
      }
      break;

    case 'openrouter':
    case 'or':
      if (rest[0] === 'models') {
        const kind = rest[1] === 'embeddings' || rest[1] === 'all' ? rest[1] : 'chat';
        await cmds.cmdOpenRouterModels(client, kind);
      } else {
        console.log(info('Uso: openrouter models [embeddings|all]'));
        process.exit(1);
      }
      break;

    case 'knowledge':
    case 'k':
      if (rest[0] === 'search') {
        await cmds.cmdKnowledgeSearch(client, rest.slice(1).join(' '));
      } else if (rest[0] === 'rebuild') {
        await cmds.cmdKnowledgeRebuild(client);
      } else {
        console.log(info('Uso: knowledge search <query>  |  knowledge rebuild'));
        process.exit(1);
      }
      break;

    case 'chat':
      console.log(
        info(
          'El modo chat requiere modo interactivo. Ejecutá: ' +
          `${c.cyan}npm run cli${c.reset}  y luego  ${c.cyan}chat <número>${c.reset}`,
        ),
      );
      break;

    case 'help':
    case '--help':
    case '-h':
      printDirectHelp();
      break;

    default:
      console.error(fail(`Comando desconocido: ${cmd}`));
      printDirectHelp();
      process.exit(1);
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printDirectHelp(): void {
  console.log(`
${c.bold}BOT-Oscar CLI${c.reset} — Control tu bot de WhatsApp desde la consola

${c.bold}Uso:${c.reset}
  ${c.cyan}npm run cli${c.reset}                        Modo interactivo (REPL)
  ${c.cyan}npm run cli -- <comando>${c.reset}          Modo directo

${c.bold}Comandos:${c.reset}
  status                             Estado del bot
  sessions                           Sesiones activas
  session clear <número>             Limpiar sesión
  flows                              Flujos configurados
  pause <número>                     Pausar bot para número
  resume <número|all>                Reanudar bot para número o todos
  paused                             Ver senders pausados
  clients [list]                     Lista de clientes
  clients show <teléfono>            Detalle de cliente
  clients add <teléfono> <nombre>    Crear cliente
  clients import <csv> [--commit]    Preview/importacion CSV
  campaigns [list]                   Lista campañas
  campaigns show <id>                Detalle de campaña
  campaigns run <id>                 Ejecutar campaña
  campaigns runs [id]                Ver ejecuciones
  optouts [list]                     Lista opt-outs
  optouts add <teléfono> [motivo]    Registrar baja
  optouts remove <teléfono>          Quitar baja
  skills [list]                      Lista skills
  skills show <id>                   Detalle de skill
  skills run <id> [input]            Ejecutar skill
  config                             Configuración del bot
  trello                             Tableros de Trello
  campaigns                          Campañas configuradas
  campaign preview <id> [limit]      Vista previa de campaña
  campaign run <id> [dry]            Crear corrida de campaña
  campaign status [runId]            Estado de corridas
  campaign process-next <runId>      Enviar siguiente job en cola
  campaign process                   Ejecutar un ciclo del worker
  optouts                            Listar bajas
  optout add/remove <teléfono>       Gestionar bajas
  openrouter models [embeddings|all] Modelos disponibles en OpenRouter
  knowledge search <query>           Buscar en base de conocimiento
  knowledge rebuild                  Reconstruir índice
  chat <número>                      Simular conversación (solo en REPL)

${c.bold}Variables de entorno:${c.reset}
  ${c.cyan}BUGMATE_URL${c.reset}=http://localhost:3000   URL del servidor BOT-Oscar
`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const client = new ApiClient();

(async () => {
  await ensureServerRunning(client);

  if (args.length === 0) {
    // Interactive REPL mode
    await startRepl(client);
  } else {
    // Direct command mode
    await runDirect(client, args);
    console.log('');
  }
})().catch((err) => {
  console.error(fail(err.message));
  process.exit(1);
});
