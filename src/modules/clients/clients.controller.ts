import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ClientConfig } from '../config/types/bot-config.types';
import { ClientsService } from './clients.service';

@Controller('api/clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get()
  findAll(
    @Query('q') q?: string,
    @Query('tag') tag?: string,
    @Query('system') system?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const all = this.clientsService.search({ q, tag, system });
    // If no pagination params are sent return legacy flat array (backward compat)
    if (limit === undefined && offset === undefined) return all;
    const lim = Math.min(Math.max(Number(limit ?? 50), 1), 500);
    const off = Math.max(Number(offset ?? 0), 0);
    return { total: all.length, limit: lim, offset: off, data: all.slice(off, off + lim) };
  }

  @Get(':phone')
  findOne(@Param('phone') phone: string) {
    return this.clientsService.findByPhone(phone);
  }

  @Post()
  create(@Body() body: ClientConfig) {
    return this.clientsService.upsert(body);
  }

  @Patch(':phone')
  update(@Param('phone') phone: string, @Body() body: Partial<ClientConfig>) {
    const current = this.clientsService.findByPhone(phone);
    const merged = {
      phone,
      name: body.name ?? current?.name ?? '',
      company: body.company ?? current?.company ?? '',
      systems: body.systems ?? current?.systems ?? [],
      tags: body.tags ?? current?.tags ?? [],
      knowledgeDocs: body.knowledgeDocs ?? current?.knowledgeDocs ?? [],
      trelloLists: body.trelloLists ?? current?.trelloLists ?? {},
      notes: body.notes ?? current?.notes,
    };
    return this.clientsService.upsert(merged);
  }

  @Delete(':phone')
  delete(@Param('phone') phone: string) {
    return { ok: this.clientsService.delete(phone) };
  }

  @Post('import/preview')
  importPreview(@Body() body: { clients?: ClientConfig[]; csv?: string }) {
    return this.clientsService.importPreview(body.clients ?? this.clientsService.parseCsv(body.csv ?? ''));
  }

  @Post('import/commit')
  importCommit(@Body() body: { clients?: ClientConfig[]; csv?: string }) {
    return this.clientsService.importCommit(body.clients ?? this.clientsService.parseCsv(body.csv ?? ''));
  }
}
