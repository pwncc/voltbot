-- migrate:up
create table memory_chats (
  id integer primary key,
  discord_guild_id integer not null,
  discord_user_id integer,
  source_message_id integer not null,
  created_at integer not null default (unixepoch()),
  title text not null,
  transcript text not null
);

create index idx_memory_chats_lookup
on memory_chats(discord_guild_id, discord_user_id, created_at);

-- migrate:down
drop index idx_memory_chats_lookup;
drop table memory_chats;
