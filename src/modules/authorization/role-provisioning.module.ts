import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RoleProvisioner } from './role-provisioner.service.js';

// Also consumed by the separate controlled CLI process: no runtime database pool
// or migration credentials are imported into NestJS's normal application process.
@Module({
  imports: [AuditModule],
  providers: [RoleProvisioner],
  exports: [RoleProvisioner],
})
export class RoleProvisioningModule {}
