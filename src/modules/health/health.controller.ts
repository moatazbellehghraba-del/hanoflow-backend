import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  getHealth(): { status: 'ok' } {
    return this.health.getLiveness();
  }

  @Get('ready')
  getReadiness(): Promise<{ status: 'ok'; database: 'up'; redis: 'up' }> {
    return this.health.getReadiness();
  }
}
