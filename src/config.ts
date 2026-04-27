import assert from 'node:assert';
import {
  existsSync,
  readFileSync,
  statSync,
  type StatWatcher,
  watchFile,
} from 'node:fs';
import path from 'node:path';

import {parse} from 'toml';

const resolveSystemPromptFile = (raw: string, configFilePath: string) => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }
  const baseDir = path.dirname(path.resolve(configFilePath));
  const candidate = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(baseDir, trimmed);
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return readFileSync(candidate, 'utf8');
    }
  } catch {
    // not a readable file; use inline value
  }
  return raw;
};

export type ModelConfig = {
  primary_model: string;
  small_model?: string;
  multimodal_model?: string;
  max_media_bytes?: number;
  include_video?: boolean;
  router_model?: string;
  provider?: string[];
  max_history?: number;
  max_output?: number;
  enable_routing: boolean;
};

export type ProviderConfig = {
  base_url: string;
  api_key: string;
  system_prompt: string;
};

export type DiscordConfig = {
  token: string;
  enabled_guilds: string[];
};

export type WebSearchConfig = {
  searxng_url: string;
  jina_api_key?: string;
};

export type SQLiteConfig = {
  path: string;
};

export type RAGConfig = {
  embedding_model: string;
};

export type MiscConfig = {
  debug_show_tokens: boolean;
};

export type TranscriptionConfig = {
  endpoint: string;
  api_key: string;
};

export type ChannelContextConfig = {
  enabled: boolean;
  max_messages: number;
  max_total_chars: number;
  max_chars_per_message: number;
  skip_if_thread_has_at_least: number;
  include_bots: boolean;
};

export type AmbientChatConfig = {
  enabled: boolean;
  max_messages: number;
  max_total_chars: number;
  max_chars_per_message: number;
  decision_timeout_ms: number;
  reply_confidence: number;
  ambient_confidence: number;
  ambient_chance: number;
  channel_cooldown_minutes: number;
  global_cooldown_seconds: number;
};

export type MemoryConfig = {
  enabled: boolean;
  max_records: number;
  max_total_chars: number;
  extraction_timeout_ms: number;
};

export type ResponseAgentsConfig = {
  enabled: boolean;
  base_url?: string;
  api_key?: string;
  anti_slop_model: string;
  realism_model: string;
  context_model: string;
  revision_model: string;
  timeout_ms: number;
  context_verification: boolean;
};

export type Config = {
  discord: DiscordConfig;
  provider: ProviderConfig;
  model: ModelConfig;
  web_search: WebSearchConfig;
  sqlite: SQLiteConfig;
  rag: RAGConfig;
  misc: MiscConfig;
  transcription: TranscriptionConfig;
  channel_context: ChannelContextConfig;
  ambient_chat: AmbientChatConfig;
  memory: MemoryConfig;
  response_agents: ResponseAgentsConfig;
};

export let config: Config;
export let watcher: StatWatcher | undefined;

export const loadConfig = (configPath = 'config.toml', watch = true) => {
  if (!watcher && watch) {
    watcher = watchFile(configPath, () => {
      console.log('Config file changed, reloading...');
      loadConfig(configPath);
    });
  }

  const configFile = readFileSync(configPath, 'utf8');
  config = parse(configFile);

  assert(config.discord.token, 'missing discord.token');
  assert(config.provider?.base_url, 'missing provider.base_url');

  if (typeof config.provider.system_prompt === 'string') {
    config.provider.system_prompt = resolveSystemPromptFile(
      config.provider.system_prompt,
      configPath
    );
  }

  // ollama doesn't need an api key so any string works
  if (!config.provider.api_key) {
    config.provider.api_key = ':3';
  }

  if (!config.model.max_history) {
    config.model.max_history = 0;
  }

  if (!config.discord.enabled_guilds) {
    config.discord.enabled_guilds = [];
  }

  if (!config.sqlite.path) {
    config.sqlite.path = ':memory:';
  }

  if (config.misc?.debug_show_tokens === undefined) {
    config.misc = {debug_show_tokens: false};
  }

  if (config.model.enable_routing === undefined) {
    config.model.enable_routing = !!config.model.router_model;
  }
  config.model.max_media_bytes = config.model.max_media_bytes ?? 25_000_000;
  config.model.include_video = config.model.include_video ?? true;

  const channelContext = config.channel_context as Partial<ChannelContextConfig>;
  config.channel_context = {
    enabled: channelContext?.enabled ?? true,
    max_messages: channelContext?.max_messages ?? 40,
    max_total_chars: channelContext?.max_total_chars ?? 2_800,
    max_chars_per_message: channelContext?.max_chars_per_message ?? 180,
    skip_if_thread_has_at_least:
      channelContext?.skip_if_thread_has_at_least ?? 10,
    include_bots: channelContext?.include_bots ?? false,
  };

  const ambientChat = config.ambient_chat as Partial<AmbientChatConfig>;
  config.ambient_chat = {
    enabled: ambientChat?.enabled ?? true,
    max_messages: ambientChat?.max_messages ?? 40,
    max_total_chars: ambientChat?.max_total_chars ?? 4_000,
    max_chars_per_message: ambientChat?.max_chars_per_message ?? 220,
    decision_timeout_ms: ambientChat?.decision_timeout_ms ?? 12_000,
    reply_confidence: ambientChat?.reply_confidence ?? 0.72,
    ambient_confidence: ambientChat?.ambient_confidence ?? 0.6,
    ambient_chance: ambientChat?.ambient_chance ?? 0.18,
    channel_cooldown_minutes: ambientChat?.channel_cooldown_minutes ?? 20,
    global_cooldown_seconds: ambientChat?.global_cooldown_seconds ?? 90,
  };

  const memory = config.memory as Partial<MemoryConfig>;
  config.memory = {
    enabled: memory?.enabled ?? true,
    max_records: memory?.max_records ?? 35,
    max_total_chars: memory?.max_total_chars ?? 2_800,
    extraction_timeout_ms: memory?.extraction_timeout_ms ?? 20_000,
  };

  const responseAgents = config.response_agents as Partial<ResponseAgentsConfig>;
  const defaultAgentModel =
    config.model.small_model ||
    config.model.router_model ||
    config.model.primary_model;
  const agentModel = (raw: string | undefined, fallback: string) =>
    raw?.trim() || fallback;
  config.response_agents = {
    enabled: responseAgents?.enabled ?? true,
    base_url: responseAgents?.base_url?.trim() || undefined,
    api_key: responseAgents?.api_key?.trim() || undefined,
    anti_slop_model: agentModel(
      responseAgents?.anti_slop_model,
      defaultAgentModel
    ),
    realism_model: agentModel(responseAgents?.realism_model, defaultAgentModel),
    context_model: agentModel(responseAgents?.context_model, defaultAgentModel),
    revision_model: agentModel(
      responseAgents?.revision_model,
      config.model.primary_model
    ),
    timeout_ms: responseAgents?.timeout_ms ?? 20_000,
    context_verification: responseAgents?.context_verification ?? true,
  };

  return config;
};

export const isGuildEnabled = (g: string) =>
  config.discord.enabled_guilds.length
    ? config.discord.enabled_guilds.includes(g)
    : true;
