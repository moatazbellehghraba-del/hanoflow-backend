import { Module } from '@nestjs/common';
import { PasswordPolicy } from './passwords/password-policy.service.js';
import { PasswordHasher } from './passwords/password-hasher.service.js';
import { PasswordCapacity } from './passwords/password-capacity.service.js';
import { PASSWORD_ENGINE, argon2Engine } from './passwords/password-engine.js';

@Module({
  providers: [
    PasswordPolicy,
    PasswordHasher,
    PasswordCapacity,
    { provide: PASSWORD_ENGINE, useValue: argon2Engine },
  ],
  exports: [PasswordPolicy, PasswordHasher],
})
export class IdentityModule {}
