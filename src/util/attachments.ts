import {type Message, MessageFlags} from 'discord.js';

const DISABLED_FORMATS = new Set(['audio/mp4']);

export const hasAudioAttachment = (
  msg: Pick<Message, 'flags' | 'attachments'>
) =>
  msg.flags.has(MessageFlags.IsVoiceMessage) ||
  msg.attachments.some(
    a =>
      a.contentType?.startsWith('audio/') &&
      !DISABLED_FORMATS.has(a.contentType)
  );

export const getAudioAttachments = (
  msg: Pick<Message, 'flags' | 'attachments'>
) => [
  ...msg.attachments
    .filter(
      a =>
        a.contentType?.startsWith('audio/') &&
        !DISABLED_FORMATS.has(a.contentType)
    )
    .values(),
];
