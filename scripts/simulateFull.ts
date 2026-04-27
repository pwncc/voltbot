import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';

import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {generateText} from 'ai';
import {createOllama} from 'ai-sdk-ollama';
import {z} from 'zod';

import {AIService, type EngagementDecision} from '../src/ai';
import {config, loadConfig} from '../src/config';
import {Database, type DBMessage} from '../src/db';
import type {ChannelTranscriptMessage} from '../src/util/channelPreamble';

type SimSpeaker = {
  id: bigint;
  username: string;
  nickname: string;
  style: string;
};

const speakers: SimSpeaker[] = [
  {
    id: 1001n,
    username: 'ashbyte',
    nickname: 'Ash',
    style:
      'chaotic furry artist, red panda sona, lowercase, dramatic about drawing paws, likes teasing Volty',
  },
  {
    id: 1002n,
    username: 'nullhowl',
    nickname: 'Null',
    style:
      'dry technical wolf, Linux and keyboards, skeptical, notices contradictions',
  },
  {
    id: 1003n,
    username: 'mothmilk',
    nickname: 'Moth',
    style:
      'soft moth sona, cozy games, emotionally observant, asks gentle direct questions',
  },
];

const npcSchema = z.object({
  speaker: z.enum(['Ash', 'Null', 'Moth']),
  content: z.string().min(1).max(420),
});

const parseNpc = (text: string) => {
  const json = text.match(/\{[\s\S]*\}/)?.[0] || text;
  const parsed = npcSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data;
};

const fallbackNpc = (turn: number) => {
  const script = [
    {speaker: 'Ash' as const, content: 'Volty would totally have a loading spinner face when embarrassed'},
    {speaker: 'Null' as const, content: 'nah wait, explain what you mean by that'},
    {speaker: 'Moth' as const, content: 'what do you think, Volty?'},
  ];
  return script[turn % script.length]!;
};

const generateNpcMessage = async ({
  model,
  messages,
  turn,
  verbose,
}: {
  model: any;
  messages: DBMessage[];
  turn: number;
  verbose: boolean;
}) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const npc = await generateText({
        model,
        system: `Write the next single Discord message in a furry server simulation.
Pick one speaker and write as them. Keep it under 45 words.
Sometimes address Volty directly, sometimes imply a reply to him, and usually just let humans talk.
Do not be too neat.
Return only JSON like {"speaker":"Ash","content":"message here"}.
Speakers:
${speakers.map(s => `- ${s.nickname}: ${s.style}`).join('\n')}`,
        prompt:
          renderChat(messages.slice(-18)) ||
          'Start with casual furry server chat about protogens, OCs, games, or art.',
        maxOutputTokens: 180,
        temperature: 0.9,
        timeout: 60_000,
      });

      const parsed = parseNpc(npc.text);
      if (parsed.content.trim()) {
        return parsed;
      }
    } catch (err) {
      if (verbose) {
        console.error(`NPC generation attempt ${attempt} failed:`, err);
      }
    }
  }

  return fallbackNpc(turn);
};

const nowDiscordId = () =>
  BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999));

