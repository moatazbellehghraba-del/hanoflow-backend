import * as argon2 from 'argon2';
import { PASSWORD_HASH_OPTIONS } from './password.config.js';

export const PASSWORD_ENGINE = Symbol('PASSWORD_ENGINE');
export interface PasswordEngine {
  hash(password: string): Promise<string>;
  verify(encoded: string, password: string): Promise<boolean>;
}

export const argon2Engine: PasswordEngine = {
  hash: (password) =>
    argon2.hash(password, { ...PASSWORD_HASH_OPTIONS, type: argon2.argon2id }),
  verify: (encoded, password) => argon2.verify(encoded, password),
};
