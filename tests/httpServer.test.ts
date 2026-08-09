import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSimulation, type SimulationHarness } from '../src/cli/simulate.js';
import { createHttpServer } from '../src/server/httpServer.js';
import { silentLogger } from '../src/utils/logger.js';
import { webhookBody } from './helpers.js';

const OWNER = '+15551234567';
const SECRET = 'test-secret';

describe('webhook endpoint', () => {
  let harness: SimulationHarness;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    harness = createSimulation({ at: '2026-08-12T09:00:00' });

    const app = createHttpServer({
      agent: harness.agent,
      router: harness.router,
      messenger: harness.messenger,
      adapter: harness.adapter,
      logger: silentLogger,
      authorizedHandles: [OWNER],
      chatGuid: null,
      webhookSecret: SECRET,
      now: harness.now,
    });

    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness.close();
  });

  /** Gives the fire-and-forget handler a moment to finish. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if (harness.adapter.sent.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function post(body: unknown, secret = SECRET): Promise<Response> {
    return fetch(`${baseUrl}/webhook/bluebubbles?secret=${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('exposes a health endpoint', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('handles an authorized command and replies', async () => {
    const response = await post(webhookBody({ text: 'HELP', handle: OWNER }));
    expect(response.status).toBe(200);

    await settle();
    expect(harness.adapter.sent).toHaveLength(1);
    expect(harness.adapter.lastMessage()).toContain('COMMANDS');
  });

  it('rejects a wrong webhook secret', async () => {
    const response = await post(webhookBody(), 'wrong-secret');
    expect(response.status).toBe(401);
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('rejects a missing webhook secret', async () => {
    const response = await fetch(`${baseUrl}/webhook/bluebubbles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody()),
    });
    expect(response.status).toBe(401);
  });

  it('ignores a duplicate delivery of the same message', async () => {
    await post(webhookBody({ guid: 'dup-1', text: 'HELP', handle: OWNER }));
    await settle();
    expect(harness.adapter.sent).toHaveLength(1);

    await post(webhookBody({ guid: 'dup-1', text: 'HELP', handle: OWNER }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Still one — the redelivery was dropped rather than handled twice.
    expect(harness.adapter.sent).toHaveLength(1);
  });

  it('ignores a message from an unauthorized handle', async () => {
    await post(webhookBody({ guid: 'x1', handle: '+15559999999', text: 'HELP' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('ignores its own outgoing message and does not loop', async () => {
    await post(
      webhookBody({ guid: 'own-1', handle: OWNER, isFromMe: true, text: 'SATURDAY — TOP 3' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('accepts malformed payloads without crashing', async () => {
    for (const body of [{}, { type: 'new-message' }, { random: 'junk' }, []]) {
      const response = await post(body);
      expect(response.status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.adapter.sent).toHaveLength(0);

    // Still healthy and still able to serve a real command afterwards.
    await post(webhookBody({ guid: 'after-junk', text: 'HELP', handle: OWNER }));
    await settle();
    expect(harness.adapter.sent).toHaveLength(1);
  });

  it('ignores non-message events such as typing indicators', async () => {
    await post({ type: 'typing-indicator', data: { guid: 'typing-1' } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.adapter.sent).toHaveLength(0);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/not-a-route`);
    expect(response.status).toBe(404);
  });
});
