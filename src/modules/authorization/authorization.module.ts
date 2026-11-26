import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationService } from './authorization.service.js';
import { RoleProvisioner } from './role-provisioner.service.js';
@Module({
  imports: [DatabaseModule, SessionsModule, AuditModule],
  providers: [AuthorizationService, RoleProvisioner],
  exports: [AuthorizationService, RoleProvisioner],
})
export class AuthorizationModule {}
