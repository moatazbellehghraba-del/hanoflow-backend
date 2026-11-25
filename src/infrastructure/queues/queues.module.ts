import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  ModuleMetadata,
  OnModuleDestroy,
  Type,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { producerQueueOptions } from './queue.config.js';
import { validateQueueName } from './queue.constants.js';
import { QueueRuntime } from './queue-runtime.service.js';
import type { QueueProcessor } from './queue-runtime.service.js';

@Module({
  imports: [ConfigModule],
  providers: [QueueRuntime],
  exports: [QueueRuntime],
})
class QueueCoreModule {}

@Module({})
class QueueRegistrationModule {}

@Module({
  imports: [
    QueueCoreModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: producerQueueOptions,
    }),
  ],
})
export class QueuesModule implements OnModuleDestroy {
  constructor(private readonly runtime: QueueRuntime) {}

  // Root-level destruction drains queues before deeper database modules close.
  onModuleDestroy(): Promise<void> {
    return this.runtime.close();
  }

  static registerQueue(name: string): DynamicModule {
    validateQueueName(name);
    return {
      module: QueueRegistrationModule,
      imports: [
        QueueCoreModule,
        BullModule.registerQueueAsync({
          name,
          imports: [ConfigModule, QueueCoreModule],
          inject: [ConfigService, QueueRuntime],
          useFactory: (config: ConfigService, runtime: QueueRuntime) => ({
            ...producerQueueOptions(config),
            connection: runtime.createProducerConnection(name),
            forceDisconnectOnShutdown: true,
          }),
        }),
      ],
      providers: [
        {
          provide: `HanoFlowQueueLifecycle:${name}`,
          inject: [getQueueToken(name), QueueRuntime],
          useFactory: (
            queue: Queue<unknown, unknown, string>,
            runtime: QueueRuntime,
          ) => {
            runtime.registerQueue(queue);
            return true;
          },
        },
      ],
      exports: [BullModule, QueueCoreModule],
    };
  }

  static registerWorker<Data, Result, Name extends string>(
    name: string,
    processor: Type<QueueProcessor<Data, Result, Name>>,
    imports: NonNullable<ModuleMetadata['imports']> = [],
  ): DynamicModule {
    validateQueueName(name);
    return {
      module: QueueRegistrationModule,
      imports: [QueueCoreModule, ...imports],
      providers: [
        processor,
        {
          provide: `HanoFlowWorker:${name}`,
          inject: [QueueRuntime, processor],
          useFactory: (
            runtime: QueueRuntime,
            instance: QueueProcessor<Data, Result, Name>,
          ) => runtime.registerWorker(name, instance),
        },
      ],
    };
  }
}
