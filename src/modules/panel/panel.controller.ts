import { Controller, Get, Param, Res } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { extname, join, normalize } from 'path';
import type { Response } from 'express';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

@Controller()
export class PanelController {
  private readonly panelDir = join(process.cwd(), 'public', 'panel');

  @Get(['panel', 'panel/'])
  index(@Res() res: Response): void {
    this.sendFile(res, 'index.html');
  }

  @Get('panel/:asset')
  asset(@Param('asset') asset: string, @Res() res: Response): void {
    this.sendFile(res, asset);
  }

  private sendFile(res: Response, asset: string): void {
    const safeAsset = normalize(asset).replace(/^(\.\.[/\\])+/, '');
    const path = join(this.panelDir, safeAsset);
    if (!path.startsWith(this.panelDir) || !existsSync(path)) {
      res.status(404).send('Not found');
      return;
    }

    res.type(CONTENT_TYPES[extname(path)] ?? 'text/plain; charset=utf-8');
    res.send(readFileSync(path));
  }
}
