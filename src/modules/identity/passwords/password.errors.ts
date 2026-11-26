export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_POLICY_REJECTED';
  constructor() {
    super('Password does not meet the creation policy');
    this.name = 'PasswordPolicyError';
  }
}

export class PasswordCapacityError extends Error {
  readonly code = 'PASSWORD_CAPACITY_EXHAUSTED';
  constructor() {
    super('Password processing capacity unavailable');
    this.name = 'PasswordCapacityError';
  }
}

export class PasswordOperationError extends Error {
  readonly code = 'PASSWORD_OPERATION_FAILED';
  constructor() {
    super('Password processing failed');
    this.name = 'PasswordOperationError';
  }
}

export class PasswordHashRejectedError extends Error {
  constructor(
    readonly code: 'PASSWORD_HASH_INVALID' | 'PASSWORD_HASH_UNSUPPORTED',
  ) {
    super('Stored password hash cannot be processed');
    this.name = 'PasswordHashRejectedError';
  }
}
