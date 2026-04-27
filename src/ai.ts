import {existsSync, readFileSync, statSync} from 'node:fs';
import {basename, extname} from 'node:path';

import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {
  embed,
  embedMany,
  generateText,
  type ModelMessage,
  Output,
  type SystemModelMessage,
  stepCountIs,
  streamText,
} from 'ai';
import {createOllama} from 'ai-sdk-ollama';
import type {GuildMember} from 'discord.js';
import type {TextBasedChannel} from 'discord.js';
import {z} from 'zod';

import {config} from './config';
import type {Database, DBMessage} from './db';
import {discordContextTools} from './tools/discordContext';
import {discordMessageTools} from './tools/discordMessage';
import {memoryTools} from './tools/memory';
import {ragTools} from './tools/rag';
import {currentTime} from './tools/time';
import {getPageContents, webSearch} from './tools/webSearch';
import {
  renderTranscriptLine,
  type ChannelTranscriptMessage,
} from './util/channelPreamble';

export type Role = 'user' | 'assistant' | 'system';

const boundedString = (max: number) =>
  z.coerce.string().transform(s => s.slice(0, max));

const mediaTypes: Record<string, string> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const mediaTypeFor = (src: string) =>
  mediaTypes[extname(src.split('?')[0] || src).toLowerCase()] ||
  'application/octet-stream';

const isHttpUrl = (src: string) => /^https?:\/\//i.test(src);

const canReadLocalMedia = (src: string) => {
  try {
    if (!existsSync(src)) {
      return false;
    }
    const st = statSync(src);
    return st.isFile() && st.size <= (config.model.max_media_bytes || 25_000_000);
  } catch {
    return false;
  }
};

const toMediaPart = (src: string) => {
  const mediaType = mediaTypeFor(src);
  const isImage = mediaType.startsWith('image/');
  const isVideo = mediaType.startsWith('video/');
  if (!isImage && !(isVideo && config.model.include_video)) {
    return null;
  }

  if (isHttpUrl(src)) {
    const url = new URL(src);
    return isImage
      ? {type: 'image' as const, image: url, mediaType}
      : {
          type: 'file' as const,
          data: url,
          filename: basename(url.pathname),
          mediaType,
        };
  }

  if (!canReadLocalMedia(src)) {
    return null;
  }

  const data = readFileSync(src);
  return isImage
    ? {type: 'image' as const, image: data, mediaType}
    : {
        type: 'file' as const,
        data,
        filename: basename(src),
        mediaType,
      };
};

const engagementDecisionSchema = z.object({
  mode: z.enum(['ignore', 'reply_to_mira', 'ambient_join']),
  confidence: z.number().min(0).max(1),
  targetMessageId: z.coerce
    .string()
    .nullish()
    .transform(v => v ?? null),
  reason: boundedString(240),
  angle: boundedString(240),
});

export type EngagementDecision = z.infer<typeof engagementDecisionSchema>;

const extractedMemorySchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z
          .string()
          .catch('ongoing_topic')
          .transform(kind => {
          const normalized = kind.toLowerCase().replace(/[^a-z]+/g, '_');
          if (
            [
              'user_fact',
              'preference',
              'relationship',
              'ongoing_topic',
              'bot_memory',
            ].includes(normalized)
          ) {
            return normalized as
              | 'user_fact'
              | 'preference'
              | 'relationship'
              | 'ongoing_topic'
              | 'bot_memory';
          }
          return 'ongoing_topic';
        }),
        userId: z.coerce
          .string()
          .nullish()
          .transform(v => v ?? null),
        userName: z.coerce
          .string()
          .nullish()
          .transform(v => v ?? null),
        content: z.string().min(8).max(220),
        salience: z.coerce.number().int().min(1).max(5).default(3),
      })
    )
    .max(5),
  relationships: z
    .array(
      z.object({
        userId: z.coerce.string(),
        userName: z.coerce
          .string()
          .nullish()
          .transform(v => v ?? null),
        trust: z.coerce.number().int().min(1).max(5).default(1),
        familiarity: z.coerce.number().int().min(1).max(5).default(1),
        affinity: z.coerce.number().int().min(-3).max(3).default(0),
        tone: z.string().max(80).nullish().transform(v => v ?? null),
        notes: z.string().max(260).nullish().transform(v => v ?? null),
      })
    )
    .max(5),
});

const implicitReplyPattern =
  /\b(wdym|what do you mean|explain|elaborate|why|nah|no but|wait|you said|that|true|do it|go on)\b/i;
