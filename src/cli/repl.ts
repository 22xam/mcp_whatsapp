import * as readline from 'readline';
import { ApiClient } from './api-client';
import { c, banner } from './display';

const COMMANDS = [
  'help', 'status', 'sessions', 'flows', 
  'clients', 'clients list', 'clients add', 'clients import',
  'campaigns', 'campaigns list', 'campaigns run',
  'optouts', 'optouts list', 'optouts add',
  'exit', 'quit', 'clear'
];

function completer(line: string) {
  const hits = COMMANDS.filter((c) => c.startsWith(line.trim()));
  return [hits.length ? hits : COMMANDS, line];
}

export async function startRepl(client: ApiClient): Promise<void> {
  banner();

  // Connection check
  process.stdout.write(`  Conectando a ${c.cyan}${client.baseUrl}${c.reset} ...`);
  const connected = await client.isConnected();

  if (!connected) {
    console.log(` ${c.red}✗${c.reset}\n`);
    console.log(`  ${c.red}${c.bold}No se pudo conectar al servidor BOT-Oscar.${c.reset}\n`);
    console.log(`  Asegurate de que el bot esté corriendo:`);
    console.log(`    ${c.cyan}npm run start${c.reset}   (producción)`);
    console.log(`    ${c.cyan}npm run start:dev${c.reset} (desarrollo)\n`);
    console.log(`  Si usás otro puerto, configurá: ${c.cyan}BOT_OSCAR_URL=http://localhost:XXXX${c.reset}\n`);
    process.exit(1);
  }

  console.log(` ${c.green}✓ conectado${c.reset}`);

  try {
    const s = await client.get<any>('/api/status');
    console.log(
      `  Versión: ${c.yellow}${s.version}${c.reset} | Provider: ${c.yellow}${s.aiProvider}${c.reset} | Uptime: ${c.yellow}${s.uptimeHuman}${c.reset}\n`
    );
  } catch {
    console.log('');
  }

  const rl = readline.createInterface({
    input:     process.stdin,
    output:    process.stdout,
    prompt:    `${c.green}${c.bold}bot-oscar${c.reset}${c.bold}>${c.reset} `,
    completer,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === 'exit' || input === 'quit') {
      process.exit(0);
    }

    if (input === 'clear') {
      console.clear();
      banner();
      rl.prompt();
      return;
    }

    if (input === 'help') {
      printHelp();
      rl.prompt();
      return;
    }

    // Process other commands via API
    try {
      // Split command and args
      const parts = input.split(/\s+/);
      const cmd = parts[0];
      
      if (cmd === 'status') {
        const res = await client.get<any>('/api/status');
        console.log(JSON.stringify(res, null, 2));
      } else if (cmd === 'sessions') {
        const res = await client.get<any>('/api/sessions');
        console.table(res.map((s: any) => ({
          phone: s.senderId.replace('@c.us', ''),
          state: s.state,
          flow: s.activeFlowId || 'none',
          step: s.activeStepId || 'none',
          lastActivity: new Date(s.lastActivityAt).toLocaleTimeString()
        })));
      } else if (cmd === 'clients') {
        const sub = parts[1];
        if (sub === 'list') {
          const res = await client.get<any>('/api/clients');
          console.table(res);
        } else {
          console.log(`Uso: clients list | add <phone> [name] | import <json_path>`);
        }
      } else if (cmd === 'campaigns') {
        const sub = parts[1];
        if (sub === 'list') {
          const res = await client.get<any>('/api/campaigns');
          console.table(res);
        } else {
          console.log(`Uso: campaigns list | run <id>`);
        }
      } else {
        // Fallback for generic commands if needed, or just help
        console.log(`Comando no reconocido. Escribí 'help' para ver la lista.`);
      }
    } catch (err) {
      console.error(`${c.red}Error:${c.reset}`, (err as Error).message);
    }

    console.log('');
    rl.prompt();
  }).on('close', () => {
    process.exit(0);
  });
}

function printHelp() {
  console.log(`
  ${c.bold}Comandos disponibles:${c.reset}
  
  ${c.cyan}status${c.reset}             Muestra el estado general del servidor
  ${c.cyan}sessions${c.reset}           Lista las sesiones de chat activas
  ${c.cyan}flows${c.reset}              Lista los flujos cargados en memoria
  ${c.cyan}clients list${c.reset}       Lista todos los clientes registrados
  ${c.cyan}campaigns list${c.reset}     Lista las campañas configuradas
  ${c.cyan}clear${c.reset}              Limpia la pantalla
  ${c.cyan}help${c.reset}               Muestra esta ayuda
  ${c.cyan}exit${c.reset}               Sale de la consola
  `);
}
