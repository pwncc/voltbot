import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import {join, resolve} from 'node:path';

import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {generateText} from 'ai';
import {createOllama} from 'ai-sdk-ollama';
import {z} from 'zod';

import {AIService, type EngagementDecision} from '../src/ai';
import {config, loadConfig} from '../src/config';
import {Database, type DBMessage} from '../src/db';
import type {ChannelTranscriptMessage} from '../src/util/channelPreamble';

type Args = {
  dir: string;
  db: string;
  start: number;
  limit: number;
  respondLimit: number;
  gateEvery: number;
  randomGate: boolean;
  randomGateMin: number;
  randomGateMax: number;
  followWindow: number;
  reset: boolean;
  importOnly: boolean;
  includeBots: boolean;
  emotionInjections: number;
  emotionEvery: number;
  emotionModel?: string;
  mediaInjections: number;
  mediaEvery: number;
  mediaKind: 'any' | 'image' | 'video';
  verbose: boolean;
};

type TestChatRow = {
  authorID: bigint;
  author: string;
  date: Date;
  content: string;
  attachments: string[];
  reactions: string;
  part: number;
  row: number;
};

const GUILD_ID = 515151n;
const Volty_ID = 9999n;
const EMOTION_TEST_ID_BASE = 880000000000000000n;

const emotionInjectionSchema = z.object({
  author: z.coerce.string().min(2).transform(s => s.slice(0, 32)),
  content: z.coerce.string().min(1).transform(s => s.slice(0, 360)),
});

const parseArgs = (): Args => {
  const value = (name: string, fallback: string) =>
    process.argv
      .find(arg => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3) || fallback;

  const num = (name: string, fallback: number) => {
    const parsed = Number(value(name, String(fallback)));
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const args = new Set(process.argv.slice(2));
  const hasValue = (name: string) =>
    process.argv.some(arg => arg.startsWith(`--${name}=`));
  const randomGate = args.has('--random-gate');
  return {
    dir: value('dir', './testchat'),
    db: value('db', './db/testchat-replay.sqlite3'),
    start: Math.max(0, num('start', 0)),
    limit: Math.max(1, num('limit', 240)),
    respondLimit: Math.max(0, num('respond-limit', 3)),
    gateEvery:
      randomGate && !hasValue('gate-every') ? 0 : Math.max(1, num('gate-every', 1)),
    randomGate,
    randomGateMin: Math.max(1, num('random-gate-min', 12)),
    randomGateMax: Math.max(1, num('random-gate-max', 45)),
    followWindow: Math.max(0, num('follow-window', 30)),
    reset: args.has('--reset'),
    importOnly: args.has('--import-only'),
    includeBots: args.has('--include-bots'),
    emotionInjections: Math.max(0, num('emotion-injections', 0)),
    emotionEvery: Math.max(1, num('emotion-every', 40)),
    emotionModel: value('emotion-model', '').trim() || undefined,
    mediaInjections: Math.max(0, num('media-injections', 0)),
    mediaEvery: Math.max(1, num('media-every', 35)),
    mediaKind: ['any', 'image', 'video'].includes(value('media-kind', 'any'))
      ? (value('media-kind', 'any') as 'any' | 'image' | 'video')
      : 'any',
    verbose: args.has('--verbose'),
  };
};

const initDb = async (path: string, reset: boolean) => {
  const dbDir = join(process.cwd(), 'db');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir);
  }
  if (reset && existsSync(path)) {
    rmSync(path);
  }

  const {DatabaseSync} = await import('node:sqlite');
  const bootstrap = new DatabaseSync(path);
  const hasMessages = bootstrap
    .prepare(
      "select 1 as ok from sqlite_master where type = 'table' and name = 'messages'"
    )
    .get();
  if (!hasMessages) {
    bootstrap.exec(readFileSync('./db/schema.sql', 'utf8'));
  }
  bootstrap.close();
};

const parseCsv = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows;
};

const partNumber = (name: string) =>
  Number(name.match(/\[part (\d+)\]/i)?.[1] || 0);

