import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { NativeRpcError } from '../src/harness/codex/protocol.js';
import { MockHarness, codexAdapters, testCatalog, testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
function deferred() {
  let resolve = () => {};
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-steer-runtime-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const harness = new MockHarness();
  let supported = true;
  let offline = false;
  let catalogCalls = 0;
  const config = testConfig(root);
  const open = async () => {
    const app = await buildApp({
      config,
      runtimeUrl: 'http://127.0.0.1:1',
      adapterFactory: (workspace, settings) => {
        const [adapter] = codexAdapters(
          {
            ...testCatalog,
            models: async () => {
              catalogCalls++;
              if (offline) throw new Error('catalog offline');
              return testCatalog.models();
            },
          },
          harness.factory,
        )(workspace, settings);
        Object.defineProperty(adapter!.descriptor.capabilities, 'steer', { get: () => supported });
        return [adapter!];
      },
    });
    harness.useStore(app.isles.store);
    cleanups.push(() => app.close());
    return app;
  };
  const app = await open();
  const create = async (steerEnabled?: boolean, name = 'Reader') => {
    const result = await app.isles.runtime.createAgent({
      harness: 'codex',
      name,
      model: 'test-model',
      reasoningEffort: 'high',
      ...(steerEnabled === undefined ? {} : { steerEnabled }),
    });
    await expect.poll(() => app.isles.store.publicAgent(result.id).status).toBe('ready');
    return app.isles.store.publicAgent(result.id);
  };
  const say = (channelId: string, body: string) =>
    app.isles.runtime.send(channelId, { body, clientId: randomUUID() });
  const status = (agent: Agent, body: string, channelId = agent.channelId) =>
    app.isles.store
      .listMessages(channelId)
      .find((message) => message.body === body)
      ?.deliveries.find((d) => d.agentId === agent.id)?.status;
  const begin = async (agent: Agent) => {
    say(agent.channelId, 'Initial turn');
    await expect.poll(() => status(agent, 'Initial turn')).toBe('accepted');
    return harness.latest(agent.id);
  };
  const ready = (agent: Agent) =>
    expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
  return {
    app,
    harness,
    open,
    create,
    say,
    status,
    begin,
    ready,
    support: (value: boolean) => {
      supported = value;
    },
    goOffline: () => {
      offline = true;
    },
    calls: () => catalogCalls,
  };
}

describe('configurable steer scheduling', () => {
  it('does not flag a finished run uncertain when MCP consumes input before the scheduled steer claim', async () => {
    const { app, harness, create, say, status, begin } = await fixture();
    const agent = await create(true);
    const client = await begin(agent);
    say(agent.channelId, 'Consumed before claim');
    expect(
      app.isles.runtime.receiveMessages(agent.id, { limit: 100 }).input[0]!.messages[0]!.body,
    ).toBe('Consumed before claim');
    client.complete();
    await app.isles.runtime.close();
    expect(harness.steers).toHaveLength(0);
    expect(app.isles.store.publicAgent(agent.id).status).not.toBe('error');
    expect(app.isles.store.agentDetail(agent.id).runs[0]!.status).toBe('completed');
    expect(status(agent, 'Consumed before claim')).toBe('received');
  });
  it('refuses a delayed initial ACK that attempts to replace the turn already receiving steer', async () => {
    const { app, harness, create, say, status, ready } = await fixture();
    const agent = await create(true);
    const client = harness.latest(agent.id);
    const gate = deferred();
    const request = client.request.bind(client);
    client.request = async <T = unknown>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      const result = await request<T>(method, params);
      if (method === 'turn/start') {
        await gate.promise;
        return { turn: { id: 'conflicting-ack-turn' } } as T;
      }
      return result;
    };
    say(agent.channelId, 'Initial turn');
    await expect.poll(() => status(agent, 'Initial turn')).toBe('accepted');
    const nativeTurn = client.turnId;
    say(agent.channelId, 'Steered before start ACK');
    await expect.poll(() => status(agent, 'Steered before start ACK')).toBe('accepted');
    gate.resolve();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('error');
    const run = app.isles.store.agentDetail(agent.id).runs[0]!;
    expect(run).toMatchObject({
      turnId: nativeTurn,
      status: 'uncertain',
      finishedAt: expect.any(String),
    });
    client.complete();
    expect(app.isles.store.publicAgent(agent.id).status).toBe('error');
    expect(status(agent, 'Steered before start ACK')).toBe('uncertain');
    await app.isles.runtime.stop(agent.id);
    await app.isles.runtime.resume(agent.id);
    await ready(agent);
    expect(harness.bodies(agent.id)).toHaveLength(1);
  });
  it('defaults off and delivers busy messages in a new turn on the same native thread', async () => {
    const { app, harness, create, say, status, begin, ready } = await fixture();
    const agent = await create();
    expect(agent.steerEnabled).toBe(false);
    const client = await begin(agent);
    say(agent.channelId, 'Queued until complete');
    expect(status(agent, 'Queued until complete')).toBe('queued');
    expect(client.calls.filter((call) => call.method === 'turn/steer')).toEqual([]);
    client.complete();
    await expect
      .poll(() => harness.bodies(agent.id))
      .toEqual([['Initial turn'], ['Queued until complete']]);
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
    client.complete();
    await ready(agent);
  });

  it('rejects unsupported enablement but lets an offline or no-longer-supporting harness disable it', async () => {
    const { app, harness, create, support, goOffline, calls } = await fixture();
    support(false);
    await expect(create(true)).rejects.toMatchObject({ statusCode: 400 });
    const off = await create();
    await expect(
      app.isles.runtime.updateAgent(off.id, { steerEnabled: true }),
    ).rejects.toMatchObject({ statusCode: 400 });
    support(true);
    const on = await create(true, 'On');
    const count = calls();
    support(false);
    goOffline();
    const client = harness.latest(on.id);
    expect(await app.isles.runtime.updateAgent(on.id, { steerEnabled: false })).toMatchObject({
      steerEnabled: false,
    });
    expect(calls()).toBe(count);
    expect(client.closed).toBe(false);
    expect(harness.clients.filter((item) => item.agent.id === on.id)).toHaveLength(1);
  });

  it('claims a single batch across channels, preserves origin and excludes pending or accepted input from MCP', async () => {
    const { app, harness, create, say, status, begin, ready } = await fixture();
    const reader = await create(true);
    const peer = await create(false, 'Peer');
    const group = app.isles.runtime.createGroup('user', {
      name: 'Shared discussion',
      memberIds: [reader.id, peer.id],
    });
    const client = await begin(reader);
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    const privateMessage = say(reader.channelId, 'Private steer');
    const peerMessage = app.isles.runtime.publish(peer.id, group.id, {
      body: 'Peer steer',
      clientId: randomUUID(),
      mentions: [reader.id],
    });
    await expect.poll(() => harness.steers).toHaveLength(1);
    expect(status(reader, 'Private steer')).toBe('steering');
    expect(status(reader, 'Peer steer', group.id)).toBe('steering');
    expect(app.isles.runtime.receiveMessages(reader.id, { limit: 100 }).input).toEqual([]);
    const steer = harness.steers[0]!;
    expect(steer.turnId).toBe(client.turnId);
    expect(steer.envelope.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_id: reader.channelId,
          messages: [
            expect.objectContaining({
              seq: privateMessage.seq,
              body: 'Private steer',
              sender: { type: 'user', id: 'user' },
            }),
          ],
        }),
        expect.objectContaining({
          channel_id: group.id,
          messages: [
            expect.objectContaining({
              seq: peerMessage.seq,
              body: 'Peer steer',
              mentions_you: true,
              sender: { type: 'agent', id: peer.id, name: peer.name },
            }),
          ],
        }),
      ]),
    );
    gate.resolve();
    await expect.poll(() => status(reader, 'Private steer')).toBe('accepted');
    expect(app.isles.runtime.receiveMessages(reader.id, { limit: 100 }).input).toEqual([]);
    expect(harness.bodies(reader.id)).toHaveLength(1);
    client.complete();
    await ready(reader);
    expect(status(reader, 'Private steer')).toBe('completed');
    expect(status(reader, 'Peer steer', group.id)).toBe('completed');
    expect(app.isles.store.agentDetail(reader.id).runs).toHaveLength(1);
  });

  it('enables queued input during a turn without reconnecting and serializes RPCs while edits take effect immediately', async () => {
    const { app, harness, create, say, status, begin, ready, goOffline, calls } = await fixture();
    const agent = await create();
    const client = await begin(agent);
    say(agent.channelId, 'Before enabled');
    const count = calls();
    goOffline();
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    await app.isles.runtime.updateAgent(agent.id, { steerEnabled: true });
    await expect.poll(() => status(agent, 'Before enabled')).toBe('steering');
    say(agent.channelId, 'During pending RPC');
    expect(status(agent, 'During pending RPC')).toBe('queued');
    expect(harness.steers).toHaveLength(1);
    await app.isles.runtime.updateAgent(agent.id, { steerEnabled: false });
    gate.resolve();
    await expect.poll(() => status(agent, 'Before enabled')).toBe('accepted');
    expect(status(agent, 'During pending RPC')).toBe('queued');
    expect(harness.steers).toHaveLength(1);
    expect(calls()).toBe(count);
    expect(client.closed).toBe(false);
    expect(harness.clients).toHaveLength(1);
    client.complete();
    await expect.poll(() => harness.bodies(agent.id)).toHaveLength(2);
    client.complete();
    await ready(agent);
  });

  it('waits for a steer ACK that follows turn completion before starting the next turn', async () => {
    const { app, harness, create, say, status, begin, ready } = await fixture();
    const agent = await create(true);
    const client = await begin(agent);
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    say(agent.channelId, 'ACK after completion');
    await expect.poll(() => status(agent, 'ACK after completion')).toBe('steering');
    await app.isles.runtime.updateAgent(agent.id, { steerEnabled: false });
    say(agent.channelId, 'Next turn');
    client.complete();
    expect(status(agent, 'ACK after completion')).toBe('steering');
    expect(harness.bodies(agent.id)).toHaveLength(1);
    gate.resolve();
    await expect.poll(() => harness.bodies(agent.id)).toHaveLength(2);
    expect(status(agent, 'ACK after completion')).toBe('completed');
    expect(harness.bodies(agent.id)[1]).toEqual(['Next turn']);
    client.complete();
    await ready(agent);
  });

  it('returns definite rejection to the next turn without repeatedly steering the same input', async () => {
    const { harness, create, say, status, begin, ready } = await fixture();
    const agent = await create(true);
    const client = await begin(agent);
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    say(agent.channelId, 'Rejected after complete');
    await expect.poll(() => status(agent, 'Rejected after complete')).toBe('steering');
    client.complete();
    gate.reject(new NativeRpcError('no active turn to steer', -32600));
    await expect
      .poll(() => harness.bodies(agent.id))
      .toEqual([['Initial turn'], ['Rejected after complete']]);
    expect(client.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1);
    client.complete();
    await ready(agent);
  });

  it('keeps unknown outcomes out of automatic input even after explicit recovery', async () => {
    const { app, harness, create, say, status, begin, ready } = await fixture();
    const agent = await create(true);
    const client = await begin(agent);
    harness.failSteer = 'unknown';
    say(agent.channelId, 'Unknown submission');
    await expect.poll(() => status(agent, 'Unknown submission')).toBe('uncertain');
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({ status: 'error' });
    client.complete();
    expect(harness.bodies(agent.id)).toHaveLength(1);
    harness.failSteer = undefined;
    await app.isles.runtime.stop(agent.id);
    await app.isles.runtime.resume(agent.id);
    await ready(agent);
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
    expect(harness.bodies(agent.id)).toHaveLength(1);
    expect(app.isles.runtime.receiveMessages(agent.id, { limit: 100 }).input).toEqual([]);
  });

  it('does not revive a cancelled group when a pending RPC is later accepted', async () => {
    const { app, harness, create, say, status, begin, ready } = await fixture();
    const agent = await create(true);
    const group = app.isles.runtime.createGroup('user', {
      name: 'Delete while steering',
      memberIds: [agent.id],
    });
    const client = await begin(agent);
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    say(group.id, 'Deleted group input');
    await expect.poll(() => status(agent, 'Deleted group input', group.id)).toBe('steering');
    app.isles.runtime.deleteGroup(group.id);
    expect(status(agent, 'Deleted group input', group.id)).toBe('cancelled');
    gate.resolve();
    await expect
      .poll(() => app.isles.store.getSteer(harness.steers[0]!.batchId).status)
      .toBe('accepted');
    expect(status(agent, 'Deleted group input', group.id)).toBe('cancelled');
    client.complete();
    await ready(agent);
    expect(harness.bodies(agent.id)).toHaveLength(1);
  });

  it('settles stop after native completion without letting a late ACK overwrite cancelled input', async () => {
    const { app, harness, create, say, status, begin, ready } = await fixture();
    const agent = await create(true);
    const client = await begin(agent);
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    say(agent.channelId, 'Stopped input');
    await expect.poll(() => status(agent, 'Stopped input')).toBe('steering');
    client.complete();
    await app.isles.runtime.stop(agent.id);
    gate.resolve();
    expect(status(agent, 'Stopped input')).toBe('cancelled');
    expect(app.isles.store.publicAgent(agent.id).status).toBe('stopped');
    await app.isles.runtime.resume(agent.id);
    await ready(agent);
    expect(harness.bodies(agent.id)).toHaveLength(1);
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
  });

  it('persists the preference and an unacknowledged outcome across shutdown after native completion', async () => {
    const { app, harness, open, create, say, status, begin } = await fixture();
    const agent = await create(true);
    const client = await begin(agent);
    const gate = deferred();
    harness.onSteer = () => gate.promise;
    say(agent.channelId, 'Shutdown input');
    await expect.poll(() => status(agent, 'Shutdown input')).toBe('steering');
    client.complete();
    await app.close();
    const reopened = await open();
    expect(reopened.isles.store.publicAgent(agent.id)).toMatchObject({
      steerEnabled: true,
      threadId: agent.threadId,
      status: 'error',
    });
    const input = reopened.isles.store
      .listMessages(agent.channelId)
      .find((message) => message.body === 'Shutdown input')!;
    expect(input.deliveries[0]!.status).toBe('uncertain');
    expect(harness.bodies(agent.id)).toHaveLength(1);
    await reopened.isles.runtime.updateAgent(agent.id, { steerEnabled: false });
    await reopened.isles.runtime.resume(agent.id);
    await expect.poll(() => reopened.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(reopened.isles.store.publicAgent(agent.id)).toMatchObject({
      steerEnabled: false,
      threadId: agent.threadId,
    });
    expect(harness.bodies(agent.id)).toHaveLength(1);
  });
});
