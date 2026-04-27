import {cleanContent, type TextBasedChannel} from 'discord.js';

import type {AmbientChatConfig, ChannelContextConfig} from '../config';

const trimLine = (s: string, max: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
};

/**
 * Fetches recent messages in the same channel before the conversation root.
 * The returned text is newest-context-biased and capped so vague prompts like
 * "what do you think?" get useful channel background without ballooning tokens.
 */
export const fetchChannelPreamble = async (
  channel: TextBasedChannel,
  beforeMessageId: string,
  opts: ChannelContextConfig
) => {
  if (!opts.enabled || !('messages' in channel)) {
    return null;
  }

  const batch = await channel.messages.fetch({
    before: beforeMessageId,
    limit: opts.max_messages,
  });

  if (!batch.size) {
    return null;
  }

  const lines: string[] = [];
  for (const m of Array.from(batch.values()).reverse()) {
    if (!opts.include_bots && m.author.bot) {
      continue;
    }

    const text = cleanContent(m.content, m.channel).trim();
    if (!text) {
      continue;
    }

    const name =
      m.member?.displayName || m.author.displayName || m.author.username;
    lines.push(`${name}: ${trimLine(text, opts.max_chars_per_message)}`);
  }

  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const next = used ? used + line.length + 1 : line.length;
    if (next > opts.max_total_chars) {
      break;
    }
    kept.unshift(line);
    used = next;
  }

  if (!kept.length) {
    return null;
  }

  const omitted = lines.length - kept.length;
  return omitted > 0
    ? [`(${omitted} older messages omitted)`, ...kept].join('\n')
    : kept.join('\n');
};

export type ChannelTranscriptMessage = {
  id: string;
  author: string;
  isBot: boolean;
  isMira: boolean;
  content: string;
};

export const fetchRecentChannelTranscript = async (
  channel: TextBasedChannel,
  botUserId: string,
  opts: Pick<
    AmbientChatConfig,
    'max_messages' | 'max_total_chars' | 'max_chars_per_message'
  >
) => {
  if (!('messages' in channel)) {
    return [];
  }

  const batch = await channel.messages.fetch({limit: opts.max_messages});
  const lines: ChannelTranscriptMessage[] = [];

  for (const m of Array.from(batch.values()).reverse()) {
    const text = cleanContent(m.content, m.channel).trim();
    if (!text) {
      continue;
    }

    const author =
      m.member?.displayName || m.author.displayName || m.author.username;
    lines.push({
      id: m.id,
      author,
      isBot: m.author.bot,
      isMira: m.author.id === botUserId,
      content: trimLine(text, opts.max_chars_per_message),
    });
  }

  const kept: ChannelTranscriptMessage[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const rendered = renderTranscriptLine(line);
    const next = used ? used + rendered.length + 1 : rendered.length;
    if (next > opts.max_total_chars) {
      break;
    }
    kept.unshift(line);
    used = next;
  }

  return kept;
};

export const renderTranscriptLine = (m: ChannelTranscriptMessage) =>
  `[${m.id}] ${m.isMira ? 'Volty' : m.author}: ${m.content}`;
