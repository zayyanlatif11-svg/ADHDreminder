import { stdout } from 'node:process';
import { buildApp } from '../app.js';
import { normalizeHandle } from '../integrations/bluebubbles/types.js';
import { silentLogger } from '../utils/logger.js';

/**
 * `npm run send:test` — proves the outbound path end to end.
 *
 * The message is deliberately harmless and self-describing, and it bypasses
 * quiet hours (it is user-initiated, so silence would just look like a bug).
 */
async function main(): Promise<void> {
  const app = await buildApp({ logger: silentLogger });

  try {
    const { env } = app;
    stdout.write('\n\x1b[1mSending a test iMessage\x1b[0m\n\n');

    const health = await app.adapter.healthCheck();
    if (!health.ok) {
      stdout.write(`✗ BlueBubbles is not reachable: ${health.detail}\n`);
      stdout.write('  Run `npm run doctor` for the full picture.\n\n');
      process.exit(1);
    }
    stdout.write(`✓ BlueBubbles reachable${health.serverVersion ? ` (${health.serverVersion})` : ''}\n`);

    const destination = env.CHAT_GUID ?? env.TARGET_HANDLE;
    if (!destination) {
      stdout.write('✗ No TARGET_HANDLE or CHAT_GUID configured. Run `npm run setup`.\n\n');
      process.exit(1);
    }
    stdout.write(`  Destination: ${env.CHAT_GUID ? env.CHAT_GUID : normalizeHandle(env.TARGET_HANDLE)}\n`);

    // Resolving the real chat GUID makes replies land in the right thread.
    if (!env.CHAT_GUID && env.TARGET_HANDLE) {
      const conversation = await app.adapter.identifyConversation(env.TARGET_HANDLE);
      if (conversation) {
        stdout.write(`  Existing 1:1 chat found: ${conversation.chatGuid}\n`);
        stdout.write('  Consider setting CHAT_GUID in .env to pin replies to this thread.\n');
      } else {
        stdout.write('  No existing 1:1 chat found — one will be created on send.\n');
      }
    }

    const body = [
      'execution-agent test message.',
      '',
      'If you can see this, outbound messaging works.',
      'Reply HELP to check the inbound path.',
    ].join('\n');

    const result = await app.messenger.send(body, { kind: 'test', force: true });

    if (result.suppressedReason === 'dry_run') {
      stdout.write('\n! DRY_RUN is enabled in .env — nothing was actually sent.\n\n');
      return;
    }
    if (result.ok) {
      stdout.write('\n✓ Sent. Check your Messages app.\n');
      stdout.write('  Now reply HELP from that conversation to test the inbound webhook.\n');
      stdout.write('  (The agent must be running: npm run dev)\n\n');
    } else {
      stdout.write(`\n✗ Send failed: ${result.error ?? 'unknown error'}\n\n`);
      process.exit(1);
    }
  } finally {
    app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('send:test failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
