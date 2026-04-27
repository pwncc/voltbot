-- migrate:up
create table relationships (
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

-- migrate:down
drop table relationships;
