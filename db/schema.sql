CREATE TABLE "schema_migrations" (version varchar(128) primary key);
CREATE TABLE messages (
  id integer primary key, -- discord message id
  content text,
  discord_author_id bigint not null,
  discord_guild_id bigint not null,
  parent integer,
  role text not null check(role in ('user', 'assistant')),
  image_url text
, username text, nickname text);
CREATE TABLE server_knowledge (
  id integer primary key,
  content text not null,
  discord_guild_id integer not null,
  category text not null
);
CREATE TABLE transcriptions (
  id integer primary key,
  text text not null,
  discord_author_id integer not null,
  voice_message_id integer not null,
  transcription_message_id integer not null
);
CREATE TABLE memories (
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
CREATE INDEX idx_memories_lookup
on memories(discord_guild_id, discord_user_id, salience, last_seen_at);
CREATE TABLE relationships (
  discord_guild_id integer not null,
  discord_user_id integer not null,
  trust integer not null default 1,
  familiarity integer not null default 1,
  affinity integer not null default 0,
  tone text,
  notes text,
  updated_at integer not null default (unixepoch()),
  primary key (discord_guild_id, discord_user_id)
);
CREATE TABLE memory_chats (
  id integer primary key,
  discord_guild_id integer not null,
  discord_user_id integer,
  source_message_id integer not null,
  created_at integer not null default (unixepoch()),
  title text not null,
  transcript text not null
);
CREATE INDEX idx_memory_chats_lookup
on memory_chats(discord_guild_id, discord_user_id, created_at);
-- Dbmate schema migrations
INSERT INTO "schema_migrations" (version) VALUES
  ('20260323154300'),
  ('20260323214639'),
  ('20260326215409'),
  ('20260417015937'),
  ('20260426030000'),
  ('20260426031500'),
  ('20260426033000');
