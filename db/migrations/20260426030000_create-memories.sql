-- migrate:up
create table memories (
  id integer primary key,
  discord_guild_id integer not null,
  discord_user_id integer,
  kind text not null,
  content text not null,
  salience integer not null default 3,
  created_at integer not null default (unixepoch()),
  last_seen_at integer not null default (unixepoch()),
  source_message_id integer
);

create index idx_memories_lookup
on memories(discord_guild_id, discord_user_id, salience, last_seen_at);

-- migrate:down
drop index idx_memories_lookup;
drop table memories;
