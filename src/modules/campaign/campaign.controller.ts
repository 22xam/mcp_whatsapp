import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignWorkerService } from './campaign-worker.service';
import { ConfigLoaderService } from '../config/config-loader.service';

@Controller('api')
export class CampaignController {
  constructor(
    private readonly campaignService: CampaignService,
    private readonly campaignWorker: CampaignWorkerService,
    private readonly configLoader: ConfigLoaderService,
  ) {}

  @Post('campaigns/reload')
  reloadCampaigns() {
    this.configLoader.reloadAll();
    return { reloaded: this.configLoader.campaigns.length };
  }

  @Get('campaigns')
  listCampaigns() {
    return this.campaignService.listCampaigns();
  }

  @Get('campaigns/:id')
  getCampaign(@Param('id') id: string) {
    return this.campaignService.getCampaign(id);
  }

  @Patch('campaigns/:id')
  patchCampaign(
    @Param('id') id: string,
    @Body() body: { enabled?: boolean; messageMode?: 'ai' | 'template'; template?: string; aiPrompt?: string; systemPrompt?: string },
  ) {
    return this.campaignService.patchCampaign(id, body);
  }

  @Post('campaigns/:id/preview')
  preview(@Param('id') id: string, @Body() body: { phones?: string[]; limit?: number }): Promise<unknown> {
    return this.campaignService.preview(id, body?.phones, body?.limit ?? 10);
  }

  @Post('campaigns/:id/runs')
  createRun(@Param('id') id: string, @Body() body: { phones?: string[]; dryRun?: boolean }) {
    return this.campaignService.createRun(id, body?.phones, body?.dryRun ?? false);
  }

  @Post('campaign-runs')
  createRunCompat(@Body() body: { campaignId: string; phones?: string[]; dryRun?: boolean }) {
    return this.campaignService.createRun(body.campaignId, body?.phones, body?.dryRun ?? false);
  }

  @Get('campaign-runs')
  listRuns(@Query('status') status?: string, @Query('campaignId') campaignId?: string) {
    return this.campaignService.listRuns({ status, campaignId });
  }

  @Get('campaign-runs/:id')
  getRun(@Param('id') id: string) {
    return this.campaignService.getRun(id);
  }

  @Post('campaign-runs/:id/pause')
  pauseRun(@Param('id') id: string) {
    return this.campaignService.setRunStatus(id, 'paused');
  }

  @Post('campaign-runs/:id/resume')
  resumeRun(@Param('id') id: string) {
    return this.campaignService.setRunStatus(id, 'queued');
  }

  @Post('campaign-runs/:id/cancel')
  cancelRun(@Param('id') id: string) {
    return this.campaignService.setRunStatus(id, 'cancelled');
  }

  @Post('campaign-runs/:id/process-next')
  processNext(@Param('id') id: string) {
    return this.campaignService.processNextQueuedJob(id);
  }

  @Post('campaign-runs/process')
  processQueued() {
    return this.campaignWorker.tick();
  }
}
