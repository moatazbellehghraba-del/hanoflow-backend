import { Module } from '@nestjs/common';
import { SessionAuditWriter } from './session-audit.writer.js';
import { TenantAuditWriter } from './tenant-audit.writer.js';

@Module({
  providers: [SessionAuditWriter, TenantAuditWriter],
  exports: [SessionAuditWriter, TenantAuditWriter],
})
export class AuditModule {}
