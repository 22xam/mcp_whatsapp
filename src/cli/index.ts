#!/usr/bin/env node
/**
 * BugMate CLI — Control tu bot de WhatsApp desde la consola.
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
 *   npm run cli -- config
 *   npm run cli -- trello
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

  const stop = spinner('Iniciando servidor BugMate...');

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
    console.error(fail('No se pudo conectar al servidor BugMate.'));
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
      await cmds.cmdClients(client);
      break;

    case 'config':
      await cmds.cmdConfig(client);
      break;

    case 'trello':
      await cmds.cmdTrello(client);
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
${c.bold}BugMate CLI${c.reset} — Control tu bot de WhatsApp desde la consola

${c.bold}Uso:${c.reset}
  ${c.cyan}npm run cli${c.reset}                        Modo interactivo (REPL)
  ${c.cyan}npm run cli -- <comando>${c.reset}          Modo directo

${c.bold}Comandos:${c.reset}
  status                             Estado del bot
  sessions                           Sesiones activas
  session clear <número>             Limpiar sesión
  flows                              Flujos configurados
  pause <número>                     Pausar bot para número
  resume <número>                    Reanudar bot para número
  paused                             Ver senders pausados
  clients                            Lista de clientes
  config                             Configuración del bot
  trello                             Tableros de Trello
  knowledge search <query>           Buscar en base de conocimiento
  knowledge rebuild                  Reconstruir índice
  chat <número>                      Simular conversación (solo en REPL)

${c.bold}Variables de entorno:${c.reset}
  ${c.cyan}BUGMATE_URL${c.reset}=http://localhost:3000   URL del servidor BugMate
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