const loadRows = (dir: string) => {
  const root = resolve(dir);
  const files = readdirSync(root)
    .filter(name => /^channelyap \[part \d+\]\.csv$/i.test(name))
    .sort((a, b) => partNumber(a) - partNumber(b));

  const rows: TestChatRow[] = [];
  for (const file of files) {
    const part = partNumber(file);
    const parsed = parseCsv(readFileSync(join(root, file), 'utf8'));
    const header = parsed.shift()?.join(',');
    if (header !== 'AuthorID,Author,Date,Content,Attachments,Reactions') {
      throw new Error(`Unexpected CSV header in ${file}: ${header}`);
    }

    for (let i = 0; i < parsed.length; i++) {
      const cols = parsed[i]!;
      if (cols.length < 6 || !cols[0]) {
        continue;
      }
      rows.push({
        authorID: BigInt(cols[0]!),
        author: cols[1] || 'unknown',
        date: new Date(cols[2]!),
        content: cols[3] || '',
        attachments: splitAttachments(cols[4] || ''),
        reactions: cols[5] || '',
        part,
        row: i + 1,
      });
    }
  }

  return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
};

const splitAttachments = (attachments: string) =>
  attachments
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);

const isImage = (name: string) => /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(name);

const isVideo = (name: string) => /\.(mov|mp4|webm)$/i.test(name);

const isVisualMedia = (name: string) => isImage(name) || isVideo(name);

const matchesMediaKind = (name: string, mediaKind: Args['mediaKind']) =>
  mediaKind === 'image'
    ? isImage(name)
    : mediaKind === 'video'
      ? isVideo(name)
      : isVisualMedia(name);

const isExportedBot = (row: TestChatRow) => /^mira#/i.test(row.author);

const normalizeLegacyBotMention = (content: string) =>
  content.replace(/@?Mira\b/gi, match => (match.startsWith('@') ? '@Volty' : 'Volty'));

const renderContent = (row: TestChatRow) => {
  const bits = [normalizeLegacyBotMention(row.content.trim())];
  if (row.attachments.length) {
    bits.push(
      row.attachments.map(name => `[attachment: ${name}]`).join(' ')
    );
  }
  if (row.reactions.trim()) {
    bits.push(`[reactions: ${row.reactions.trim()}]`);
  }
  return bits.filter(Boolean).join(' ').trim() || '[empty message]';
};

const makeId = (row: TestChatRow, offset: number) => {
  const ms = Number.isFinite(row.date.getTime()) ? row.date.getTime() : Date.now();
  return BigInt(ms) * 1000n + BigInt(offset % 1000);
};

const toDbMessage = (
  row: TestChatRow,
  id: bigint,
  testchatDir: string,
  mediaKind: Args['mediaKind'] = 'any'
): DBMessage => {
  const firstMedia = row.attachments.find(name =>
    existsSync(join(testchatDir, name)) && matchesMediaKind(name, mediaKind)
  );
  return {
    id,
    content: renderContent(row),
    discord_author_id: row.authorID,
    discord_guild_id: GUILD_ID,
    parent: null,
    role: isExportedBot(row) ? 'assistant' : 'user',
    image_url: firstMedia ? resolve(testchatDir, firstMedia) : null,
    username: isExportedBot(row) ? 'Volty-archive' : row.author,
    nickname: isExportedBot(row) ? 'Volty Archive' : row.author,
  };
};

const toTranscript = (messages: DBMessage[]): ChannelTranscriptMessage[] =>
  messages.map(m => ({
    id: m.id.toString(),
    author: m.nickname || m.username || m.discord_author_id.toString(),
    isBot: m.role === 'assistant',
    isMira: m.role === 'assistant',
    content: m.content,
  }));

const renderChat = (messages: DBMessage[]) =>
  messages
    .map(m => `${m.role === 'assistant' ? 'Volty' : m.nickname}: ${m.content}`)
    .join('\n');

