import {tool} from 'ai';
import {
  ChannelType,
  type GuildBasedChannel,
  type GuildMember,
  type TextBasedChannel,
} from 'discord.js';
import {z} from 'zod';

const channelTypeName = (type: ChannelType) =>
  ChannelType[type] || String(type);

const roleSummary = (member: GuildMember) =>
  member.roles?.cache
    ?.filter(r => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map(r => ({id: r.id, name: r.name}))
    .slice(0, 25) || [];

const userInfo = (member: GuildMember) => {
  const user = member.user || (member as any).client?.user;
  return {
    id: member.id,
    username: user?.username || member.id,
    globalName: user?.globalName || null,
    displayName:
      member.displayName || user?.displayName || user?.username || member.id,
    nickname: member.nickname || null,
    accountCreatedAt: user?.createdAt?.toISOString?.() || null,
    avatarURL:
      member.displayAvatarURL?.({size: 512}) ||
      user?.displayAvatarURL?.({size: 512}) ||
      null,
  };
};

const serializeChannel = (ch: GuildBasedChannel | TextBasedChannel | null) => {
  if (!ch || !('id' in ch)) {
    return null;
  }

  const guildChannel = 'guild' in ch ? ch : null;
  return {
    id: ch.id,
    name: 'name' in ch ? ch.name : null,
    type: 'type' in ch ? channelTypeName(ch.type) : null,
    topic: 'topic' in ch ? ch.topic || null : null,
    nsfw: 'nsfw' in ch ? ch.nsfw : null,
    parent:
      guildChannel && 'parent' in guildChannel && guildChannel.parent
        ? {id: guildChannel.parent.id, name: guildChannel.parent.name}
        : null,
  };
};

export const discordContextTools = ({
  member,
  channel,
}: {
  member: GuildMember;
  channel?: TextBasedChannel | null;
}) => ({
  get_current_discord_context: tool({
    description:
      'Get the current Discord server, channel, and user context. Use this when Volty needs to know where he is, what channel this is, server metadata, or who he is replying to.',
    inputSchema: z.object({}),

    async execute() {
      const guild = member.guild;
      return {
        server: {
          id: guild.id,
          name: guild.name,
          description: guild.description || null,
          vanityURLCode: guild.vanityURLCode || null,
          preferredLocale: guild.preferredLocale,
          memberCount: guild.memberCount,
          premiumTier: guild.premiumTier,
          createdAt: guild.createdAt?.toISOString?.() || null,
          features: guild.features || [],
        },
        channel: serializeChannel(channel || null),
        currentUser: {
          ...userInfo(member),
          roles: roleSummary(member),
          joinedAt: member.joinedAt?.toISOString() || null,
          bio: null,
          bioNote:
            'Discord bot APIs do not expose arbitrary user profile bios/About Me fields.',
        },
      };
    },
  }),

  get_discord_user_profile: tool({
    description:
      'Fetch server-visible profile info for a member by Discord user id. Includes roles, join date, display names, avatar URL, and a note that Discord bios are not available to bots.',
    inputSchema: z.object({
      userId: z.string().describe('Discord user id to look up.'),
    }),

    async execute({userId}) {
      try {
        const target =
          member.guild.members.cache.get(userId) ||
          (await member.guild.members.fetch(userId));
        if (!target) {
          return {error: 'Member not found in this server.'};
        }

        return {
          ...userInfo(target),
          roles: roleSummary(target),
          joinedAt: target.joinedAt?.toISOString() || null,
          bio: null,
          bioNote:
            'Discord bot APIs do not expose arbitrary user profile bios/About Me fields.',
        };
      } catch (err) {
        return {
          error: 'Failed to fetch member.',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  }),

  get_discord_channel_info: tool({
    description:
      'Fetch information about the current channel or a specific server channel by id.',
    inputSchema: z.object({
      channelId: z
        .string()
        .nullish()
        .describe('Optional Discord channel id. Omit for current channel.'),
    }),

    async execute({channelId}) {
      if (!channelId) {
        return serializeChannel(channel || null) || {error: 'No current channel.'};
      }

      const ch =
        member.guild.channels.cache.get(channelId) ||
        (await member.guild.channels.fetch(channelId).catch(() => null));
      if (!ch) {
        return {error: 'Channel not found or inaccessible.'};
      }
      return serializeChannel(ch);
    },
  }),
});
