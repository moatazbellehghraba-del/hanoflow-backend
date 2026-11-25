// Offline tests never use a developer's real connection string.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:1/hanoflow_unit';

process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
process.env.QUEUE_PREFIX = 'hanoflow-unit';