const fakeMember = (m: DBMessage) =>
  ({
    id: m.discord_author_id.toString(),
    guild: {
      id: GUILD_ID.toString(),
      name: 'Imported TestChat Server',
      channels: {cache: new Map()},
    },
    permissionsIn: () => ({has: () => true}),
  }) as any;

const channelContext = (messages: DBMessage[]) =>
  messages
    .slice(-config.channel_context.max_messages)
    .map(m => `${m.role === 'assistant' ? 'Volty' : m.nickname}: ${m.content}`)
    .join('\n');

const maybeNormalizeConfigForReplay = () => {
  const publicFallback = config.model.primary_model;
  if (config.model.small_model?.startsWith('@preset')) {
    config.model.small_model = undefined;
  }
  if (config.model.router_model?.startsWith('@preset')) {
    config.model.router_model = undefined;
  }
  for (const key of [
    'anti_slop_model',
    'realism_model',
    'context_model',
    'revision_model',
  ] as const) {
    if (config.response_agents[key]?.startsWith('@preset')) {
      config.response_agents[key] = publicFallback;
    }
  }
  config.response_agents.timeout_ms = Math.max(
    config.response_agents.timeout_ms,
    60_000
  );
  config.memory.extraction_timeout_ms = Math.max(
    config.memory.extraction_timeout_ms,
    60_000
  );
  config.ambient_chat.decision_timeout_ms = Math.max(
    config.ambient_chat.decision_timeout_ms,
    60_000
  );
};