const initSimDb = async (path: string, reset: boolean) => {
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

const renderChat = (messages: DBMessage[]) =>
  messages
    .map(m => `${m.role === 'assistant' ? 'Volty' : m.nickname}: ${m.content}`)
    .join('\n');

const toTranscript = (messages: DBMessage[]): ChannelTranscriptMessage[] =>
  messages.map(m => ({
    id: m.id.toString(),
    author: m.nickname || m.username || m.discord_author_id.toString(),
    isBot: m.role === 'assistant',
    isMira: m.role === 'assistant',
    content: m.content,
  }));

const makeMessage = ({
  id,
  speaker,
  content,
  parent,
  role = 'user',
}: {
  id: bigint;
  speaker: SimSpeaker;
  content: string;
  parent: bigint | null;
  role?: 'user' | 'assistant';
}): DBMessage => ({
  id,
  content,
  discord_author_id: speaker.id,
  discord_guild_id: 424242n,
  parent,
  role,
  image_url: null,
  username: speaker.username,
  nickname: speaker.nickname,
});

const fakeMember = (speaker: SimSpeaker) =>
  ({
    id: speaker.id.toString(),
    guild: {
      id: '424242',
      name: 'Local Furry Sim',
      channels: {cache: new Map()},
    },
    permissionsIn: () => ({has: () => true}),
  }) as any;

const simChannelContext = (messages: DBMessage[]) =>
  messages
    .slice(-30)
    .map(m => `${m.role === 'assistant' ? 'Volty' : m.nickname}: ${m.content}`)
    .join('\n');

const run = async () => {
  const args = new Set(process.argv.slice(2));
  const reset = args.has('--reset');
  const verbose = args.has('--verbose');
  const turnsArg = process.argv.find(a => a.startsWith('--turns='));
  const sessionsArg = process.argv.find(a => a.startsWith('--sessions='));
  const turns = turnsArg ? Number(turnsArg.split('=')[1]) : 16;
  const sessions = sessionsArg ? Number(sessionsArg.split('=')[1]) : 2;
  const dbPath = './db/sim-full.sqlite3';

  loadConfig('./config.toml', false);
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
  await initSimDb(dbPath, reset);

  const db = new Database(dbPath);
  const ai = new AIService();
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
  const npcModelName =
    process.env.SIM_NPC_MODEL ||
    (agentRouter
      ? config.response_agents.realism_model
      : config.model.small_model ||
        config.model.router_model ||
        config.model.primary_model);
  const model = agentRouter
    ? agentRouter(npcModelName)
    : (isLocal ? ollama : openrouter)(npcModelName);

  const channelMessages: DBMessage[] = [];
  let lastAssistantId: bigint | null = null;

  console.log(
    `Full simulation: ${sessions} session(s), ${turns} turns each. NPCs via ${npcModelName}. Response agents: ${config.response_agents.enabled ? 'on' : 'off'}`
  );
  if (config.response_agents.base_url) {
    console.log(`Response agents endpoint: ${config.response_agents.base_url}`);
  }

  for (let session = 0; session < sessions; session++) {
    console.log(`\n=== Session ${session + 1} ===`);

    for (let turn = 0; turn < turns; turn++) {
      const npcOutput = await generateNpcMessage({
        model,
        messages: channelMessages,
        turn,
        verbose,
      });
      const speaker = speakers.find(s => s.nickname === npcOutput.speaker)!;
      const userMsg = makeMessage({
        id: nowDiscordId(),
        speaker,
        content: npcOutput.content,
        parent: null,
      });
      db.insertMessage(userMsg);
      channelMessages.push(userMsg);
      console.log(`${speaker.nickname}: ${userMsg.content}`);

      const direct = /\bVolty\b/i.test(userMsg.content);
      let decision: EngagementDecision = {
        mode: direct ? 'reply_to_mira' : 'ignore',
        confidence: direct ? 1 : 0,
        targetMessageId: lastAssistantId?.toString() || null,
        reason: direct ? 'Directly addressed Volty.' : 'No decision yet.',
        angle: '',
      };

      if (!direct) {
        decision = await ai.decideChannelEngagement({
          transcript: toTranscript(channelMessages.slice(-config.ambient_chat.max_messages)),
          newestMessageId: userMsg.id.toString(),
          botUsername: 'Volty',
          channelName: 'sim-chat',
        });
      }

      const shouldReply =
        direct ||
        (decision.mode === 'reply_to_mira' &&
          decision.confidence >= config.ambient_chat.reply_confidence) ||
        (decision.mode === 'ambient_join' &&
          decision.confidence >= config.ambient_chat.ambient_confidence);

      console.log(
        `  gate: ${decision.mode} (${decision.confidence.toFixed(2)}) ${decision.reason}`
      );

      if (!shouldReply) {
        continue;
      }

      const parent =
        decision.mode === 'reply_to_mira' && lastAssistantId
          ? lastAssistantId
          : null;
      userMsg.parent = parent;
      db.updateMessage(userMsg.id, userMsg.content);

      const convo = db.getConversation(userMsg.id);
      const resp = ai.streamText({
        messages: convo,
        context: {
          replyingToMsgID: userMsg.id.toString(),
          botUsername: 'Volty',
          serverName: 'Local Furry Sim',
          channelName: 'sim-chat',
          channelDescription:
            'Local test channel for furry/protogen social behavior.',
          member: fakeMember(speaker),
          db,
          channelContextBeforeThread: simChannelContext(channelMessages),
          engagementInstruction:
            decision.mode === 'ambient_join'
              ? `You are joining ambiently. Angle: ${decision.angle}`
              : `You are responding naturally. Angle: ${decision.angle}`,
        },
      });

      let finalText = '';
      for await (const part of resp) {
        if (part.state === 'finish') {
          finalText = part.fullText || '';
        }
      }

      const botMsg = makeMessage({
        id: nowDiscordId(),
        speaker: {
          id: 9999n,
          username: 'Volty',
          nickname: 'Volty',
          style: '',
        },
        content: finalText,
        parent: userMsg.id,
        role: 'assistant',
      });
      db.insertMessage(botMsg);
      db.insertMemoryChat({
        guildID: 424242n,
        userID: speaker.id,
        sourceMessageID: userMsg.id,
        title: userMsg.content,
        transcript: renderChat([...channelMessages.slice(-18), botMsg]),
      });
      await ai.extractMemories({
        messages: convo,
        assistantResponse: finalText,
        guildID: 424242n,
        sourceMessageID: userMsg.id,
        db,
      });

      channelMessages.push(botMsg);
      lastAssistantId = botMsg.id;
      console.log(`Volty: ${finalText}`);
    }
  }

  console.log(`\nSaved full sim DB at ${dbPath}`);
};

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
