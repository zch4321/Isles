import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentRoot } from '../runtime/workspace.js';
import { HttpError } from '../errors.js';
import {
  channelView,
  directoryOf,
  formatChannelMessages,
  formatMessages,
} from '../runtime/envelope.js';
import type { Runtime } from '../runtime/runtime.js';

const agentIds = z
  .array(z.string().uuid())
  .max(50)
  .describe(
    'Full Agent IDs from list_agents or list_channels. Names and short IDs are display only.',
  );
const messageChannel = z
  .union([z.literal('private'), z.string().uuid()])
  .describe(
    'Full channel ID from list_channels, or private for your chat with the human. Names and short IDs are display only.',
  );

export function registerMcp(app: FastifyInstance, runtime: Runtime) {
  app.route<{ Params: { id: string } }>({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp/:id',
    async handler(request, reply) {
      const store = runtime.store;
      const agent = store.getAgent(request.params.id);
      if (agent.status === 'deleted') throw new HttpError(401, 'Agent 已删除，MCP 身份已失效');
      let token: string;
      try {
        token = (
          await readFile(
            join(agentRoot(runtime.workspace.dataDir, agent), 'isles-mcp-token'),
            'utf8',
          )
        ).trim();
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
      if (store.getAgent(agent.id).status === 'deleted')
        throw new HttpError(401, 'Agent 已删除，MCP 身份已失效');
      const id = agent.id;
      const server = new McpServer({ name: 'isles', version: '0.4.0' });
      const resolveChannel = (channelId: string) =>
        channelId === 'private' ? agent.channelId : channelId;
      // Membership and permissions are read again on every call, not from this connection.
      const member = (channelId: string) => {
        store.getChannel(channelId);
        if (store.groupDeletedAt(channelId) !== null)
          throw new HttpError(410, '群聊已删除，不能继续访问');
        if (!store.isMember(channelId, id)) throw new HttpError(403, '只能访问自己所在的频道');
      };
      const result = (value: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      });
      const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });
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
            'Publish an official message to a channel you belong to; private aliases your private chat. Use the full channel ID from list_channels for a group. replyTo is a sequence in that same channel. Sender is bound by the server. Use a stable clientId to deduplicate retries. Returns seq in the targeted channel.',
          inputSchema: {
            channelId: messageChannel,
            body: z.string().trim().min(1).max(32_000),
            replyTo: z.number().int().positive().optional(),
            mentions: agentIds
              .optional()
              .describe('Full Agent IDs of channel members this message specifically addresses.'),
            clientId: z.string().min(1).max(120).optional(),
          },
          annotations: { destructiveHint: false, openWorldHint: false },
        },
        ({ channelId, body, replyTo, mentions, clientId }) => {
          channelId = resolveChannel(channelId);
          member(channelId);
          const message = runtime.publish(id, channelId, {
            body,
            clientId: clientId ?? randomUUID(),
            replyTo,
            mentions,
          });
          return result({ seq: message.seq });
        },
      );
      server.registerTool(
        'read_messages',
        {
          description:
            'Read saved history, including paused groups, as the text blocks documented in AGENTS.md. private aliases your private chat. Without after/before return the latest page; use next_after or next_before markers for paging. Only returned messages are recorded as received by you and will not be automatically delivered again.',
          inputSchema: {
            channelId: messageChannel,
            after: z.number().int().min(0).optional(),
            before: z.number().int().min(1).optional(),
            limit: z.number().int().min(1).max(100).default(50),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ channelId, after, before, limit }) => {
          channelId = resolveChannel(channelId);
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
          const storedChannel = store.getChannel(channelId);
          const labels = runtime.messageLabels(id);
          let text = formatChannelMessages(labels, storedChannel, page) || '[history: empty]';
          if (more)
            text += `\n\n[channel: ${labels.channel(storedChannel)}, ${forward ? 'next_after' : 'next_before'}: ${forward ? page.at(-1)!.seq : page[0]!.seq}]`;
          const response = textResult(text);
          store.markMessagesReceived(id, page);
          return response;
        },
      );
      server.registerTool(
        'receive_messages',
        {
          description:
            'Receive queued messages during your current turn as the text blocks documented in AGENTS.md. Omit channelId for all your channels, including paused groups; private aliases your private chat. Returns immediately. Call again on [has_more: true]. Only returned messages are marked received and will not trigger another turn. Skipped history remains available through read_messages.',
          inputSchema: {
            channelId: messageChannel.optional(),
            limit: z.number().int().min(1).max(100).default(50),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ channelId, limit }) => {
          const { input, hasMore } = runtime.receiveMessages(id, {
            channelId: channelId === undefined ? undefined : resolveChannel(channelId),
            limit,
          });
          const text = formatMessages(runtime.messageLabels(id), input) || '[unread: none]';
          return textResult(text + (hasMore ? '\n\n[has_more: true]' : ''));
        },
      );
      server.registerTool(
        'list_channels',
        {
          description:
            'List your channels with full channel IDs, names, members and paused state. Match the names/short suffixes shown in messages to these records, then use a full ID for group tool calls.',
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        () => result({ channels: store.channelsOf(id).map((c) => channel(c.id)) }),
      );
      server.registerTool(
        'list_agents',
        {
          description:
            'List active Isles Agents with full IDs, names, harnesses and models. Match the names/short suffixes shown in messages to these records and use full IDs for mentions or invitations. Agents are independent and do not share context.',
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