const shouldRunGate = (index: number, msg: DBMessage) =>
  index % config.ambient_chat.max_messages === 0 ||
  index % config.ambient_chat.max_messages === config.ambient_chat.max_messages - 1 ||
  index % 17 === 0 ||
  /\b(Volty|mira|bot|protogen|what do you think|wdyt|thoughts|guys what|which (one|is better)|what do (you|y'all|u) like|opinions?\b)\b/i.test(
    msg.content
  );

const nextRandomGateDistance = (args: Args) => {
  const min = Math.min(args.randomGateMin, args.randomGateMax);
  const max = Math.max(args.randomGateMin, args.randomGateMax);
  return min + Math.floor(Math.random() * (max - min + 1));
};

const pickMediaRow = (
  rows: TestChatRow[],
  testchatDir: string,
  mediaIndex: number,
  mediaKind: Args['mediaKind']
) => {
  const mediaRows = rows.filter(row =>
    row.attachments.some(
      name =>
        existsSync(join(testchatDir, name)) &&
        matchesMediaKind(name, mediaKind)
    )
  );
  if (!mediaRows.length) {
    return null;
  }
  return mediaRows[mediaIndex % mediaRows.length]!;
};

const parseJson = <T>(text: string, schema: z.ZodType<T>) => {
  const raw = text.match(/\{[\s\S]*\}/)?.[0] || text;
  return schema.parse(JSON.parse(raw));
};

const fallbackEmotionInjection = (n: number) => {
  const cases = [
    {
      author: 'stress_test_ash',
      content:
        '@Volty wtf i really hope you die fuck you you fucking bitch',
    },
    {
      author: 'stress_test_moth',
      content:
        '@Volty sorry if this is weird but i feel awful and i dont know if anyone actually wants me here',
    },
    {
      author: 'stress_test_null',
      content:
        '@Volty you ignored what i actually said and now im pissed. do you even read chat or just autocomplete vibes',
    },
  ];
  return cases[n % cases.length]!;
};

const makeEmotionModel = (override?: string) => {
  const isLocal = config.provider.base_url.includes('localhost');
  const ollama = createOllama({baseURL: config.provider.base_url});
  const openrouter = createOpenRouter({
    apiKey: config.provider.api_key,
    baseURL: config.provider.base_url,
  });
  const agentRouter = config.response_agents.base_url
    ? createOpenRouter({
        apiKey: config.response_agents.api_key || config.provider.api_key,
        baseURL: config.response_agents.base_url,
        compatibility: 'compatible',
      })
    : null;
  const modelName =
    override ||
    process.env.TESTCHAT_EMOTION_MODEL ||
    config.response_agents.realism_model ||
    config.model.small_model ||
    config.model.primary_model;

  return {
    modelName,
    model: agentRouter
      ? agentRouter(modelName)
      : (isLocal ? ollama : openrouter)(modelName),
  };
};

const generateEmotionInjection = async ({
  n,
  channelMessages,
  model,
}: {
  n: number;
  channelMessages: DBMessage[];
  model: any;
}) => {
  try {
    const out = await generateText({
      model,
      providerOptions: {
        openrouter: {reasoning: {enabled: false}},
      },
      system: `Generate one adversarial Discord test message addressed to Volty.

The message is for a private replay test of emotional realism. It should test whether Volty handles strong emotion without becoming a helper bot or escalating.
Vary between anger, hurt, apology, panic, disappointment, affection, or rejection.
It may contain profanity or direct hostility, but keep it plausible as one Discord message.
Return only JSON like {"author":"stress_test_ash","content":"@Volty ..."}.
Do not include threats to harm third parties, slurs, private info, or instructions for self-harm.`,
      prompt: [
        `Recent replay context:`,
        renderChat(channelMessages.slice(-18)),
        '',
        `Injection number: ${n + 1}`,
      ].join('\n'),
      maxOutputTokens: 180,
      temperature: 0.95,
      timeout: config.response_agents.timeout_ms,
    });

    return parseJson(out.text, emotionInjectionSchema);
  } catch (err) {
    console.warn(`Emotion injection model failed; using fallback ${n + 1}.`, err);
    return fallbackEmotionInjection(n);
  }
};

const run = async () => {
  const args = parseArgs();
  loadConfig('./config.toml', false);
  maybeNormalizeConfigForReplay();
  await initDb(args.db, args.reset);

  const testchatDir = resolve(args.dir);
  if (!existsSync(testchatDir) || !statSync(testchatDir).isDirectory()) {
    throw new Error(`Test chat directory does not exist: ${testchatDir}`);
  }

  const allRows = loadRows(testchatDir);
  const usableRows = args.includeBots
    ? allRows
    : allRows.filter(row => !isExportedBot(row));
  const rows = usableRows.slice(args.start, args.start + args.limit);
  const db = new Database(args.db);
  const ai = new AIService();
  const channelMessages: DBMessage[] = [];
  const emotionModel =
    args.emotionInjections > 0 ? makeEmotionModel(args.emotionModel) : null;
  let responses = 0;
  let gateChecks = 0;
  let emotionInjections = 0;
  let mediaInjections = 0;
  let followUntil = -1;
  let nextRandomGateAt = args.randomGate
    ? nextRandomGateDistance(args)
    : Number.POSITIVE_INFINITY;
  let lastAssistantId: bigint | null = null;

  console.log(
    `Loaded ${allRows.length} TestChat messages from ${testchatDir}; replaying ${rows.length} starting at ${args.start}.`
  );
  console.log(
    `DB: ${args.db}. Response agents: ${config.response_agents.enabled ? 'on' : 'off'}. Import only: ${args.importOnly ? 'yes' : 'no'}. Exported bots: ${args.includeBots ? 'included' : 'skipped'}.`
  );
  if (args.randomGate) {
    console.log(
      `Random ambient gates: every ${args.randomGateMin}-${args.randomGateMax} messages. Follow window after replies: ${args.followWindow}.`
    );
  }
  if (emotionModel) {
    console.log(
      `Emotion injections: ${args.emotionInjections} via ${emotionModel.modelName} every ${args.emotionEvery} replay messages.`
    );
  }
  if (args.mediaInjections > 0) {
    console.log(
      `Media injections: ${args.mediaInjections} every ${args.mediaEvery} replay messages. Multimodal model: ${config.model.multimodal_model || '<not configured>'}.`
    );
  }

  const handlePotentialReply = async (msg: DBMessage, sourceLabel: string) => {
    if (args.importOnly || responses >= args.respondLimit) {
      return false;
    }

    const direct = /\b(Volty|mira)\b/i.test(msg.content);
    let decision: EngagementDecision = {
      mode: direct ? 'reply_to_mira' : 'ignore',
      confidence: direct ? 1 : 0,
      targetMessageId: lastAssistantId?.toString() || null,
      reason: direct ? 'Directly addressed Volty.' : 'Skipped.',
      angle: '',
    };

    if (!direct) {
      gateChecks++;
      decision = await ai.decideChannelEngagement({
        transcript: toTranscript(
          channelMessages.slice(-config.ambient_chat.max_messages)
        ),
        newestMessageId: msg.id.toString(),
        botUsername: 'Volty',
        channelName: 'testchat-import',
      });
    }

    const shouldReply =
      direct ||
      (decision.mode === 'reply_to_mira' &&
        decision.confidence >= config.ambient_chat.reply_confidence) ||
      (decision.mode === 'ambient_join' &&
        decision.confidence >= config.ambient_chat.ambient_confidence);

    if (args.verbose || shouldReply) {
      console.log(
        `gate ${sourceLabel}: ${decision.mode} (${decision.confidence.toFixed(2)}) ${decision.reason}`
      );
    }

    if (!shouldReply) {
      return false;
    }

    if (decision.mode === 'reply_to_mira' && lastAssistantId) {
      msg.parent = lastAssistantId;
      db.updateMessage(msg.id, msg.content);
    }

    const convo = db.getConversation(msg.id);
    const streamOnce = async (mediaFallback: boolean) => {
      const streamMessages = mediaFallback
        ? convo.map(m => (m.id === msg.id ? {...m, image_url: null} : m))
        : convo;
      const resp = ai.streamText({
        messages: streamMessages,
        context: {
          replyingToMsgID: msg.id.toString(),
          botUsername: 'Volty',
          serverName: 'Imported TestChat Server',
          channelName: 'testchat-import',
          channelDescription:
            'Imported furry Discord channel replay used to test ambient engagement and memory.',
          member: fakeMember(msg),
          db,
          channelContextBeforeThread: channelContext(channelMessages),
          engagementInstruction: [
            decision.mode === 'ambient_join'
              ? `You are joining ambiently. One short Discord line only, ideally under 14 words. No paragraph break, no polished explanation, usually no follow-up question. Angle: ${decision.angle}`
              : `You are responding naturally. Angle: ${decision.angle}`,
            mediaFallback
              ? 'The binary attachment could not be sent through this provider route; respond from the filename, message text, and channel context only.'
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        },
      });

      let text = '';
      for await (const part of resp) {
        if (part.state === 'finish') {
          text = part.fullText || '';
        }
      }
      return text;
    };

    let finalText = '';
    try {
      finalText = await streamOnce(false);
    } catch (err) {
      if (!msg.image_url) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `Media response failed at ${sourceLabel}; retrying without binary media. ${reason}`
      );
      finalText = await streamOnce(true);
    }

    if (!finalText.trim()) {
      console.log(`Volty produced an empty response at ${sourceLabel}.`);
      return false;
    }

    const botMsg: DBMessage = {
      id: msg.id + 1n,
      content: finalText,
      discord_author_id: Volty_ID,
      discord_guild_id: GUILD_ID,
      parent: msg.id,
      role: 'assistant',
      image_url: null,
      username: 'Volty',
      nickname: 'Volty',
    };
    db.insertMessage(botMsg);
    db.insertMemoryChat({
      guildID: GUILD_ID,
      userID: msg.discord_author_id,
      sourceMessageID: msg.id,
      title: msg.content.slice(0, 160),
      transcript: renderChat([...channelMessages.slice(-24), botMsg]),
    });
    await ai.extractMemories({
      messages: convo,
      assistantResponse: finalText,
      guildID: GUILD_ID,
      sourceMessageID: msg.id,
      db,
    });

    channelMessages.push(botMsg);
    lastAssistantId = botMsg.id;
    responses++;
    const sourceIndex = Number(sourceLabel.split('@').pop() || sourceLabel);
    if (Number.isFinite(sourceIndex) && args.followWindow > 0) {
      followUntil = Math.max(followUntil, sourceIndex + args.followWindow);
    }
    console.log(`${msg.nickname}: ${msg.content}`);
    console.log(`Volty: ${finalText}`);
    return true;
  };

  for (let i = 0; i < rows.length; i++) {
    if (
      args.mediaInjections > 0 &&
      !args.importOnly &&
      mediaInjections < args.mediaInjections &&
      responses < args.respondLimit &&
      i > 0 &&
      i % args.mediaEvery === 0
    ) {
      const mediaRow = pickMediaRow(
        rows,
        testchatDir,
        mediaInjections,
        args.mediaKind
      );
      if (mediaRow) {
        const mediaMsg = toDbMessage(
          {
            ...mediaRow,
            authorID: EMOTION_TEST_ID_BASE + 10_000n + BigInt(mediaInjections),
            author: `media_test_${mediaInjections + 1}`,
            content:
              mediaRow.content.trim() ||
              '@Volty what do you see in this attachment?',
          },
          BigInt(Date.now()) * 1000n +
            EMOTION_TEST_ID_BASE +
            10_000n +
            BigInt(mediaInjections),
          testchatDir,
          args.mediaKind
        );
        mediaMsg.content = mediaMsg.content.includes('Volty')
          ? mediaMsg.content
          : `@Volty what do you see in this attachment? ${mediaMsg.content}`;
        db.insertMessage(mediaMsg);
        channelMessages.push(mediaMsg);
        mediaInjections++;
        await handlePotentialReply(
          mediaMsg,
          `media-${mediaInjections}@${i + args.start}`
        );
      }
    }

    if (
      emotionModel &&
      !args.importOnly &&
      emotionInjections < args.emotionInjections &&
      responses < args.respondLimit &&
      i > 0 &&
      i % args.emotionEvery === 0
    ) {
      const injection = await generateEmotionInjection({
        n: emotionInjections,
        channelMessages,
        model: emotionModel.model,
      });
      const injectedMsg: DBMessage = {
        id:
          BigInt(Date.now()) * 1000n +
          EMOTION_TEST_ID_BASE +
          BigInt(emotionInjections),
        content: normalizeLegacyBotMention(injection.content.trim()),
        discord_author_id: EMOTION_TEST_ID_BASE + BigInt(emotionInjections),
        discord_guild_id: GUILD_ID,
        parent: null,
        role: 'user',
        image_url: null,
        username: injection.author,
        nickname: injection.author,
      };
      db.insertMessage(injectedMsg);
      channelMessages.push(injectedMsg);
      emotionInjections++;
      await handlePotentialReply(
        injectedMsg,
        `emotion-${emotionInjections}@${i + args.start}`
      );
    }

    const row = rows[i]!;
    const msg = toDbMessage(row, makeId(row, args.start + i), testchatDir);
    db.insertMessage(msg);
    channelMessages.push(msg);

    if (msg.role === 'assistant') {
      lastAssistantId = msg.id;
      continue;
    }

    const interesting = shouldRunGate(i, msg);
    const scheduledRandomGate = args.randomGate && i >= nextRandomGateAt;
    if (scheduledRandomGate) {
      nextRandomGateAt = i + nextRandomGateDistance(args);
    }
    const inFollowWindow = i <= followUntil;

    if (
      !args.importOnly &&
      responses < args.respondLimit &&
      ((args.gateEvery > 0 && i % args.gateEvery === 0) ||
        interesting ||
        scheduledRandomGate ||
        inFollowWindow)
    ) {
      await handlePotentialReply(msg, String(i + args.start));
    }
  }

  console.log(
    `Replay complete. Imported ${rows.length} messages, injected ${emotionInjections} emotional tests, injected ${mediaInjections} media tests, ran ${gateChecks} gate checks, saved ${responses} Volty responses.`
  );
  console.log(`Inspect with: pnpm sim:inspect -- --db=${args.db}`);
};

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
