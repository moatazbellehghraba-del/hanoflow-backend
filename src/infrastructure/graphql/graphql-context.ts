import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

export interface ApiGraphqlContext {
  req: Request;
  requestId: string;
}

export function createGraphqlContext({
  req,
}: {
  req: Request;
}): ApiGraphqlContext {
  return { req, requestId: req.requestId ?? randomUUID() };
}
