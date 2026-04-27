import { Module } from '@nestjs/common';
import { PanelController } from './panel.controller';

@Module({
  controllers: [PanelController],
})
export class PanelModule {}
