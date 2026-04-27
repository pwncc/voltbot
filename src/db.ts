import {DatabaseSync, type StatementSync} from 'node:sqlite';

import {cleanContent, type Message} from 'discord.js';
import sqliteVec from 'sqlite-vec';

import type {Role} from './ai';
import {getImage} from './util/message';

export type DBMessage = {
  id: bigint;
  content: string;
  discord_author_id: bigint;
  discord_guild_id: bigint;
  parent: bigint | null;
  role: Role;
  image_url: string | null;
  username: string | null;
  nickname: string | null;
};

export type DBRAGKnowledge = {
  id: number;
  content: string;
  category: string;
  discord_guild_id: bigint;
};

export type DBVecMetadata = {
  distance: number;
};

export type DBTranscription = {
  id: bigint;
  text: string;
  discord_author_id: bigint;
  voice_message_id: bigint;
  transcription_message_id: bigint;
};

export type DBMemory = {
  id: number;
  discord_guild_id: bigint;
  discord_user_id: bigint | null;
  kind: string;
  content: string;
  salience: number;
  created_at: number;
  last_seen_at: number;
  source_message_id: bigint | null;
};

export type DBRelationship = {
  discord_guild_id: bigint;
  discord_user_id: bigint;
  trust: number;
  familiarity: number;
  affinity: number;
  tone: string | null;
  notes: string | null;
  updated_at: number;
};

export type DBMemoryChat = {
  id: number;
  discord_guild_id: bigint;
  discord_user_id: bigint | null;
  source_message_id: bigint;
  created_at: number;
  title: string;
  transcript: string;
};

const DB_MIGRATIONS = [
  `create virtual table if not exists server_knowledge_embeddings using vec0(
      id integer primary key references server_knowledge(id) on delete cascade,
      embedding float[4096]
    )`.trim(),
  `create table if not exists memories (
      id integer primary key,
      discord_guild_id integer not null,
      discord_user_id integer,
      kind text not null,
      content text not null,
      salience integer not null default 3,
      created_at integer not null default (unixepoch()),
      last_seen_at integer not null default (unixepoch()),
      source_message_id integer
    )`.trim(),
  `create index if not exists idx_memories_lookup
    on memories(discord_guild_id, discord_user_id, salience, last_seen_at)`.trim(),
  `create table if not exists relationships (
      discord_guild_id integer not null,
      discord_user_id integer not null,
      trust integer not null default 1,
      familiarity integer not null default 1,
      affinity integer not null default 0,
      tone text,
      notes text,
      updated_at integer not null default (unixepoch()),
      primary key (discord_guild_id, discord_user_id)
    )`.trim(),
  `create table if not exists memory_chats (
      id integer primary key,
      discord_guild_id integer not null,
      discord_user_id integer,
      source_message_id integer not null,
      created_at integer not null default (unixepoch()),
      title text not null,
      transcript text not null
    )`.trim(),
  `create index if not exists idx_memory_chats_lookup
    on memory_chats(discord_guild_id, discord_user_id, created_at)`.trim(),
];

export class Database {
  db: DatabaseSync;

  #isInConvoCache = new Map<bigint, boolean>();

