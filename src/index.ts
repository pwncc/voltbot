import {clearInterval, setInterval} from 'node:timers';

import {
  ChannelType,
  cleanContent,
  type Message,
  MessageFlags,
  Routes,
  type TextChannel,
} from 'discord.js';

import {AIService, type EngagementDecision} from './ai';
import {DiscordClient} from './client';
import {isGuildEnabled, loadConfig} from './config';
import {Database} from './db';
import {transcribe} from './transcribe';
import {getAudioAttachments, hasAudioAttachment} from './util/attachments';
import {
  fetchChannelPreamble,
  fetchRecentChannelTranscript,
  type ChannelTranscriptMessage,
} from './util/channelPreamble';
import {sendMessage} from './util/message';

const config = loadConfig('./config.toml');
const discord = new DiscordClient();
const ai = new AIService();
const db = new Database(config.sqlite.path);

let BOT_PING_REGEX: RegExp;

const channelAmbientState = new Map<string, {lastAmbientAt: number}>();
let lastGlobalAmbientAt = 0;

const newestMiraMessageInDb = (
  decision: EngagementDecision,
  transcript: ChannelTranscriptMessage[]
) => {
  const candidates = [
    decision.targetMessageId,
    ...transcript
      .filter(m => m.isMira)
      .map(m => m.id)
      .reverse(),
  ].filter(Boolean) as string[];

  for (const id of candidates) {
    try {
      const dbId = BigInt(id);
      if (db.isInConvo(dbId)) {
        return dbId;
      }
    } catch {
      // Ignore malformed model ids.
    }
  }

  return null;
};

const ambientCooldownAllows = (channelId: string) => {
  const now = Date.now();
  const state = channelAmbientState.get(channelId);
  const channelCooldownMs =
    config.ambient_chat.channel_cooldown_minutes * 60_000;
  const globalCooldownMs = config.ambient_chat.global_cooldown_seconds * 1_000;

  return (
    (!state || now - state.lastAmbientAt >= channelCooldownMs) &&
    now - lastGlobalAmbientAt >= globalCooldownMs
  );
};

const markAmbientSpoke = (channelId: string) => {
  const now = Date.now();
  lastGlobalAmbientAt = now;
  channelAmbientState.set(channelId, {lastAmbientAt: now});
};

const renderFullMemoryChat = (messages: ReturnType<Database['getConversation']>, assistantResponse: string) =>
  [
    ...messages.map(m => {
      const name = m.nickname || m.username || m.discord_author_id.toString();
      const role = m.role === 'assistant' ? 'Volty' : name;
      return `[${m.id}] ${role}: ${m.content}`;
    }),
    `[response] Volty: ${assistantResponse}`,
  ].join('\n');

const memoryChatTitle = (messages: ReturnType<Database['getConversation']>) => {
  const firstUser = messages.find(m => m.role === 'user' && m.content.trim());
  if (!firstUser) {
    return 'Untitled conversation';
  }
  return firstUser.content.replace(/\s+/g, ' ').slice(0, 120);
};

discord.on('clientReady', () => {
  console.log(`Logged in as ${discord.user?.tag}`);
  BOT_PING_REGEX = new RegExp(`<@!?${discord.user!.id}>`, 'g');
});

