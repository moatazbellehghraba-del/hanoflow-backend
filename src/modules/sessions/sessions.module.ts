import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SessionsService } from './sessions.service.js';
import { TokenSecrets } from './token-secrets.js';

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [SessionsService, TokenSecrets],
  exports: [SessionsService],
})
export class SessionsModule {}
