import {DatabaseSync, type StatementSync} from 'node:sqlite';

import type {Role} from './ai';

export type DBMessage = {
  id: bigint;
  content: string;
  discord_author_id: bigint;
  discord_guild_id: bigint;
  parent: bigint | null;
  role: Role;
  image_url: string | null;
};

export class Database {
  db: DatabaseSync;

  #isInConvoCache = new Map<bigint, boolean>();

  queries!: {
    insertMessage: StatementSync;
    isInConvo: StatementSync;
    getConversation: StatementSync;
    deleteChildren: StatementSync;
  };

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, {
      readBigInts: true,
    });
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
      msg.image_url
    );
  }

  isInConvo(msgID: bigint): boolean {
    const fromCache = this.#isInConvoCache.get(msgID);
    if (fromCache !== undefined) {
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
          image_url
        )
        values (?, ?, ?, ?, ?, ?, ?);
      `),

      isInConvo: this.db.prepare(`
        select 1 as is_in_convo
        from messages
        where id = ?
      `),

      // we have graph db at home
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
    };
  }
}
