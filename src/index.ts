import {clearInterval, setInterval} from 'node:timers';

import {ChannelType, cleanContent, type TextChannel} from 'discord.js';

import {AIService} from './ai';
import {DiscordClient} from './client';
import {isGuildEnabled, loadConfig} from './config';
import {Database} from './db';
import {sendMessage} from './util/message';

const config = loadConfig('./config.toml');
const discord = new DiscordClient();
const ai = new AIService();
const db = new Database(config.sqlite.path);

let BOT_PING_REGEX: RegExp;

const isBotMentioned = (content: string) => BOT_PING_REGEX.test(content);

discord.on('clientReady', () => {
  console.log(`Logged in as ${discord.user?.tag}`);
  BOT_PING_REGEX = new RegExp(`<@!?${discord.user!.id}>`, 'g');
});

discord.on('messageCreate', async msg => {
  if (!msg.guild || msg.channel.type === ChannelType.DM || msg.author.bot) {
    return;
  }

  if (!msg.guildId || !isGuildEnabled(msg.guildId)) {
    return;
  }

  const isPing = isBotMentioned(msg.content);
  const isReply =
    !!msg.reference?.messageId &&
    msg.mentions.repliedUser &&
    msg.mentions.has(msg.mentions.repliedUser) &&
    db.isInConvo(BigInt(msg.reference.messageId)) &&
    (await msg.fetchReference().then(r => r.author.id === discord.user!.id));

  if (!isPing && !isReply) {
    return;
  }

  const content = cleanContent(
    msg.content.replaceAll(BOT_PING_REGEX, ''),
    msg.channel
  ).trim();
  if (!content) {
    return;
  }

  if (msg.author.id !== discord.user!.id) {
    // cm.addMessage({
    //   content: `[Username: "${msg.author.username}", Nickname: "${msg.member?.nickname || msg.author.displayName || msg.author.username}"]: ${content}`,
    //   messageID: msg.id,
    //   parent: msg.reference?.messageId,
    //   author: msg.author.username,
    //   authorID: msg.author.id,
    //   role: 'user',
    //   threadID: threadId,
    //   startOfThread: isPing && !msg.reference,
    //   images: [
    //     ...msg.attachments
    //       .filter(a => a.contentType?.startsWith('image'))
    //       .mapValues(v => v.url)
    //       .values(),
    //   ].slice(0, 2),
    // });

    const image =
      msg.attachments
        .filter(a => a.contentType?.startsWith('image'))
        .mapValues(v => v.url)
        .first() || null;

    db.insertMessage({
      id: BigInt(msg.id),
      content: `[Username: "${msg.author.username}", Nickname: "${msg.member?.nickname || msg.author.displayName || msg.author.username}"]: ${content}`,
      discord_author_id: BigInt(msg.author.id),
      discord_guild_id: BigInt(msg.guildId),
      parent: BigInt(msg.reference?.messageId || 0) || null,
      role: 'user',
      image_url: image,
    });
  }

  const convo = db.getConversation(BigInt(msg.id));

  msg.channel.sendTyping();
  const typingInterval = setInterval(
    () => msg.channel.sendTyping(),
    1_000 * 10
  );

  try {
    const response = await ai.generateText({
      messages: convo,
      context: {
        botUsername: discord.user!.username,
        serverName: msg.guild!.name,
        channelName: msg.channel.parent?.name || msg.channel.name,
        channelDescription: (msg.channel as TextChannel).topic || '<none>',
      },
    });

    // TODO: should reasoning text be saved for subsequent requests?

    if (!response.text) {
      console.error('no text????');
    }

    const {messages: sentMessages} = await sendMessage({
      ai,
      convo,
      channel: msg.channel as TextChannel,
      response: response.text,
      replyTo: msg,
      usage: response.usage,
    });

    let parentId = msg.id;

    for (const sent of sentMessages) {
      db.insertMessage({
        id: BigInt(sent.id),
        role: 'assistant',
        content: sent.content || '',
        discord_author_id: BigInt(sent.author.id),
        discord_guild_id: BigInt(sent.guildId!),
        parent: BigInt(parentId),
        image_url: null,
      });
      parentId = sent.id;
    }
  } catch (err) {
    console.error(err);
    msg.channel.send(':x: An error occurred.');
  } finally {
    clearInterval(typingInterval);
  }
});

discord.on('messageDelete', msg => {
  db.deleteChildren(BigInt(msg.id));
});

discord.login(config.discord.token);
