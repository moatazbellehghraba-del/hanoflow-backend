import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

type Purpose = 'access' | 'refresh';
const prefix = { access: 'hfa_', refresh: 'hfr_' };

@Injectable()
export class TokenSecrets {
  issue(purpose: Purpose): { raw: string; digest: Uint8Array<ArrayBuffer> } {
    const raw = prefix[purpose] + randomBytes(32).toString('base64url');
    return {
      raw,
      digest: new Uint8Array(createHash('sha256').update(raw, 'utf8').digest()),
    };
  }

  digest(raw: string, purpose: Purpose): Uint8Array<ArrayBuffer> | undefined {
    if (raw.length !== 47 || !raw.startsWith(prefix[purpose])) return undefined;
    const encoded = raw.slice(4);
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== encoded)
      return undefined;
    return new Uint8Array(createHash('sha256').update(raw, 'utf8').digest());
  }
}