  queries!: {
    insertMessage: StatementSync;
    updateMessage: StatementSync;
    isInConvo: StatementSync;
    getConversation: StatementSync;
    deleteChildren: StatementSync;
    queryRag: StatementSync;
    insertRagKnowledge: StatementSync;
    insertRagEmbedding: StatementSync;
    insertTranscription: StatementSync;
    deleteTranscription: StatementSync;
    getTranscription: StatementSync;
    insertMemory: StatementSync;
    getMemoryContext: StatementSync;
    getRelationship: StatementSync;
    upsertRelationship: StatementSync;
    insertMemoryChat: StatementSync;
    searchMemoryChats: StatementSync;
    fetchMemoryChat: StatementSync;
  };

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, {
      readBigInts: true,
      allowExtension: true,
      enableForeignKeyConstraints: true,
    });
    sqliteVec.load(this.db);
    this.initDb();
    this.initQueries();
  }

  getConversation(startID: bigint) {
    const convo = this.queries.getConversation.all(startID) as DBMessage[];
    for (const msg of convo) {
      this.#isInConvoCache.set(msg.id, true);
    }
    return convo;
  }

  insertMessage(msg: DBMessage) {
    this.#isInConvoCache.set(msg.id, true);

    return this.queries.insertMessage.run(
      msg.id,
      msg.content,
      msg.discord_author_id,
      msg.discord_guild_id,
      msg.parent,
      msg.role,
      msg.image_url,
      msg.username,
      msg.nickname
    );
  }

  updateMessage(msgID: bigint, content: string) {
    this.queries.updateMessage.run(content, msgID);
  }

  isInConvo(msgID: bigint): boolean {
    const fromCache = this.#isInConvoCache.get(msgID);
    if (fromCache !== undefined) {
      console.log({fromCache});
      return fromCache;
    }

    const res = this.queries.isInConvo.get(msgID);
    const isIn = res?.is_in_convo === 1n;
    this.#isInConvoCache.set(msgID, isIn);
    return isIn;
  }

  deleteChildren(msgID: bigint): DBMessage[] {
    const deleted = this.queries.deleteChildren.all(msgID) as DBMessage[];
    for (const msg of deleted) {
      this.#isInConvoCache.set(msg.id, false);
    }

    return deleted;
  }

  insertDiscordMessage(msg: Message, parentOverride?: bigint | null) {
    const content = cleanContent(
      msg.content.replaceAll(
        new RegExp(`<@!?${msg.client.user!.id}>`, 'g'),
        ''
      ),
      msg.channel
    ).trim();

    this.insertMessage({
      id: BigInt(msg.id),
      // content: `[Username: "${msg.author.username}", Nickname: "${msg.member?.nickname || msg.author.displayName || msg.author.username}"]: ${content}`,
      content,
      discord_author_id: BigInt(msg.author.id),
      discord_guild_id: BigInt(msg.guildId!),
      parent:
        parentOverride !== undefined
          ? parentOverride
          : BigInt(msg.reference?.messageId || 0) || null,
      role: 'user',
      image_url: getImage(msg),
      username: msg.author.username || null,
      nickname:
        msg.member?.nickname ||
        msg.author.displayName ||
        msg.author.username ||
        null,
    });
  }

  queryRag(embedding: number[], guildID: bigint, threshold = 0.88) {
    return this.queries.queryRag.all(
      JSON.stringify(embedding),
      threshold,
      guildID
    ) as (Pick<DBRAGKnowledge, 'category' | 'content'> &
      Pick<DBVecMetadata, 'distance'>)[];
  }

  insertKnowledge(kn: Omit<DBRAGKnowledge, 'id'> & {embedding: number[]}) {
    const textRow = this.queries.insertRagKnowledge.run(
      kn.content.trim(),
      kn.discord_guild_id,
      kn.category
    );
    this.queries.insertRagEmbedding.run(
      textRow.lastInsertRowid,
      JSON.stringify(kn.embedding)
    );
  }

  insertTranscription(
    messageID: bigint,
    text: string,
    authorID: bigint,
    tMessageID: bigint
  ) {
    this.queries.insertTranscription.run(messageID, text, authorID, tMessageID);
  }

  deleteTranscription(messageID: bigint) {
    return this.queries.deleteTranscription.all(messageID) as Pick<
      DBTranscription,
      'transcription_message_id'
    >[];
  }

  getTranscription(messageID: string) {
    return this.queries.getTranscription.get(
      messageID
    ) as DBTranscription | null;
  }

  insertMemory(memory: {
    discord_guild_id: bigint;
    discord_user_id: bigint | null;
    kind: string;
    content: string;
    salience: number;
    source_message_id: bigint | null;
  }) {
    return this.queries.insertMemory.run(
      memory.discord_guild_id,
      memory.discord_user_id,
      memory.kind,
      memory.content,
      memory.salience,
      memory.source_message_id
    );
  }

  getMemoryContext({
    guildID,
    userID,
    limit,
    maxChars,
  }: {
    guildID: bigint;
    userID: bigint;
    limit: number;
    maxChars: number;
  }) {
    const rows = this.queries.getMemoryContext.all(
      guildID,
      userID,
      limit
    ) as DBMemory[];
    const lines: string[] = [];
    let used = 0;

    for (const row of rows) {
      const owner =
        row.discord_user_id === null
          ? 'server/bot'
          : row.discord_user_id === userID
            ? 'current user'
            : `user ${row.discord_user_id}`;
      const line = `- [${row.kind}; ${owner}; ${row.salience}/5] ${row.content}`;
      const next = used ? used + line.length + 1 : line.length;
      if (next > maxChars) {
        break;
      }
      lines.push(line);
      used = next;
    }

    return lines.length ? lines.join('\n') : null;
  }

  getRelationship(guildID: bigint, userID: bigint) {
    return this.queries.getRelationship.get(
      guildID,
      userID
    ) as DBRelationship | null;
  }

  upsertRelationship({
    guildID,
    userID,
    trust,
    familiarity,
    affinity,
    tone,
    notes,
  }: {
    guildID: bigint;
    userID: bigint;
    trust: number;
    familiarity: number;
    affinity: number;
    tone: string | null;
    notes: string | null;
  }) {
    return this.queries.upsertRelationship.run(
      guildID,
      userID,
      trust,
      familiarity,
      affinity,
      tone,
      notes
    );
  }

  insertMemoryChat({
    guildID,
    userID,
    sourceMessageID,
    title,
    transcript,
  }: {
    guildID: bigint;
    userID: bigint | null;
    sourceMessageID: bigint;
    title: string;
    transcript: string;
  }) {
    return this.queries.insertMemoryChat.run(
      guildID,
      userID,
      sourceMessageID,
      title.slice(0, 160),
      transcript
    );
  }

  searchMemoryChats({
    guildID,
    userID,
    query,
    limit,
  }: {
    guildID: bigint;
    userID: bigint;
    query: string;
    limit: number;
  }) {
    const q = `%${query.toLowerCase()}%`;
    return this.queries.searchMemoryChats.all(
      guildID,
      userID,
      q,
      q,
      limit
    ) as Pick<
      DBMemoryChat,
      'id' | 'created_at' | 'title' | 'source_message_id'
    >[];
  }

  fetchMemoryChat({
    guildID,
    userID,
    id,
  }: {
    guildID: bigint;
    userID: bigint;
    id: number;
  }) {
    return this.queries.fetchMemoryChat.get(
      id,
      guildID,
      userID
    ) as DBMemoryChat | null;
  }

  initDb() {
    this.db.exec('pragma foreign_keys = on;');
    for (const migration of DB_MIGRATIONS) {
      this.db.exec(migration);
    }
  }

  initQueries() {
    this.queries = {
      insertMessage: this.db.prepare(`
        insert into messages (
          id,
          content,
          discord_author_id,
          discord_guild_id,
          parent,
          role,
          image_url,
          username,
          nickname
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `),

      updateMessage: this.db.prepare(`
        update messages
        set content = ?
        where id = ?
      `),

      isInConvo: this.db.prepare(`
        select 1 as is_in_convo
        from messages
        where id = ?
      `),

      getConversation: this.db.prepare(`
        with convo(id) as (
          select id
          from messages
          where id = ?
          union all
          select m.parent
          from convo c
          join messages m
          on c.id = m.id
        )
        select *
        from convo
        inner join messages m
        using(id)
        order by id asc
      `),

      deleteChildren: this.db.prepare(`
        with children(child) as (
          select ?
          union all
          select m.id
          from children c
          join messages m
          on c.child = m.parent
        )
        delete from messages
        where id in children
        returning *;
      `),

      queryRag: this.db.prepare(`
        with knn_matches as (
          select id, distance
          from server_knowledge_embeddings
          where embedding match ?
          and distance < ?
          order by distance asc
          limit 5
        )
        select sk.category, sk.content, knn_matches.distance
        from server_knowledge sk
        inner join knn_matches
        using (id)
        where sk.discord_guild_id = ?
          or sk.discord_guild_id = 0
      `),

      insertRagKnowledge: this.db.prepare(`
        insert into server_knowledge (content, discord_guild_id, category)
        values (?, ?, ?)
      `),

      insertRagEmbedding: this.db.prepare(`
        insert into server_knowledge_embeddings (id, embedding)
        values (?, ?)
      `),

      insertTranscription: this.db.prepare(`
        insert into transcriptions (voice_message_id, text, discord_author_id, transcription_message_id)
        values (?, ?, ?, ?)
      `),

      deleteTranscription: this.db.prepare(`
        delete from transcriptions
        where voice_message_id = ?
        returning transcription_message_id
      `),

      getTranscription: this.db.prepare(`
        select *
        from transcriptions
        where voice_message_id = ?
      `),

      insertMemory: this.db.prepare(`
        insert into memories (
          discord_guild_id,
          discord_user_id,
          kind,
          content,
          salience,
          source_message_id
        )
        values (?, ?, ?, ?, ?, ?)
      `),

      getMemoryContext: this.db.prepare(`
        select *
        from memories
        where discord_guild_id = ?
          and (discord_user_id is null or discord_user_id = ?)
        order by salience desc, last_seen_at desc, id desc
        limit ?
      `),

      getRelationship: this.db.prepare(`
        select *
        from relationships
        where discord_guild_id = ?
          and discord_user_id = ?
      `),

      upsertRelationship: this.db.prepare(`
        insert into relationships (
          discord_guild_id,
          discord_user_id,
          trust,
          familiarity,
          affinity,
          tone,
          notes,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, unixepoch())
        on conflict(discord_guild_id, discord_user_id) do update set
          trust = excluded.trust,
          familiarity = excluded.familiarity,
          affinity = excluded.affinity,
          tone = excluded.tone,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `),

      insertMemoryChat: this.db.prepare(`
        insert into memory_chats (
          discord_guild_id,
          discord_user_id,
          source_message_id,
          title,
          transcript
        )
        values (?, ?, ?, ?, ?)
      `),

      searchMemoryChats: this.db.prepare(`
        select id, created_at, title, source_message_id
        from memory_chats
        where discord_guild_id = ?
          and (discord_user_id is null or discord_user_id = ?)
          and (lower(title) like ? or lower(transcript) like ?)
        order by created_at desc
        limit ?
      `),

      fetchMemoryChat: this.db.prepare(`
        select *
        from memory_chats
        where id = ?
          and discord_guild_id = ?
          and (discord_user_id is null or discord_user_id = ?)
      `),
    };
  }
}
