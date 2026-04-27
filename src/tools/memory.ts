import {tool} from 'ai';
import type {GuildMember} from 'discord.js';
import {z} from 'zod';

import type {Database} from '../db';

const resolveUserId = async ({
  member,
  db,
  userId,
  userName,
}: {
  member: GuildMember;
  db: Database;
  userId?: string | null;
  userName?: string | null;
}) => {
  if (userId?.trim()) {
    return BigInt(userId.trim());
  }

  const name = userName?.trim();
  if (!name) {
    return BigInt(member.id);
  }

  const lower = name.toLowerCase();
  const cached = member.guild.members.cache.find(
    m =>
      m.user.username.toLowerCase() === lower ||
      m.displayName.toLowerCase() === lower ||
      m.nickname?.toLowerCase() === lower
  );
  if (cached) {
    return BigInt(cached.id);
  }

  const row = db.db
    .prepare(
      `select discord_author_id
       from messages
       where discord_guild_id = ?
         and (
           lower(coalesce(username, '')) = ?
           or lower(coalesce(nickname, '')) = ?
         )
       order by id desc
       limit 1`
    )
    .get(BigInt(member.guild.id), lower, lower) as
    | {discord_author_id: bigint}
    | undefined;
  return row?.discord_author_id || null;
};

export const memoryTools = (member: GuildMember, db: Database) => ({
  remember_for_later: tool({
    description:
      "Privately save a compact memory when Volty decides something should matter later. Use sparingly for stable user facts, preferences, recurring bits, current projects, boundaries, relationship context, or Volty's own diary-like bot memories. This is not a user command.",
    inputSchema: z.object({
      scope: z
        .enum(['current_user', 'server', 'Volty'])
        .describe(
          'current_user for the person Volty is replying to, server for group context, Volty for Volty diary/self-memory.'
        ),
      kind: z
        .enum([
          'user_fact',
          'preference',
          'relationship',
          'ongoing_topic',
          'bot_memory',
        ])
        .default('ongoing_topic'),
      content: z
        .string()
        .min(8)
        .max(220)
        .describe('Short third-person note. Do not save secrets or generic filler.'),
      salience: z.number().int().min(1).max(5).default(3),
    }),

    async execute({scope, kind, content, salience}) {
      const userID =
        scope === 'current_user'
          ? BigInt(member.id)
          : scope === 'Volty'
            ? BigInt(member.client.user.id)
            : null;
      const memoryKind = scope === 'Volty' ? 'bot_memory' : kind;

      db.insertMemory({
        discord_guild_id: BigInt(member.guild.id),
        discord_user_id: userID,
        kind: memoryKind,
        content,
        salience,
        source_message_id: null,
      });

      return {saved: true};
    },
  }),

  search_compact_memories: tool({
    description:
      'Search Volty compact memory notes for the current server. Use this when Volty needs specific remembered facts about a user/topic beyond the injected current-user memory.',
    inputSchema: z.object({
      query: z.string().min(2).describe('Keyword/topic/user detail to search.'),
      userId: z
        .string()
        .nullish()
        .describe('Optional Discord user id to restrict the search.'),
      userName: z
        .string()
        .nullish()
        .describe('Optional username/display name to restrict the search.'),
      limit: z.number().int().min(1).max(12).default(8),
    }),

    async execute({query, userId, userName, limit}) {
      const resolvedUserId = await resolveUserId({member, db, userId, userName});
      const q = `%${query.toLowerCase()}%`;
      const rows = db.db
        .prepare(
          `select id, discord_user_id, kind, content, salience, last_seen_at, source_message_id
           from memories
           where discord_guild_id = ?
             and (? is null or discord_user_id = ?)
             and lower(content) like ?
           order by salience desc, last_seen_at desc, id desc
           limit ?`
        )
        .all(
          BigInt(member.guild.id),
          resolvedUserId,
          resolvedUserId,
          q,
          limit
        ) as {
        id: number;
        discord_user_id: bigint | null;
        kind: string;
        content: string;
        salience: number;
        last_seen_at: bigint;
        source_message_id: bigint | null;
      }[];

      return {
        resolvedUserId: resolvedUserId?.toString() || null,
        results: rows.map(r => ({
          id: r.id,
          userId: r.discord_user_id?.toString() || null,
          kind: r.kind,
          content: r.content,
          salience: r.salience,
          lastSeenAt: new Date(Number(r.last_seen_at) * 1000).toISOString(),
          sourceMessageId: r.source_message_id?.toString() || null,
        })),
      };
    },
  }),

  get_relationship_profile: tool({
    description:
      'Look up Volty relationship map for a user in the current server: trust, familiarity, affinity, tone, and notes.',
    inputSchema: z.object({
      userId: z
        .string()
        .nullish()
        .describe('Optional Discord user id. Omit for the current user.'),
      userName: z
        .string()
        .nullish()
        .describe('Optional username/display name if userId is unknown.'),
    }),

    async execute({userId, userName}) {
      const resolvedUserId = await resolveUserId({member, db, userId, userName});
      if (!resolvedUserId) {
        return {error: 'Could not resolve user.'};
      }

      const relationship = db.getRelationship(
        BigInt(member.guild.id),
        resolvedUserId
      );
      if (!relationship) {
        return {
          userId: resolvedUserId.toString(),
          relationship: null,
          note: 'No relationship record yet.',
        };
      }

      return {
        userId: resolvedUserId.toString(),
        trust: relationship.trust,
        familiarity: relationship.familiarity,
        affinity: relationship.affinity,
        tone: relationship.tone,
        notes: relationship.notes,
        updatedAt: new Date(Number(relationship.updated_at) * 1000).toISOString(),
      };
    },
  }),

  search_memory_chats: tool({
    description:
      'Search archived full conversation transcripts when compact memories are not detailed enough. Use this for past conversations, running jokes, user projects, sona details, or relationship context that needs specifics.',
    inputSchema: z.object({
      query: z
        .string()
        .min(2)
        .describe('Keywords, user name, project, sona, joke, or topic to find.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(5)
        .describe('Maximum number of transcript matches to return.'),
    }),

    async execute({query, limit}) {
      const results = db.searchMemoryChats({
        guildID: BigInt(member.guild.id),
        userID: BigInt(member.id),
        query,
        limit,
      });

      if (!results.length) {
        return {
          results: [],
          note: 'No archived chats matched. Use current context and compact memories.',
        };
      }

      return {
        results: results.map(r => ({
          id: r.id,
          title: r.title,
          sourceMessageId: r.source_message_id.toString(),
          createdAt: new Date(Number(r.created_at) * 1000).toISOString(),
        })),
      };
    },
  }),

  fetch_memory_chat: tool({
    description:
      'Fetch one archived full conversation transcript by id after search_memory_chats finds a relevant result.',
    inputSchema: z.object({
      id: z.number().int().min(1).describe('The memory chat id to read.'),
    }),

    async execute({id}) {
      const chat = db.fetchMemoryChat({
        guildID: BigInt(member.guild.id),
        userID: BigInt(member.id),
        id,
      });

      if (!chat) {
        return {error: 'No accessible archived chat with that id.'};
      }

      return {
        id: chat.id,
        title: chat.title,
        sourceMessageId: chat.source_message_id.toString(),
        createdAt: new Date(Number(chat.created_at) * 1000).toISOString(),
        transcript: chat.transcript,
      };
    },
  }),
});
