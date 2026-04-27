import {DatabaseSync} from 'node:sqlite';

const dbPath =
  process.argv.find(a => a.startsWith('--db='))?.split('=')[1] ||
  process.argv[2] ||
  './db/sim.sqlite3';
const db = new DatabaseSync(dbPath, {readBigInts: true});

const printRows = (title: string, sql: string) => {
  console.log(`\n## ${title}`);
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  if (!rows.length) {
    console.log('(none)');
    return;
  }
  for (const row of rows) {
    console.log(JSON.stringify(row, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
  }
};

printRows(
  'Recent Messages',
  `select id, role, username, nickname, parent, content
   from messages
   order by id desc
   limit 12`
);

printRows(
  'Memory Chats',
  `select id, discord_user_id, title, substr(transcript, 1, 240) as preview
   from memory_chats
   order by id desc
   limit 8`
);

printRows(
  'Compact Memories',
  `select discord_user_id, kind, salience, content
   from memories
   order by id desc
   limit 12`
);

printRows(
  'Relationships',
  `select discord_user_id, trust, familiarity, affinity, tone, notes
   from relationships
   order by updated_at desc
   limit 12`
);

db.close();
