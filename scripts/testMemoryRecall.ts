import {existsSync} from 'node:fs';

import {AIService} from '../src/ai';
import {config, loadConfig} from '../src/config';
import {Database, type DBMessage} from '../src/db';

type Args = {
  db: string;
  users: number;
  contextProbe: boolean;
};

type RecallUser = {
  discord_user_id: bigint;
  username: string | null;
  memory_count: bigint;
  relationship_notes: string | null;
  memory_preview: string;
};

const GUILD_ID = 616161n;
const Volty_ID = 9999n;

const parseArgs = (): Args => {
  const args = new Set(process.argv.slice(2));
  const value = (name: string, fallback: string) =>
    process.argv
      .find(arg => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3) || fallback;
  const num = (name: string, fallback: number) => {
    const parsed = Number(value(name, String(fallback)));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    db: value('db', './db/memory-stress.sqlite3'),
    users: Math.max(1, num('users', 5)),
    contextProbe: args.has('--context-probe'),
  };
};

const nowId = () =>
  BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 900));

const fakeMember = (id: bigint) =>
  ({
    id: id.toString(),
    guild: {
      id: GUILD_ID.toString(),
      name: 'Memory Stress Recall',
      channels: {cache: new Map()},
    },
    permissionsIn: () => ({has: () => true}),
    client: {user: {id: Volty_ID.toString()}},
  }) as any;

const fakeChannel = {
  id: 'recall-lab',
  name: 'recall-lab',
  type: 0,
  topic: 'Local test channel for memory and Discord context tool recall.',
  nsfw: false,
  parent: {id: 'test-category', name: 'Test Category'},
} as any;

const makeUserMessage = (user: RecallUser, content: string): DBMessage => ({
  id: nowId(),
  content,
  discord_author_id: user.discord_user_id,
  discord_guild_id: GUILD_ID,
  parent: null,
  role: 'user',
  image_url: null,
  username: user.username || user.discord_user_id.toString(),
  nickname: user.username || user.discord_user_id.toString(),
});

const normalizeConfigForRecall = () => {
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
};

const askVolty = async ({
  ai,
  db,
  user,
  content,
}: {
  ai: AIService;
  db: Database;
  user: RecallUser;
  content: string;
}) => {
  const msg = makeUserMessage(user, content);
  db.insertMessage(msg);
  const resp = ai.streamText({
    messages: db.getConversation(msg.id),
    context: {
      replyingToMsgID: msg.id.toString(),
      botUsername: 'Volty',
      serverName: 'Memory Stress Recall',
      channelName: 'recall-lab',
      channelDescription:
        'Local test channel for checking whether stored memories affect replies.',
      member: fakeMember(user.discord_user_id),
      channel: fakeChannel,
      db,
      channelContextBeforeThread: null,
      engagementInstruction:
        'Memory recall test. If the user asks what you remember or what you think of them, use the private memory and relationship context directly. Name concrete remembered details naturally. Do not announce database use.',
    },
  });

  let finalText = '';
  for await (const part of resp) {
    if (part.state === 'finish') {
      finalText = part.fullText || '';
    }
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
  return finalText;
};

const run = async () => {
  const args = parseArgs();
  if (!existsSync(args.db)) {
    throw new Error(`DB does not exist: ${args.db}`);
  }

  loadConfig('./config.toml', false);
  normalizeConfigForRecall();
  config.response_agents.timeout_ms = Math.max(
    config.response_agents.timeout_ms,
    60_000
  );
  const db = new Database(args.db);
  const ai = new AIService();

  const users = db.db
    .prepare(
      `
      select
        m.discord_user_id,
        (
          select username
          from messages
          where discord_author_id = m.discord_user_id
          order by id desc
          limit 1
        ) as username,
        count(*) as memory_count,
        (
          select notes
          from relationships r
          where r.discord_guild_id = m.discord_guild_id
            and r.discord_user_id = m.discord_user_id
        ) as relationship_notes,
        group_concat(substr(m.content, 1, 120), ' | ') as memory_preview
      from memories m
      where m.discord_guild_id = ?
        and m.discord_user_id is not null
      group by m.discord_user_id
      order by count(*) desc, max(m.last_seen_at) desc
      limit ?
    `
    )
    .all(GUILD_ID, args.users) as RecallUser[];

  if (!users.length) {
    console.log('No user-specific memories found yet.');
    return;
  }

  console.log(`Testing recall for ${users.length} remembered user(s).`);
  for (const user of users) {
    const name = user.username || user.discord_user_id.toString();
    console.log(`\n## ${name} (${user.discord_user_id})`);
    console.log(`stored memories: ${user.memory_count}`);
    console.log(`preview: ${user.memory_preview}`);
    if (user.relationship_notes) {
      console.log(`relationship: ${user.relationship_notes}`);
    }

    const opener = await askVolty({
      ai,
      db,
      user,
      content: 'hey Volty, been a bit. what do you remember about me?',
    });
    console.log(`User: hey Volty, been a bit. what do you remember about me?`);
    console.log(`Volty: ${opener}`);

    const opinion = await askVolty({
      ai,
      db,
      user,
      content: 'be honest, what do you think of me?',
    });
    console.log(`User: be honest, what do you think of me?`);
    console.log(`Volty: ${opinion}`);

    if (args.contextProbe) {
      const contextAnswer = await askVolty({
        ai,
        db,
        user,
        content:
          'quick tool check: what channel are we in, and what does your relationship map say about me?',
      });
      console.log(
        `User: quick tool check: what channel are we in, and what does your relationship map say about me?`
      );
      console.log(`Volty: ${contextAnswer}`);
    }
  }
};

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