const slopPatterns = [
  /\bit'?s not\b[^.!?\n]{0,120}\bit'?s\b/i,
  /\bnot because\b[^.!?\n]{0,160}\bbut because\b/i,
  /\bin the background\b/i,
  /\bthere'?s something about\b/i,
  /\bin a way that\b/i,
  /\bquietly\b/i,
  /\bsoftly\b/i,
  /\bgently\b/i,
  /\bjust chill(?:ing)?\b/i,
  /\bwatch(?:ing)? the chaos\b/i,
  /\b(?:the )?chaos\b.*\b(?:watching|chilling|vibes?|going on)\b/i,
  /\bvib(?:e|es|ing)\b/i,
  /\bpretty good!?\s*(just|,?\s*just)?\b/i,
  /\bdoing (?:good|fine|okay)!?\s*(just|,?\s*just)?\b/i,
  /\blowkey\b/i,
];

const wordCount = (text: string) =>
  text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const genericDiscordFiller =
  /\b(just chill(?:ing)?|watch(?:ing)? the chaos|vib(?:e|es|ing)|pretty good|doing (?:good|fine|okay)|for the chaos|watching chaos)\b/i;

const cleanStyleSample = (text: string) =>
  text
    .replace(/\[attachment:[^\]]+\]/gi, '')
    .replace(/\[reactions:[^\]]+\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

const styleSamplesFrom = (messages: DBMessage[]) => {
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const m of messages.slice(-60)) {
    if (m.role !== 'user') {
      continue;
    }
    const text = cleanStyleSample(m.content);
    if (
      text.length < 2 ||
      text.length > 140 ||
      text.startsWith('http') ||
      seen.has(text.toLowerCase())
    ) {
      continue;
    }
    seen.add(text.toLowerCase());
    samples.push(text);
  }
  return samples.slice(-18);
};

const responseReviewSchema = z.object({
  pass: z.coerce.boolean(),
  severity: z.coerce
    .number()
    .int()
    .transform(n => Math.min(3, Math.max(0, n))),
  issues: z.array(boundedString(180)).max(6),
  suggestedFix: boundedString(420),
});

const contextReviewSchema = responseReviewSchema.extend({
  needsWebVerification: z.boolean(),
});

const TOOLS = {
  search_web: webSearch,
  get_page_contents: getPageContents,
  get_current_time: currentTime,
};

export class AIService {
  private openrouter: ReturnType<typeof createOpenRouter>;
  private responseAgentRouter: ReturnType<typeof createOpenRouter> | null;
  private ollama: ReturnType<typeof createOllama>;

  private isLocal = config.provider.base_url.includes('localhost');

  readonly systemPrompt: string;
  sending = new Map<string, Set<AbortController>>();

  constructor() {
    this.openrouter = createOpenRouter({
      apiKey: config.provider.api_key,
      baseURL: config.provider.base_url,
      extraBody: {
        reasoning: {
          max_tokens: 1_000,
        },
      },
    });

    this.responseAgentRouter = config.response_agents.base_url
      ? createOpenRouter({
          apiKey:
            config.response_agents.api_key || config.provider.api_key || ':3',
          baseURL: config.response_agents.base_url,
          compatibility: 'compatible',
        })
      : null;

    this.ollama = createOllama({
      baseURL: config.provider.base_url,
    });

    this.systemPrompt = config.provider.system_prompt;
  }

  private agentModel(modelName: string) {
    if (this.responseAgentRouter) {
      return this.responseAgentRouter(modelName);
    }
    return (this.isLocal ? this.ollama : this.openrouter)(modelName);
  }

  private parseJson<T>(text: string, schema: z.ZodType<T>): T {
    const raw = text.match(/\{[\s\S]*\}/)?.[0] || text;
    return schema.parse(JSON.parse(raw));
  }

  private async reviewAntiSlop(draft: string, styleSamples: string[]) {
    return generateText({
      model: this.agentModel(config.response_agents.anti_slop_model),
      providerOptions: {
        openrouter: {reasoning: {enabled: false}},
      },
      system: `You are Volty's anti-slop editor.

Reject text that sounds generically AI-written, polished, corporate, therapy-bot-like, or cliché.
Watch hard for patterns like:
- "it's not X, it's Y"
- "X did Y in the background"
- "softly", "gently", "a little too", "in a way that..."
- "there's something about..."
- "not because..., but because..."
- "let that sink in", "lowkey poetic", "quietly"
- "just chilling", "watching the chaos", "vibing", "pretty good just..."
- bland mood reports with no concrete Volty detail
- over-balanced contrasts, fake profundity, assistant disclaimers, excessive neatness

Pass only if it sounds like a specific furry Discord regular typed it.`,
      prompt: [
        `Real nearby chat samples:`,
        ...styleSamples.map(s => `- ${s}`),
        '',
        `Volty draft:`,
        draft,
        '',
        `Compare the draft to the samples. Reject if it sounds more composed, generic, or bot-like than the humans.`,
        `Return only JSON: {"pass":true,"severity":0,"issues":[],"suggestedFix":""}`,
      ].join('\n'),
      maxOutputTokens: 260,
      temperature: 0,
      stopWhen: stepCountIs(1),
      timeout: config.response_agents.timeout_ms,
    }).then(r => this.parseJson(r.text, responseReviewSchema));
  }

