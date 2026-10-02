import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentRoot } from '../codex/environment.js';
import { HttpError } from '../errors.js';
import { agentView, channelView, directoryOf, unreadEnvelope } from '../runtime/envelope.js';
import type { Runtime } from '../runtime/runtime.js';

const agentIds = z.array(z.string().uuid()).max(50);

export function registerMcp(app: FastifyInstance, runtime: Runtime) {
  app.route<{ Params: { id: string } }>({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp/:id',
    async handler(request, reply) {
      const store = runtime.store;
      const agent = store.getAgent(request.params.id);
      let token: string;
      try {
        token = (await readFile(join(agentRoot(agent), 'isles-mcp-token'), 'utf8')).trim();
      } catch {
        throw new HttpError(401, 'MCP Agent 身份无效');
      }
      const authorization = request.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (
        authorization.length !== expected.length ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
      )
        throw new HttpError(401, 'MCP Agent 身份无效');
      const id = agent.id;
      const server = new McpServer({ name: 'isles', version: '0.3.0' });
      // Membership and permissions are read again on every call, not from this connection.
      const member = (channelId: string) => {
        store.getChannel(channelId);
        if (!store.isMember(channelId, id)) throw new HttpError(403, '只能访问自己所在的频道');
      };
      const result = (value: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      });
      const channel = (channelId: string) => {
        const directory = directoryOf(store.listAgents());
        const value = store.publicChannel(channelId);
        return {
          ...channelView(value),
          paused: value.paused,
          members: value.memberIds.map((m) => ({
            id: m,
            name: directory.get(m)?.name ?? null,
            model: directory.get(m)?.model ?? null,
          })),
        };
      };
      server.registerTool(
        'send_message',
        {
          description:
            'Publish an official message to a private chat or group you belong to. Everyone in a group sees it. Sender is bound by the server. Use a stable clientId to deduplicate retries.',
          inputSchema: {
            channelId: z.string().uuid(),
            body: z.string().trim().min(1).max(32_000),
            replyTo: z.string().uuid().optional(),
            mentions: agentIds
              .optional()
              .describe('IDs of channel members this message specifically addresses.'),
            clientId: z.string().min(1).max(120).optional(),
          },
          annotations: { destructiveHint: false, openWorldHint: false },
        },
        ({ channelId, body, replyTo, mentions, clientId }) => {
          member(channelId);
          const message = runtime.publish(id, channelId, {
            body,
            clientId: clientId ?? randomUUID(),
            replyTo,
            mentions,
          });
          return result({ message_id: message.id, seq: message.seq, channel_id: channelId });
        },
      );
      server.registerTool(
        'read_messages',
        {
          description:
            'Read saved history of a channel you belong to, including paused groups, in ascending sequence order. Without after/before it returns the latest page; continue with nextAfter or nextBefore when present. Only messages actually returned are recorded as received by you and will not be automatically delivered again.',
          inputSchema: {
            channelId: z.string().uuid(),
            after: z.number().int().min(0).optional(),
            before: z.number().int().min(1).optional(),
            limit: z.number().int().min(1).max(100).default(50),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ channelId, after, before, limit }) => {
          member(channelId);
          if (after !== undefined && before !== undefined)
            throw new HttpError(400, '不能同时指定 after 和 before');
          const all = store.listMessages(channelId, {
            ...(after !== undefined ? { after } : {}),
            ...(before !== undefined ? { before } : {}),
            limit: limit + 1,
          });
          const forward = after !== undefined;
          const page = forward ? all.slice(0, limit) : all.slice(-limit);
          const more = all.length > limit;
          const directory = directoryOf(store.listAgents());
          const response = result({
            ...channelView(store.getChannel(channelId)),
            messages: page.map((m) => agentView(m, id, directory)),
            nextAfter: forward && more ? page.at(-1)!.seq : null,
            nextBefore: !forward && more ? page[0]!.seq : null,
          });
          store.markMessagesReceived(
            id,
            page.map((m) => m.id),
          );
          return response;
        },
      );
      server.registerTool(
        'receive_messages',
        {
          description:
            'Receive queued messages during your current turn, oldest first and grouped by channel. Omit channelId to check all your channels, including paused groups. Returns immediately, even if empty; call again when has_more is true. Only returned messages are recorded as received and will not trigger another turn. Older messages skipped from automatic input remain available through read_messages.',
          inputSchema: {
            channelId: z.string().uuid().optional(),
            limit: z.number().int().min(1).max(100).default(50),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ channelId, limit }) => {
          const { input, hasMore } = runtime.receiveMessages(id, { channelId, limit });
          return result({
            ...unreadEnvelope(id, input, directoryOf(store.listAgents())),
            has_more: hasMore,
          });
        },
      );
      server.registerTool(
        'list_channels',
        {
          description:
            'List the channels you belong to: your private chat with the user and your groups, with their members and paused state.',
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        () => result({ channels: store.channelsOf(id).map((c) => channel(c.id)) }),
      );
      server.registerTool(
        'list_agents',
        {
          description:
            'List every Isles Agent as a contact directory, with its harness and model. Agents are independent and do not share context.',
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        () =>
          result({
            agents: store.listAgents().map((a) => ({
              id: a.id,
              name: a.name,
              harness: a.harness,
              model: a.model,
              you: a.id === id,
            })),
          }),
      );
      if (agent.canCreateGroups) {
        server.registerTool(
          'create_group',
          {
            description:
              'Create a group with you as a member and invite existing Agents. Only the user can create Agents or remove members.',
            inputSchema: { name: z.string().trim().min(1).max(80), memberIds: agentIds },
            annotations: { destructiveHint: false, openWorldHint: false },
          },
          ({ name, memberIds }) => result(channel(runtime.createGroup(id, { name, memberIds }).id)),
        );
        server.registerTool(
          'invite_to_group',
          {
            description:
              'Invite existing Agents into a group you belong to. New members can read the full history.',
            inputSchema: { channelId: z.string().uuid(), agentIds: agentIds.min(1) },
            annotations: { destructiveHint: false, openWorldHint: false },
          },
          ({ channelId, agentIds }) => {
            member(channelId);
            runtime.addMembers(channelId, id, agentIds);
            return result(channel(channelId));
          },
        );
      }
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      // SDK 1.31's Node transport declares optional callback values differently
      // under exactOptionalPropertyTypes; its runtime implements Transport.
      await server.connect(transport as Transport);
      reply.hijack();
      reply.raw.once('close', () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}