discord.on('messageCreate', async msg => {
  try {
    if (!msg.guild || msg.channel.type === ChannelType.DM || msg.author.bot) {
      return;
    }

    if (!msg.guildId || !isGuildEnabled(msg.guildId)) {
      return;
    }

    const isPing = msg.mentions.has(discord.user!.id);
    const isReplyToBot = msg.mentions.repliedUser?.id === discord.user!.id;
    const isReplyToOther = !!msg.reference?.messageId && !isReplyToBot;
    let parentOverride: bigint | null | undefined;
    let engagementInstruction: string | null = null;
    let shouldReplyToUserMessage = true;
    const content = cleanContent(
      msg.content.replaceAll(BOT_PING_REGEX, ''),
      msg.channel
    ).trim();

    if (!isPing && !isReplyToBot) {
      if (msg.flags.has(MessageFlags.IsVoiceMessage)) {
        const [reply, transcribed] = await Promise.allSettled([
          msg.reply({
            content: '-# transcribing...',
            allowedMentions: {
              parse: [],
              repliedUser: false,
            },
          }),
          transcribe(msg.attachments.first()!.url),
        ]);

        if (reply.status === 'rejected') {
          return;
        }

        if (transcribed.status === 'rejected') {
          console.error('Failed to transcribe message:', transcribed.reason);
          reply.value.edit({
            content: '-# :x: failed to transcribe message',
            allowedMentions: {
              parse: [],
              repliedUser: false,
            },
          });

          return;
        }

        reply.value.edit({
          content: transcribed.value.text,
          allowedMentions: {
            parse: [],
            repliedUser: false,
          },
        });

        // TODO: insert this without text then update it?
        db.insertTranscription(
          BigInt(msg.id),
          transcribed.value.text,
          BigInt(msg.author.id),
          BigInt(reply.value.id)
        );

        return;
      }

      if (!config.ambient_chat.enabled || !('messages' in msg.channel)) {
        return;
      }

      if (!content) {
        return;
      }

      const transcript = await fetchRecentChannelTranscript(
        msg.channel,
        discord.user!.id,
        config.ambient_chat
      ).catch(err => {
        console.error('failed to fetch ambient transcript:', err);
        return [] as ChannelTranscriptMessage[];
      });

      if (!transcript.some(m => m.id === msg.id)) {
        transcript.push({
          id: msg.id,
          author:
            msg.member?.displayName ||
            msg.author.displayName ||
            msg.author.username,
          isBot: false,
          isMira: false,
          content: content
            .replace(/\s+/g, ' ')
            .slice(0, config.ambient_chat.max_chars_per_message),
        });
      }

      const decision = await ai.decideChannelEngagement({
        transcript,
        newestMessageId: msg.id,
        botUsername: discord.user!.username,
        channelName: msg.channel.parent?.name || msg.channel.name,
      });

      if (
        decision.mode === 'reply_to_mira' &&
        decision.confidence >= config.ambient_chat.reply_confidence
      ) {
        parentOverride = newestMiraMessageInDb(decision, transcript);
        if (!parentOverride) {
          return;
        }
        engagementInstruction = `The user did not mention Volty, but the engagement classifier judged this as an implicit reply to Volty. Respond as a natural continuation. Keep it compact. Angle: ${decision.angle}`;
      } else if (
        decision.mode === 'ambient_join' &&
        decision.confidence >= config.ambient_chat.ambient_confidence &&
        ambientCooldownAllows(msg.channel.id) &&
        Math.random() < config.ambient_chat.ambient_chance
      ) {
        parentOverride = null;
        shouldReplyToUserMessage = false;
        markAmbientSpoke(msg.channel.id);
        engagementInstruction = `Volty is casually joining the channel conversation. Send exactly one short Discord line, ideally under 14 words. No paragraph break, no polished explanation, usually no follow-up question. Do not dominate. Angle: ${decision.angle}`;
      } else {
        return;
      }

      console.log('ambient engagement:', decision);
    }

    const isReplyInConvo =
      !!msg.reference?.messageId &&
      db.isInConvo(BigInt(msg.reference!.messageId!));

    if (isPing && isReplyToOther && !isReplyToBot) {
      const repliedMsg = await msg.fetchReference();
      db.insertDiscordMessage(repliedMsg);
    }

    if (
      (!content && !isReplyToBot && !isReplyToOther) ||
      (isReplyToBot && !isReplyInConvo)
    ) {
      return;
    }

    db.insertDiscordMessage(msg, parentOverride);

    const convo = db.getConversation(BigInt(msg.id));
    const rootMessageId = convo[0]?.id.toString() || msg.id;
    const channelContextBeforeThread =
      convo.length >= config.channel_context.skip_if_thread_has_at_least
        ? null
        : await fetchChannelPreamble(
            msg.channel,
            rootMessageId,
            config.channel_context
          ).catch(err => {
            console.error('failed to fetch channel context:', err);
            return null;
          });

    msg.channel.sendTyping();
    const typingInterval = setInterval(
      () => msg.channel.sendTyping(),
      1_000 * 10
    );

    try {
      let sent: Message | undefined;
      const resp = ai.streamText({
        messages: convo,
        context: {
          replyingToMsgID: msg.id,
          botUsername: discord.user!.username,
          serverName: msg.guild!.name,
          channelName: msg.channel.parent?.name || msg.channel.name,
          channelDescription: (msg.channel as TextChannel).topic || '<none>',
          member: msg.member!,
          channel: msg.channel,
          db,
          channelContextBeforeThread,
          engagementInstruction,
        },
      });

      let final: any;
      let lastState: string | undefined;
      loop: for await (const part of resp) {
        let text = '';

        // console.log(part);

        switch (part.state) {
          case 'reasoning-delta': {
            if (lastState === 'reasoning-delta') {
              continue loop;
            }
            // text = `-# **Thinking...**\n${part.reasoning!.length > 700 ? '...' : ''}${part.reasoning!
            //   .slice(-700)
            //   .split('\n')
            //   .map(c => (c.trim() ? `-# ${c}` : ''))
            //   .join('\n')}`;
            text = '-# thinking...';
            break;
          }

          case 'text-delta': {
            if (config.response_agents.enabled) {
              continue loop;
            }
            text = `:pencil: ${part.text!.slice(-1_800)}`;
            break;
          }

          case 'tool-call': {
            text = part.tools!.map(t => `-# :tools: ${t}`).join('\n');
            break;
          }

          case 'finish': {
            text = part.fullText!;
            final = part;
            break loop;
          }
        }

        lastState = part.state;

        if (!text) {
          continue;
        }

        try {
          if (sent) {
            sent.edit({content: text});
          } else {
            const msgOptions = {
              content: text,
              flags: MessageFlags.SuppressEmbeds as MessageFlags.SuppressEmbeds,
              allowedMentions: {
                parse: ['users' as const],
                repliedUser: true,
              },
            };
            sent = shouldReplyToUserMessage
              ? await msg.reply(msgOptions)
              : await msg.channel.send(msgOptions);
          }
        } catch (err) {
          console.error('failed to send/edit message:', err);
        }
      }

      const {messages: sentMessages} = await sendMessage({
        channel: msg.channel as TextChannel,
        response: final.fullText,
        replyTo: shouldReplyToUserMessage ? msg : undefined,
        firstMsg: sent,
        usage: final.usage as any,
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
          username: sent.author.username || null,
          nickname:
            sent.member?.nickname ||
            sent.author.displayName ||
            sent.author.username ||
            null,
        });
        parentId = sent.id;
      }

      if (config.memory.enabled) {
        db.insertMemoryChat({
          guildID: BigInt(msg.guildId!),
          userID: BigInt(msg.author.id),
          sourceMessageID: BigInt(msg.id),
          title: memoryChatTitle(convo),
          transcript: renderFullMemoryChat(convo, final.fullText),
        });
      }

      void ai.extractMemories({
        messages: convo,
        assistantResponse: final.fullText,
        guildID: BigInt(msg.guildId!),
        sourceMessageID: BigInt(msg.id),
        db,
      });
    } catch (err) {
      if (
        err !== 'parent_message_deleted' &&
        !(
          err &&
          typeof err === 'object' &&
          'cause' in err &&
          err.cause === 'parent_message_deleted'
        )
      ) {
        console.error(err);
        msg.channel.send(':x: An error occurred.');
      }
    } finally {
      clearInterval(typingInterval);
    }
  } catch (err) {
    console.error('uncaught error in messageCreate handler:', err);
  }
});

