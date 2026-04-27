import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';

import {generateText, Output} from 'ai';
import {createOllama} from 'ai-sdk-ollama';
import {z} from 'zod';

import {config, loadConfig} from '../src/config';
import {Database, type DBMessage} from '../src/db';

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
      'chaotic furry artist, red panda sona, lots of lowercase, jokes when nervous',
  },
  {
    id: 1002n,
    username: 'nullhowl',
    nickname: 'Null',
    style:
      'dry technical wolf, cares about Linux, keyboards, and being precise',
  },
  {
    id: 1003n,
    username: 'mothmilk',
    nickname: 'Moth',
    style:
      'soft moth sona, cozy game enjoyer, emotionally observant, asks gentle questions',
  },
];

const simSchema = z.object({
  speaker: z.enum(['Ash', 'Null', 'Moth']),
  content: z.string().min(1).max(500),
});

const nowDiscordId = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999));

const asDBMessage = ({
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

const renderTranscript = (messages: DBMessage[]) =>
  messages
    .map(m => `${m.role === 'assistant' ? 'Volty' : m.nickname}: ${m.content}`)
    .join('\n');

const cannedNext = (turn: number) => {
  const script = [
    {speaker: speakers[0], content: 'okay but protogens with tail screens are objectively peak design'},
    {speaker: speakers[1], content: 'objectively is doing a lot of work there'},
    {speaker: speakers[2], content: 'i like when the visor emotes are slightly too dramatic tbh'},
    {speaker: speakers[0], content: 'Volty would absolutely have a loading spinner face when embarrassed'},
    {speaker: speakers[1], content: 'wait did he say his real name yesterday or am i hallucinating'},
    {speaker: speakers[2], content: 'what do you think, Volty?'},
    {speaker: speakers[0], content: 'also ash canonically cannot draw paws today, tragic'},
    {speaker: speakers[1], content: 'nah explain the tail screen thing'},
  ];
  return script[turn % script.length];
};

const main = async () => {
  const args = new Set(process.argv.slice(2));
  const useModels = args.has('--models');
  const reset = args.has('--reset');
  const turnsArg = process.argv.find(a => a.startsWith('--turns='));
  const turns = turnsArg ? Number(turnsArg.split('=')[1]) : 10;

  loadConfig('./config.toml', false);
  const dbDir = join(process.cwd(), 'db');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir);
  }

  const simDbPath = './db/sim.sqlite3';
  if (reset && existsSync(simDbPath)) {
    rmSync(simDbPath);
  }
  {
    const {DatabaseSync} = await import('node:sqlite');
    const bootstrap = new DatabaseSync(simDbPath);
    const hasMessages = bootstrap
      .prepare(
        "select 1 as ok from sqlite_master where type = 'table' and name = 'messages'"
      )
      .get();
    if (!hasMessages) {
      bootstrap.exec(readFileSync('./db/schema.sql', 'utf8'));
    }
    bootstrap.close();
  }

  const db = new Database(simDbPath);
  const ollama = createOllama({baseURL: config.provider.base_url});

  const messages: DBMessage[] = [];
  let parent: bigint | null = null;

  console.log(`Simulating ${turns} turns. Model NPCs: ${useModels ? 'on' : 'off'}\n`);

  for (let turn = 0; turn < turns; turn++) {
    let next = cannedNext(turn);

    if (useModels) {
      const out = await generateText({
        model: ollama(config.model.small_model || config.model.primary_model),
        system: `Generate the next single Discord message in a furry server test chat.
Choose one speaker and write as them. Keep it casual and under 35 words.
Speakers:
${speakers.map(s => `- ${s.nickname}: ${s.style}`).join('\n')}`,
        prompt: renderTranscript(messages.slice(-12)) || 'Start the chat.',
        output: Output.object({schema: simSchema, name: 'sim_message'}),
        maxOutputTokens: 120,
        temperature: 0.9,
      });
      const speaker = speakers.find(s => s.nickname === out.output.speaker)!;
      next = {speaker, content: out.output.content};
    }

    const msg = asDBMessage({
      id: nowDiscordId(),
      speaker: next.speaker,
      content: next.content,
      parent,
    });
    db.insertMessage(msg);
    messages.push(msg);
    parent = msg.id;
    console.log(`${next.speaker.nickname}: ${next.content}`);

    const shouldPingVolty =
      next.content.toLowerCase().includes('Volty') ||
      next.content.toLowerCase().includes('what do you think');
    if (!shouldPingVolty) {
      continue;
    }

    const reply = `[simulated Volty reply] ${next.content.includes('real name') ? "depends how close you are with him :3" : 'tail screens are excellent because they turn body language into UI nonsense'}`;
    const botMsg = asDBMessage({
      id: nowDiscordId(),
      speaker: {
        id: 9999n,
        username: 'Volty',
        nickname: 'Volty',
        style: '',
      },
      content: reply,
      parent: msg.id,
      role: 'assistant',
    });
    db.insertMessage(botMsg);
    messages.push(botMsg);
    parent = botMsg.id;
    console.log(`Volty: ${reply}`);

    db.insertMemoryChat({
      guildID: 424242n,
      userID: msg.discord_author_id,
      sourceMessageID: msg.id,
      title: msg.content,
      transcript: renderTranscript(messages.slice(-12)),
    });
  }

  console.log('\nSaved sim DB at ./db/sim.sqlite3');
  console.log('Try inspecting memory_chats, memories, and relationships after adding real model extraction.');
};

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
