import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ClientConfig } from '../config/types/bot-config.types';
import { ClientsService } from './clients.service';

@Controller('api/clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get()
  findAll(@Query('q') q?: string, @Query('tag') tag?: string, @Query('system') system?: string) {
    return this.clientsService.search({ q, tag, system });
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