discord.on('messageDelete', msg => {
  try {
    // fixme: this doesn't seem to be working properly?
    db.deleteChildren(BigInt(msg.id));
    if (ai.sending.has(msg.id)) {
      for (const ac of ai.sending.get(msg.id)!) {
        ac.abort('parent_message_deleted');
      }

      ai.sending.delete(msg.id);
    }

    // TODO: maybe check db if the message isn't cached?
    if (hasAudioAttachment(msg)) {
      const deleted = db.deleteTranscription(BigInt(msg.id));

      for (const d of deleted) {
        msg.client.rest.delete(
          Routes.channelMessage(
            msg.channel.id,
            d.transcription_message_id.toString()
          )
        );
      }
    }
  } catch (err) {
    console.error('uncaught error in messageDelete handler:', err);
  }
});

discord.on('messageUpdate', async msg => {
  try {
    if (msg.author?.bot) {
      return;
    }

    if (!db.isInConvo) {
      return;
    }

    const m = await msg.fetch(false);

    if (m.content) {
      db.updateMessage(BigInt(msg.id), m.content);
    }
  } catch (err) {
    console.error('uncaught error in messageUpdate handler:', err);
  }
});

discord.on('interactionCreate', async i => {
  try {
    if (i.isMessageContextMenuCommand()) {
      if (i.commandName === 'Transcribe') {
        // TODO: what should happen if there's more than one?
        const attachment = getAudioAttachments(i.targetMessage)[0];
        if (!attachment) {
          await i.reply({
            content: ':x: nothing to transcribe!',
            allowedMentions: {
              repliedUser: false,
            },
            flags: MessageFlags.Ephemeral,
          });

          return;
        }

        const rep = await i.deferReply();
        const vmURL = attachment.url;

        try {
          const transcription = await transcribe(vmURL);
          i.editReply({
            content: transcription.text,
            allowedMentions: {
              repliedUser: false,
            },
          });

          db.insertTranscription(
            BigInt(i.targetMessage.id),
            transcription.text,
            BigInt(i.targetMessage.author.id),
            BigInt(rep.id)
          );
        } catch (err) {
          console.error('failed to transcribe voice message in dm:', err);
          i.editReply({
            content: '-# :x: failed to transcribe message',
            allowedMentions: {
              repliedUser: false,
            },
          });
        }

        return;
      }
    }
  } catch (err) {
    console.log('uncaught error in interactionCreate handler:', err);
  }
});

discord.login(config.discord.token);
