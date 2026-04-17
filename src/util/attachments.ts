import {type Message, MessageFlags} from 'discord.js';

export const hasAudioAttachment = (
  msg: Pick<Message, 'flags' | 'attachments'>
) =>
  msg.flags.has(MessageFlags.IsVoiceMessage) ||
  msg.attachments.some(a => a.contentType?.startsWith('audio/'));

export const audioAttachments = (
  msg: Pick<Message, 'flags' | 'attachments'>
) => [
  ...msg.attachments.filter(a => a.contentType?.startsWith('audio/')).values(),
];
