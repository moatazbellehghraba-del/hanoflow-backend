import { Field, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { HealthService } from './health.service.js';

@ObjectType()
export class HealthStatus {
  @Field(() => String)
  status!: string;
}

@Resolver(() => HealthStatus)
export class HealthResolver {
  constructor(private readonly health: HealthService) {}

  @Query(() => HealthStatus, { name: 'health' })
  getHealth(): HealthStatus {
    return this.health.getLiveness();
  }
}
