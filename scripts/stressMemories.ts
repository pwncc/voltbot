import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {AIService} from '../src/ai';
import {config, loadConfig} from '../src/config';
import {Database, type DBMessage} from '../src/db';

type Args = {
  dir: string;
  db: string;
  reset: boolean;
  start: number;
  limit: number;
  chunkSize: number;
  stride: number;
  maxChunks: number;
  targetTokens: number;
};

type TestChatRow = {
  authorID: bigint;
  author: string;
  date: Date;
  content: string;
  attachments: string[];
  reactions: string;
};

const GUILD_ID = 616161n;

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
  return {
    dir: value('dir', './testchat'),
    db: value('db', './db/memory-stress.sqlite3'),
    reset: args.has('--reset'),
    start: Math.max(0, num('start', 0)),
    limit: Math.max(1, num('limit', 4_000)),
    chunkSize: Math.max(8, num('chunk-size', 36)),
    stride: Math.max(4, num('stride', 24)),
    maxChunks: Math.max(1, num('max-chunks', 80)),
    targetTokens: Math.max(100, num('target-tokens', 4_000)),
  };
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

const splitAttachments = (attachments: string) =>
  attachments
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);

const renderContent = (row: TestChatRow) => {
  const parts = [row.content.trim().replace(/@?Mira\b/gi, '@Volty')];
  if (row.attachments.length) {
    parts.push(row.attachments.map(a => `[attachment: ${a}]`).join(' '));
  }
  if (row.reactions.trim()) {
    parts.push(`[reactions: ${row.reactions.trim()}]`);
  }
  return parts.filter(Boolean).join(' ').trim() || '[empty message]';
};

const loadRows = (dir: string) => {
  const root = resolve(dir);
  const files = readdirSync(root)
    .filter(name => /^channelyap \[part \d+\]\.csv$/i.test(name))
    .sort((a, b) => partNumber(a) - partNumber(b));
  const rows: TestChatRow[] = [];

  for (const file of files) {
    const parsed = parseCsv(readFileSync(join(root, file), 'utf8'));
    parsed.shift();
    for (const cols of parsed) {
      if (cols.length < 6 || !cols[0] || /^Mira#/i.test(cols[1] || '')) {
        continue;
      }
      rows.push({
        authorID: BigInt(cols[0]!),
        author: cols[1] || 'unknown',
        date: new Date(cols[2]!),
        content: cols[3] || '',
        attachments: splitAttachments(cols[4] || ''),
        reactions: cols[5] || '',
      });
    }
  }

  return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
};

const makeId = (row: TestChatRow, offset: number) =>
  BigInt(Number.isFinite(row.date.getTime()) ? row.date.getTime() : Date.now()) *
    1000n +
  BigInt(offset % 1000);

const toDbMessage = (row: TestChatRow, offset: number): DBMessage => ({
  id: makeId(row, offset),
  content: renderContent(row),
  discord_author_id: row.authorID,
  discord_guild_id: GUILD_ID,
  parent: null,
  role: 'user',
  image_url: null,
  username: row.author,
  nickname: row.author,
});

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

const approxTokens = (s: string) => Math.ceil(s.length / 4);

const memoryStats = (db: Database) => {
  const row = db.db
    .prepare(
      `select
        count(*) as memories,
        count(distinct discord_user_id) as memory_users,
        coalesce(sum(length(content)), 0) as memory_chars
      from memories`
    )
    .get() as {memories: bigint; memory_users: bigint; memory_chars: bigint};
  const rel = db.db
    .prepare(
      `select
        count(*) as relationships,
        coalesce(sum(length(coalesce(tone, '')) + length(coalesce(notes, ''))), 0) as relationship_chars
      from relationships`
    )
    .get() as {relationships: bigint; relationship_chars: bigint};
  const chars = Number(row.memory_chars) + Number(rel.relationship_chars);
  return {
    memories: Number(row.memories),
    memoryUsers: Number(row.memory_users),
    relationships: Number(rel.relationships),
    chars,
    tokens: approxTokens('x'.repeat(chars)),
  };
};

const chunkScore = (messages: DBMessage[]) => {
  const users = new Set(messages.map(m => m.discord_author_id.toString())).size;
  const text = messages.map(m => m.content).join('\n');
  const signals = [
    /\b(i am|i'm|im|my|me|we|our|bf|friend|sona|oc|game|play|like|hate|feel|want|need)\b/i,
    /\?/.test(text),
    /\[attachment:/.test(text),
    users >= 3,
  ].filter(Boolean).length;
  return users * 2 + signals;
};

const run = async () => {
  const args = parseArgs();
  loadConfig('./config.toml', false);
  config.memory.extraction_timeout_ms = Math.max(
    config.memory.extraction_timeout_ms,
    60_000
  );
  await initDb(args.db, args.reset);

  const rows = loadRows(args.dir).slice(args.start, args.start + args.limit);
  const db = new Database(args.db);
  const ai = new AIService();
  const messages = rows.map((row, i) => toDbMessage(row, args.start + i));
  for (const msg of messages) {
    db.insertMessage(msg);
  }

  const candidates: DBMessage[][] = [];
  for (
    let i = 0;
    i + args.chunkSize <= messages.length && candidates.length < args.maxChunks * 3;
    i += args.stride
  ) {
    const chunk = messages.slice(i, i + args.chunkSize);
    if (new Set(chunk.map(m => m.discord_author_id.toString())).size >= 2) {
      candidates.push(chunk);
    }
  }
  candidates.sort((a, b) => chunkScore(b) - chunkScore(a));

  console.log(
    `Memory stress: ${messages.length} imported messages, ${candidates.length} candidate chunks, target ~${args.targetTokens} tokens.`
  );

  let processed = 0;
  for (const chunk of candidates.slice(0, args.maxChunks)) {
    const before = memoryStats(db);
    const source = chunk.at(-1)!;
    await ai.extractMemories({
      messages: chunk,
      assistantResponse:
        'Volty privately observed this stretch of server chat and is deciding what should matter later.',
      guildID: GUILD_ID,
      sourceMessageID: source.id,
      db,
    });
    processed++;
    const after = memoryStats(db);
    if (after.tokens !== before.tokens) {
      console.log(
        `chunk ${processed}: memories=${after.memories}, relationships=${after.relationships}, users=${after.memoryUsers}, approx_tokens=${after.tokens}`
      );
    }
    if (after.tokens >= args.targetTokens) {
      break;
    }
  }

  const finalStats = memoryStats(db);
  console.log(
    `Done. chunks=${processed}, memories=${finalStats.memories}, relationships=${finalStats.relationships}, memory_users=${finalStats.memoryUsers}, approx_tokens=${finalStats.tokens}`
  );
  console.log(`Inspect with: pnpm sim:inspect -- --db=${args.db}`);
};

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
