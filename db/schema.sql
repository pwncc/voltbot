CREATE TABLE IF NOT EXISTS "schema_migrations" (version varchar(128) primary key);
CREATE TABLE messages (
  id integer primary key, -- discord message id
  content text,
  discord_author_id bigint not null,
  discord_guild_id bigint not null,
  parent integer,
  role text not null check(role in ('user', 'assistant')),
  image_url text
);
-- Dbmate schema migrations
INSERT INTO "schema_migrations" (version) VALUES
  ('20260323154300');
