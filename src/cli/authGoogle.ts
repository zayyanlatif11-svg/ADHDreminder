import { env as loadEnvironment } from '../config/env.js';
import { runOAuthFlow } from '../integrations/google/auth.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  const env = loadEnvironment();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    process.stdout.write(
      '\nGOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env.\nSee SETUP.md step 5, then run this again.\n\n',
    );
    process.exit(1);
  }
  await runOAuthFlow(env, logger);
  process.stdout.write('\nGoogle authorization complete. Next: npm run setup\n\n');
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Authorization failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
