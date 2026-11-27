import { config } from 'dotenv';

// Never load Compose/admin or migration/fixture secrets into test runtime env.
config({ path: '.env.test-runtime', quiet: true });