  private async reviewRealism(draft: string, styleSamples: string[]) {
    return generateText({
      model: this.agentModel(config.response_agents.realism_model),
      providerOptions: {
        openrouter: {reasoning: {enabled: false}},
      },
      system: `You are Volty's realism editor.

Check whether the message sounds like a real Discord user in a furry server.
Reject if it:
- sounds like a helper bot, teacher, brand account, or HR-safe assistant
- is too complete, too polished, too symmetrical, or too explanatory for chat
- overplays the persona instead of just being a person
- ignores the user's actual tone
- is emotionally uncanny, parasocially intense, or too eager
- says too much when a short reaction would be more human
- answers hostility, hurt, or panic with multi-paragraph self-defense instead of a short grounded reaction
- litigates exact facts before acknowledging the user's feeling
- uses generic Discord filler like "just chilling", "watching the chaos", "vibing", "pretty good", or "doing good" without a concrete detail
- could have been written by any bot in any server

Passing text should feel typed by someone with taste, mood, and social timing.`,
      prompt: [
        `Real nearby chat samples:`,
        ...styleSamples.map(s => `- ${s}`),
        '',
        `Volty draft:`,
        draft,
        '',
        `Reject casual/ambient chatter if it has multiple paragraphs, more than about 22 words, a polished balanced comparison, a tag-on follow-up question, or noticeably cleaner cadence than the samples.`,
        `Return only JSON: {"pass":true,"severity":0,"issues":[],"suggestedFix":""}`,
      ].join('\n'),
      maxOutputTokens: 260,
      temperature: 0,
      stopWhen: stepCountIs(1),
      timeout: config.response_agents.timeout_ms,
    }).then(r => this.parseJson(r.text, responseReviewSchema));
  }

  private async reviewContext({
    draft,
    transcript,
  }: {
    draft: string;
    transcript: string;
  }) {
    return generateText({
      model: this.agentModel(config.response_agents.context_model),
      providerOptions: {
        openrouter: {reasoning: {enabled: false}},
      },
      system: `You are Volty's context and factuality checker.

Check whether the draft is supported by the conversation, long-term memory, and tool-visible facts.
If the draft makes external factual claims that could be wrong or current, use web search quickly.
Reject if it invents user details, server facts, personal history not in persona/memory, links, dates, rules, or current-world facts.
Do not reject harmless fictional Volty persona color unless it contradicts the prompt/memory.
Prefer concise fixes.`,
      tools: config.response_agents.context_verification
        ? {
            search_web: webSearch,
            get_page_contents: getPageContents,
          }
        : undefined,
      prompt: [
        `Context transcript:`,
        transcript,
        '',
        `Draft:`,
        draft,
        '',
        `Return only JSON: {"pass":true,"severity":0,"issues":[],"suggestedFix":"","needsWebVerification":false}`,
      ].join('\n'),
      maxOutputTokens: 360,
      temperature: 0,
      stopWhen: stepCountIs(config.response_agents.context_verification ? 3 : 1),
      timeout: config.response_agents.timeout_ms,
    }).then(r => this.parseJson(r.text, contextReviewSchema));
  }

  private async reviseDraft({
    draft,
    transcript,
    reviews,
    styleSamples,
  }: {
    draft: string;
    transcript: string;
    reviews: z.infer<typeof responseReviewSchema>[];
    styleSamples: string[];
  }) {
    const reviewText = reviews
      .filter(r => !r.pass || r.severity > 0)
      .map(
        (r, i) =>
          `Reviewer ${i + 1}: severity=${r.severity}; issues=${r.issues.join('; ')}; fix=${r.suggestedFix}`
      )
      .join('\n');

    const out = await generateText({
      model: this.agentModel(config.response_agents.revision_model),
      providerOptions: {
        openrouter: {reasoning: {enabled: false}},
      },
      system: `Rewrite Volty's draft once.

Preserve the intended meaning, but fix reviewer issues.
Make it sound like Volty: a real furry Discord regular, not a helpful assistant.
No assistant disclaimers. No service closings. No generic AI phrasing.
For casual or ambient chat, compare against the real chat samples and match their rough cadence without copying them. One Discord line. No paragraph breaks. Usually no question.
Replace generic filler with something that fits the actual surrounding chat. Never output "just chilling", "watching the chaos", "vibing", or plain "doing good".
Keep it shorter than the draft unless facts require correction.
Return only the revised message.`,
      prompt: [
        `Real nearby chat samples:`,
        ...styleSamples.map(s => `- ${s}`),
        '',
        `Context:`,
        transcript,
        '',
        `Draft:`,
        draft,
        '',
        `Reviewer notes:`,
        reviewText,
      ].join('\n'),
      maxOutputTokens: Math.min(config.model.max_output || 8000, 260),
      temperature: 0.85,
      stopWhen: stepCountIs(1),
      timeout: 20_000,
    });

    return out.text.trim() || draft;
  }

