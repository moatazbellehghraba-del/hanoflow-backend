import { Module } from '@nestjs/common';
import { SessionAuditWriter } from './session-audit.writer.js';

@Module({ providers: [SessionAuditWriter], exports: [SessionAuditWriter] })
export class AuditModule {}
