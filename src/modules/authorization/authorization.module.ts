import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationService } from './authorization.service.js';
import { RoleProvisioningModule } from './role-provisioning.module.js';
@Module({
  imports: [
    DatabaseModule,
    SessionsModule,
    AuditModule,
    RoleProvisioningModule,
  ],
  providers: [AuthorizationService],
  exports: [AuthorizationService, RoleProvisioningModule],
})
export class AuthorizationModule {}
