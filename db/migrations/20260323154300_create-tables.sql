-- migrate:up
create table messages (
  id integer primary key, -- discord message id
  content text,
  discord_author_id bigint not null,
  discord_guild_id bigint not null,
  parent integer,
  role text not null check(role in ('user', 'assistant')),
  image_url text
);

-- TODO: threads

-- migrate:down
drop table messages;
