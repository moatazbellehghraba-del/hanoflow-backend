import { Module } from '@nestjs/common';
import { QueuesModule } from '../../src/infrastructure/queues/queues.module.js';
import {
  INFRASTRUCTURE_QUEUE,
  InfrastructureProcessor,
} from './infrastructure.processor.js';

// Import only from a guarded real Redis test harness in Task 1.4.4.
// Never import this module into AppModule or execute it against development Redis.
@Module({
  imports: [
    QueuesModule,
    QueuesModule.registerQueue(INFRASTRUCTURE_QUEUE),
    QueuesModule.registerWorker(INFRASTRUCTURE_QUEUE, InfrastructureProcessor),
  ],
})
export class InfrastructureQueueModule {}