  private async reviewAndReviseResponse({
    draft,
    messages,
    contextPrompt,
  }: {
    draft: string;
    messages: DBMessage[];
    contextPrompt: string;
  }) {
    if (!config.response_agents.enabled || !draft.trim()) {
      return draft;
    }

    const transcript = [
      contextPrompt,
      ...messages.slice(-12).map(m => {
        const name = m.nickname || m.username || '<unknown>';
        return `${m.role === 'assistant' ? 'Volty' : name}: ${m.content}`;
      }),
    ].join('\n');
    const styleSamples = styleSamplesFrom(messages);
    const deterministicSlopIssues = slopPatterns
      .filter(pattern => pattern.test(draft))
      .map(pattern => `Matched anti-slop pattern ${pattern.toString()}.`);
    const isAmbient = /Engagement note: You are joining ambiently/i.test(
      contextPrompt
    );
    const casualLengthIssues =
      isAmbient || /ambient|room question|casual/i.test(contextPrompt)
        ? [
            draft.trim().split(/\n\s*\n/).length > 1
              ? 'Ambient reply used multiple paragraphs.'
              : '',
            wordCount(draft) > 18
              ? `Ambient reply is too long (${wordCount(draft)} words).`
              : '',
            /\?\s*$/m.test(draft) && wordCount(draft) > 8
              ? 'Ambient reply ended with an engagement-bait question.'
              : '',
            /\b(both|either|on the other hand|but|however)\b/i.test(draft) &&
            wordCount(draft) > 12
              ? 'Ambient reply gave a polished balanced take instead of a quick chat reaction.'
              : '',
            genericDiscordFiller.test(draft)
              ? 'Ambient reply used generic AI-ish Discord filler instead of a specific human detail.'
              : '',
            /\bchaos\b/i.test(draft) && !/\bchaos\b/i.test(contextPrompt)
              ? 'Ambient reply inserted "chaos" as generic filler even though the chat did not use that word.'
              : '',
          ].filter(Boolean)
        : [];

    try {
      const results = await Promise.allSettled([
        this.reviewAntiSlop(draft, styleSamples),
        this.reviewRealism(draft, styleSamples),
        this.reviewContext({draft, transcript}),
      ]);
      const reviews = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
      if (deterministicSlopIssues.length) {
        reviews.push({
          pass: false,
          severity: 3,
          issues: deterministicSlopIssues,
          suggestedFix:
            'Rewrite the sentence plainly. Remove neat contrast formulas, stage-direction fluff, and stock AI prose.',
        });
      }
      if (casualLengthIssues.length) {
        reviews.push({
          pass: false,
          severity: 3,
          issues: casualLengthIssues,
          suggestedFix:
            'Make it one short Discord line, 4-14 words, casual and unfinished-feeling. Remove paragraph breaks and follow-up questions.',
        });
      }

      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('Response agent failed:', result.reason);
        }
      }

      if (!reviews.length && !deterministicSlopIssues.length) {
        return draft;
      }

      const shouldRevise = reviews.some(r => !r.pass || r.severity >= 2);
      if (!shouldRevise) {
        return draft;
      }

