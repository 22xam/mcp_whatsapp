import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigLoaderService } from './config-loader.service';

describe('ConfigLoaderService', () => {
  let tempDir: string;
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `bot-oscar-config-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(join(tempDir, 'config', 'knowledge-docs'), { recursive: true });
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads required config and treats campaigns.json as optional', () => {
    writeConfig('bot.config.json', { identity: { name: 'Bot' } });
    writeConfig('clients.json', [
      { phone: '5491111111111', name: 'Ana', company: 'ACME', systems: [] },
    ]);
    writeConfig('knowledge.json', []);

    const service = new ConfigLoaderService();
    service.onModuleInit();

    expect(service.clients).toHaveLength(1);
    expect(service.knowledge).toEqual([]);
    expect(service.campaigns).toEqual([]);
    expect(service.findClient('541111111111')).toMatchObject({ name: 'Ana' });
  });

  it('loads campaigns.json when present', () => {
    writeConfig('bot.config.json', { identity: { name: 'Bot' } });
    writeConfig('clients.json', []);
    writeConfig('knowledge.json', []);
    writeConfig('campaigns.json', [
      {
        id: 'welcome',
        name: 'Bienvenida',
        enabled: true,
        audience: { mode: 'all' },
        template: 'Hola {name}',
      },
    ]);

    const service = new ConfigLoaderService();
    service.onModuleInit();

    expect(service.campaigns).toHaveLength(1);
    expect(service.campaigns[0]).toMatchObject({
      id: 'welcome',
      name: 'Bienvenida',
    });
  });

  it('defaults clients to an empty list when clients.json is missing', () => {
    writeConfig('bot.config.json', { identity: { name: 'Bot' } });
    writeConfig('knowledge.json', []);

    const service = new ConfigLoaderService();
    service.onModuleInit();

    expect(service.clients).toEqual([]);
  });

  function writeConfig(filename: string, value: unknown): void {
    writeFileSync(
      join(tempDir, 'config', filename),
      JSON.stringify(value),
      'utf-8',
    );
  }
});