      return this.reviseDraft({draft, transcript, reviews, styleSamples});
    } catch (err) {
      console.error('Response agent review failed:', err);
      return draft;
    }
  }

  async *streamText({
    messages,
    context,
  }: {
    messages: DBMessage[];
    context: {
      replyingToMsgID: string;
      botUsername: string;
      serverName: string;
      channelName: string;
      channelDescription: string;
      member: GuildMember;
      channel?: TextBasedChannel | null;
      db: Database;
      channelContextBeforeThread?: string | null;
      engagementInstruction?: string | null;
    };
  }) {
    const maxHistory = Math.max(1, config.model.max_history || 20);
    const convo: ModelMessage[] = await Promise.all(
      messages.slice(-maxHistory).map(
        async (m, i, a) => {
          const mediaPart =
            m.image_url && i >= a.length - 8 ? toMediaPart(m.image_url) : null;
          return <ModelMessage>{
            role: m.role,
            content: [
              mediaPart,

              m.content && {
                type: 'text',
                text:
                  m.role === 'user'
                    ? `[Username: "${m.username || '<unknown>'}", Nickname: "${m.nickname || m.username || '<unknown>'}"]: ${m.content}`
                    : m.content,
              },
            ].filter(Boolean),
          };
        }
      )
    );

    const hasMedia = convo.some(
      c =>
        Array.isArray(c.content) &&
        c.content.some(c => c.type === 'image' || c.type === 'file')
    );

    const modelName =
      hasMedia && config.model.multimodal_model
        ? config.model.multimodal_model
        : await this.routePrompt(messages);

    const systemPrompt = this.systemPrompt
      .replaceAll('{{BOT_USERNAME}}', context.botUsername)
      .replaceAll('{{SERVER_NAME}}', context.serverName)
      .replaceAll('{{CHANNEL_NAME}}', context.channelName)
      .replaceAll('{{CHANNEL_DESCRIPTION}}', context.channelDescription)
      .replaceAll('{{MODEL}}', modelName);

    const now = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeZone: 'America/New_York',
    }).format(new Date());

    const env = [
      `You are ${context.botUsername} in "${context.serverName}" #${context.channelName}.`,
      context.channelDescription && context.channelDescription !== '<none>'
        ? `Topic: ${context.channelDescription}.`
        : '',
      `Date: ${now}. Model: ${modelName}.`,
    ]
      .filter(Boolean)
      .join(' ');

    const channelContext = context.channelContextBeforeThread
      ? `\n\nRecent channel messages before this conversation started (background only; use to answer vague prompts like "what do you think?"):\n${context.channelContextBeforeThread}`
      : '';
    const memoryContext = config.memory.enabled
      ? context.db.getMemoryContext({
          guildID: BigInt(context.member.guild.id),
          userID: BigInt(context.member.id),
          limit: config.memory.max_records,
          maxChars: config.memory.max_total_chars,
        })
      : null;
    const memoryPrompt = memoryContext
      ? `\n\nLong-term memory (use naturally; do not recite unless relevant):\n${memoryContext}`
      : '';
    const relationship = config.memory.enabled
      ? context.db.getRelationship(
          BigInt(context.member.guild.id),
          BigInt(context.member.id)
        )
      : null;
    const relationshipPrompt = relationship
      ? [
          '\n\nRelationship with current user:',
          `trust=${relationship.trust}/5 familiarity=${relationship.familiarity}/5 affinity=${relationship.affinity}`,
          relationship.tone ? `tone=${relationship.tone}` : '',
          relationship.notes ? `notes=${relationship.notes}` : '',
          relationship.trust >= 4
            ? 'This user is trusted; you may be warmer and more personally open with them.'
            : 'This user is not trusted enough for private-name disclosure or very intimate self-disclosure.',
        ]
          .filter(Boolean)
          .join('\n')
      : '\n\nRelationship with current user: new or low-context. Be friendly but do not overshare private persona details.';
    const engagementInstruction = context.engagementInstruction
      ? `\n\nEngagement note: ${context.engagementInstruction}`
      : '';

    const staticPrompt: SystemModelMessage = {
      role: 'system',
      content: systemPrompt,
      providerOptions: {
        openrouter: {cacheControl: {type: 'ephemeral'}},
        anthropic: {cacheControl: {type: 'ephemeral'}},
      },
    };

    const contextPrompt: SystemModelMessage = {
      role: 'system',
      content:
        env +
        memoryPrompt +
        relationshipPrompt +
        channelContext +
        engagementInstruction,
    };

    const ac = new AbortController();
    let sendingSet = this.sending.get(context.replyingToMsgID);
    if (!sendingSet) {
      sendingSet = new Set();
      this.sending.set(context.replyingToMsgID, sendingSet);
    }
    sendingSet.add(ac);

    const llmResult = streamText({
      model: (this.isLocal ? this.ollama : this.openrouter)(modelName),
      providerOptions: {
        openrouter: {
          provider: config.model.provider?.length
            ? {
                order: config.model.provider,
                allow_fallbacks: false,
              }
            : undefined,
        },
      },
      messages: [staticPrompt, contextPrompt, ...convo],
      maxOutputTokens: config.model.max_output,
      abortSignal: ac.signal,
      tools: {
        ...TOOLS,
        ...discordContextTools({member: context.member, channel: context.channel}),
        ...discordMessageTools(context.member),
        ...memoryTools(context.member, context.db),
        ...ragTools(context.member, context.db, this),
      },
      onError: ({error}) => {
        console.warn(
          'LLM stream error:',
          error instanceof Error ? error.message : String(error)
        );
      },
      timeout: {
        totalMs: 90_000,
        stepMs: 45_000,
      },
      stopWhen: [
        stepCountIs(20),
        ({steps}) =>
          steps.reduce(
            (a, c) =>
              (c.usage.inputTokenDetails.noCacheTokens ||
                c.usage.totalTokens ||
                0) + a,
            0
          ) > 50_000,
      ],
      // temperature: 0.9,
      topP: 0.93,
      temperature: 1.1,
      frequencyPenalty: 0.1,
    });

    sendingSet.delete(ac);
    if (!sendingSet.size) {
      this.sending.delete(context.replyingToMsgID);
    }

    let text = '';
    const tools: string[] = [];
    const prevReasonings: string[] = [];
    let reasoning = '';
    let lastYield = Date.now();
    let state = 'reasoning';
    let sawToolCall = false;
    let finishReason = '';

    const MIN_TIME = 500;

    const keepStates = new Set(['reasoning-delta', 'text-delta', 'tool-call']);
    for await (const part of llmResult.fullStream) {
      if (part.type === 'finish') {
        finishReason = part.finishReason;
        console.log('finished because:', part.finishReason);
      }

      if (!keepStates.has(part.type)) {
        continue;
      }

      const prevState = state;
      if (prevState !== part.type) {
        yield {
          state,
          text,
          reasoning,
          tools,
        };

        tools.length = 0;
        prevReasonings.push(reasoning);
        reasoning = '';
        text = '';
        state = part.type;
      }

      switch (part.type) {
        case 'reasoning-delta': {
          reasoning += part.text;
          break;
        }

        case 'text-delta': {
          text += part.text;
          break;
        }

        case 'tool-call': {
          sawToolCall = true;
          switch (part.toolName) {
            case 'search_web': {
              tools.push(
                `searching the web for "${(part.input as any).query as string}"`
              );
              break;
            }

            case 'query_server_knowledge': {
              tools.push(
                `searching server rules for "${(part.input as any).query as string}`
              );
              break;
            }

            case 'current_time': {
              tools.push(
                `getting the current time in \`${(part.input as any).timezone as string}\``
              );
              break;
            }

            case 'get_page_contents': {
              tools.push(`reading <${(part.input as any).url as string}>`);
              break;
            }

            default: {
              tools.push(`\`${part.toolName}\``);
            }
          }
          break;
        }
      }

      const currentTime = Date.now();
      if (currentTime - lastYield >= MIN_TIME) {
        lastYield = currentTime;
        yield {
          state,
          text,
          reasoning,
          tools,
        };
      }
    }

    const providerMetadata = await llmResult.providerMetadata;
    const totalUsage = await llmResult.totalUsage;
    const responseMetadata = await llmResult.response;
    const rawDraft = await llmResult.text;
    const draft =
      rawDraft.trim() ||
      (sawToolCall || finishReason === 'tool-calls'
        ? (
            await generateText({
              model: (this.isLocal ? this.ollama : this.openrouter)(modelName),
              providerOptions: {
                openrouter: {
                  provider: config.model.provider?.length
                    ? {
                        order: config.model.provider,
                        allow_fallbacks: false,
                      }
                    : undefined,
                },
              },
              messages: [
                staticPrompt,
                contextPrompt,
                ...convo,
                ...(responseMetadata.messages as ModelMessage[]),
                {
                  role: 'system',
                  content:
                    'You already used tools and have their results. Now send the Discord reply itself. Do not call tools again.',
                },
              ],
              maxOutputTokens: Math.min(config.model.max_output || 1200, 600),
              temperature: 1.05,
              topP: 0.93,
              frequencyPenalty: 0.1,
            })
          ).text
        : rawDraft);
    const fullText = await this.reviewAndReviseResponse({
      draft,
      messages,
      contextPrompt: contextPrompt.content,
    });

    const usage = {
      provider: this.isLocal
        ? 'ollama (local)'
        : (providerMetadata?.openrouter?.provider as string) || 'unknown',
      in: totalUsage.inputTokens || 0,
      out: totalUsage.outputTokens || 0,
      reasoning: totalUsage.outputTokenDetails.reasoningTokens || 0,
      cached: totalUsage.inputTokenDetails.cacheReadTokens || 0,
      total: totalUsage.totalTokens || 0,
      cost: (providerMetadata?.openrouter?.usage as {cost?: number})?.cost || 0,
    };

    yield {
      state: 'finish',
      fullReasoning: prevReasonings,
      fullText,
      usage,
    };
  }

  // async generateTitle(messages: ModelMessage[]): Promise<string> {
  //   const modelName = config.model.small_model || config.model.name;
  //
  //   const titlePrompt = `Generate a short, descriptive title for this conversation. Max 100 characters.`;
  //
  //   try {
  //     const result = await generateText({
  //       model: (this.isLocal ? this.ollama : this.openrouter)(modelName, {}),
  //       system: titlePrompt,
  //       messages: messages.slice(-10),
  //       maxOutputTokens: 20,
  //       providerOptions: {
  //         openrouter: {
  //           reasoning: {
  //             enabled: false,
  //           },
  //         },
  //       },
  //     });
  //
  //     return result.text.slice(0, 100).trim() || 'AI Response';
  //   } catch (err) {
  //     console.error('Failed to generate thread title:', err);
  //     return 'AI Response';
  //   }
  // }

  async getEmbedding(query: string): Promise<number[]> {
    const {embedding} = await embed({
      model: (this.isLocal ? this.ollama : this.openrouter).textEmbeddingModel(
        config.rag.embedding_model
      ),
      value: query,
    });

    return embedding;
  }

  async getManyEmbedding(queries: string[]): Promise<number[][]> {
    const {embeddings} = await embedMany({
      model: (this.isLocal ? this.ollama : this.openrouter).textEmbeddingModel(
        config.rag.embedding_model
      ),
      values: queries,
    });

    return embeddings;
  }

  async decideChannelEngagement({
    transcript,
    newestMessageId,
    botUsername,
    channelName,
  }: {
    transcript: ChannelTranscriptMessage[];
    newestMessageId: string;
    botUsername: string;
    channelName: string;
  }): Promise<EngagementDecision> {
    if (!config.ambient_chat.enabled) {
      return {
        mode: 'ignore',
        confidence: 1,
        targetMessageId: null,
        reason: 'Ambient chat disabled.',
        angle: '',
      };
    }

    const newest = transcript.find(m => m.id === newestMessageId);
    if (!newest || newest.isBot || !newest.content.trim()) {
      return {
        mode: 'ignore',
        confidence: 1,
        targetMessageId: null,
        reason: 'No eligible newest human message.',
        angle: '',
      };
    }

    const modelName =
      config.model.router_model ||
      config.model.small_model ||
      config.model.primary_model;
    const fallbackImplicitReply = (reason: string): EngagementDecision => {
      const lastMira = [...transcript].reverse().find(m => m.isMira);
      if (lastMira && implicitReplyPattern.test(newest.content)) {
        return {
          mode: 'reply_to_mira',
          confidence: config.ambient_chat.reply_confidence,
          targetMessageId: lastMira.id,
          reason,
          angle: `Likely implicit follow-up to Volty's last message: "${newest.content}"`,
        };
      }

      return {
        mode: 'ignore',
        confidence: 1,
        targetMessageId: null,
        reason,
        angle: '',
      };
    };

    try {
      const out = await generateText({
        model: (this.isLocal ? this.ollama : this.openrouter)(modelName),
        providerOptions: {
          openrouter: {
            reasoning: {enabled: false},
          },
        },
        system: `You decide whether ${botUsername}, a Discord bot, should speak in #${channelName}.

Return JSON only.

Modes:
- ignore: stay quiet. Prefer this unless there is a clear reason to speak.
- reply_to_mira: the newest human message is likely addressed to Volty or naturally expects Volty to answer, even without a mention or Discord reply.
- ambient_join: Volty was not addressed, but there is a strong natural opening for one short casual contribution.

Choose reply_to_mira when the newest message asks about, corrects, agrees/disagrees with, reacts to, or follows up on something Volty said, including subtle references like "wdym", "why", "nah", "true", "do it", "you said", or "that".

Choose ambient_join only when Volty would sound like a normal participant: users ask an open question to the room, there is confusion Volty can clarify, a debate invites a brief opinion, or a joke/light moment clearly invites a small response.

Do not speak into private, sensitive, moderation, conflict-heavy, or support conversations unless Volty was likely addressed. Do not dominate. When uncertain, choose ignore.

targetMessageId should be the Volty message being answered for reply_to_mira, otherwise null. angle should be a short note for what Volty should say if speaking.`,
        prompt: [
          `Recent transcript, oldest to newest:`,
          ...transcript.map(renderTranscriptLine),
          '',
          `Newest message id: ${newestMessageId}`,
          '',
          `Return only JSON: {"mode":"ignore","confidence":1,"targetMessageId":null,"reason":"","angle":""}`,
        ].join('\n'),
        maxOutputTokens: 180,
        temperature: 0,
        stopWhen: stepCountIs(1),
        timeout: config.ambient_chat.decision_timeout_ms,
      });

      return this.parseJson(out.text, engagementDecisionSchema);
    } catch (err) {
      console.error('Failed to decide channel engagement:', err);
      return fallbackImplicitReply('Decision model failed; used heuristic fallback.');
    }
  }

  async extractMemories({
    messages,
    assistantResponse,
    guildID,
    sourceMessageID,
    db,
  }: {
    messages: DBMessage[];
    assistantResponse: string;
    guildID: bigint;
    sourceMessageID: bigint;
    db: Database;
  }) {
    if (!config.memory.enabled) {
      return;
    }

    const modelName = config.model.primary_model;
    const systemPrompt = this.systemPrompt
      .replaceAll('{{BOT_USERNAME}}', 'Volty')
      .replaceAll('{{SERVER_NAME}}', 'the server')
      .replaceAll('{{CHANNEL_NAME}}', 'the channel')
      .replaceAll('{{CHANNEL_DESCRIPTION}}', 'memory reflection')
      .replaceAll('{{MODEL}}', modelName);
    const transcript = [
      ...messages.slice(-12).map(m =>
        [
          `message ${m.id}`,
          `userId="${m.discord_author_id}"`,
          `role=${m.role}`,
          `userName="${m.nickname || m.username || '<unknown>'}"`,
          `content=${m.content}`,
        ].join(' | ')
      ),
      `assistant_response=${assistantResponse}`,
    ].join('\n');

    try {
      const out = await generateText({
        model: (this.isLocal ? this.ollama : this.openrouter)(modelName),
        providerOptions: {
          openrouter: {
            reasoning: {enabled: false},
          },
        },
        system: `${systemPrompt}

You are Volty privately reflecting after a chat. This pass is Volty's own memory judgment, not a critic agent and not a generic summarizer.

Extract durable memory records for yourself.

Only save facts that would help future conversations feel personal:
- stable user preferences, names, pronouns, projects, hobbies, boundaries, relationships, recurring jokes
- ongoing topics worth following up on
- compact bot diary notes when you committed to a bit, opinion, plan, feeling, or fictional recent experience
- emotional events that affect the relationship, including hostility, affection, apology, trust, fear, overwhelm, or someone setting a boundary

Do not save secrets, credentials, private contact info, generic chat filler, or raw abusive phrases. If someone is hostile, save the social fact calmly without repeating slurs or graphic wording.
Write memories as short third-person notes. Use null userId for server-wide, group, or Volty/bot memories.
For user-specific records, copy the exact quoted userId string from the transcript. Do not round, shorten, or retype it from memory. Include userName too.
Use bot_memory with null userId for your own emotional/diary memories, unless it is specifically about your relationship with one user.

Also update your relationship map for users who appeared in the transcript:
- trust: 1 stranger, 2 familiar, 3 friendly, 4 trusted, 5 inner-circle
- familiarity: how much Volty knows their patterns/interests
- affinity: -3 tense to +3 close/fond
- tone: how Volty should talk with them, e.g. "dry jokes", "gentle", "technical", "chaotic casual"
- notes: compact relationship-specific context, not a duplicate of individual memories

Do not inflate trust quickly. Private name disclosure requires trust 4+.
Decrease affinity/trust when someone is cruel or tells Volty to die, but do not become melodramatic about it.
Return at most five memories and five relationship updates.
Return compact valid JSON only. Do not include comments, markdown, trailing commas, or prose outside the JSON object.`,
        prompt: `${transcript}\n\nReturn only JSON: {"memories":[],"relationships":[]}`,
        maxOutputTokens: 800,
        temperature: 0,
        stopWhen: stepCountIs(1),
        timeout: config.memory.extraction_timeout_ms,
      });

      const extracted = this.parseJson(out.text, extractedMemorySchema);
      const userMessages = messages.filter(m => m.role === 'user');
      const validUserIDs = new Set(
        userMessages.map(m => m.discord_author_id.toString())
      );
      const userIdByName = new Map(
        userMessages.flatMap(m =>
          [m.nickname, m.username]
            .filter(Boolean)
            .map(name => [
              name!.toLowerCase(),
              m.discord_author_id.toString(),
            ] as const)
        )
      );
      const resolveUserId = (userId: string | null, userName: string | null) => {
        if (userId && validUserIDs.has(userId)) {
          return userId;
        }
        if (userName) {
          return userIdByName.get(userName.toLowerCase()) || null;
        }
        return null;
      };

      for (const memory of extracted.memories) {
        const resolvedUserID = resolveUserId(memory.userId, memory.userName);
        if (memory.userId && !resolvedUserID) {
          console.warn(
            `Skipping memory with unknown user id ${memory.userId} from ${sourceMessageID}`
          );
          continue;
        }

        db.insertMemory({
          discord_guild_id: guildID,
          discord_user_id: resolvedUserID ? BigInt(resolvedUserID) : null,
          kind: memory.kind,
          content: memory.content,
          salience: memory.salience,
          source_message_id: sourceMessageID,
        });
      }

      for (const relationship of extracted.relationships) {
        const resolvedUserID = resolveUserId(
          relationship.userId,
          relationship.userName
        );
        if (!resolvedUserID) {
          console.warn(
            `Skipping relationship with unknown user id ${relationship.userId} from ${sourceMessageID}`
          );
          continue;
        }

        db.upsertRelationship({
          guildID,
          userID: BigInt(resolvedUserID),
          trust: relationship.trust,
          familiarity: relationship.familiarity,
          affinity: relationship.affinity,
          tone: relationship.tone,
          notes: relationship.notes,
        });
      }
    } catch (err) {
      console.error('Failed to extract memories:', err);
    }
  }

  async routePrompt(messages: DBMessage[]) {
    if (
      !config.model.enable_routing ||
      !config.model.small_model ||
      !config.model.router_model ||
      config.model.primary_model === config.model.small_model
    ) {
      return config.model.primary_model;
    }
    try {
      const out = await generateText({
        model: (this.isLocal ? this.ollama : this.openrouter)(
          config.model.router_model
        ),
        providerOptions: {
          openrouter: {
            reasoning: {
              enabled: false,
            },
          },
        },
        system: `You are a prompt classification engine. Analyze the user's request.
If the request is a simple greeting, casual chat, roleplay, or a meaningless message, output exactly 'easy'
Otherwise output exactly 'hard'`,
        messages,
        output: Output.choice({
          options: ['hard', 'easy'],
        }),
        stopWhen: stepCountIs(1),
        timeout: 1_000,
      });

      switch (out.output) {
        case 'hard': {
          return config.model.primary_model;
        }

        default: {
          return config.model.small_model || config.model.primary_model;
        }
      }
    } catch (err) {
      console.error('Failed to route prompt:', err);
      return config.model.primary_model;
    }
  }
}
