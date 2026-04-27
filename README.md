<h1 align="center">Mira - LLM Chatbot</h1>

Another Discord-based LLM chatbot.

## Features
- RAG-based knowledge, useful for server rules, faq, lore
- Reply chain conversation history
- Recent channel context for short or vague prompts
- Long-term memory records for people, preferences, projects, and running bits
- Full archived chat transcripts that the bot can search/fetch when details matter
- Relationship state for trust, familiarity, tone, and social closeness
- Image input
- Basic web search (searxng)
- Voice message transcription

## Usage
To start a new thread, mention the bot with a prompt. Reply to the bot to continue the conversation, or ping it again to start a new thread. Replying to another user's message and pinging the bot will insert the replied-to message into the conversation.

```yaml
User: @Mira what time is it in Amsterdam
Bot: It's 5:14PM in Amsterdam right now.
User: What about in San Francisco?
Bot: It's 8:14AM in San Francisco.
```

## Tools
The bot includes a handful of tools that the language models can call:

- `search_web({query: string})`
- `get_current_time({timezone: string})`
- `fetch_discord_message({channelID: string, messsageID: string})`
- `search_memory_chats({query: string, limit?: number})`
- `fetch_memory_chat({id: number})`
- `query_server_knowledge({query: string})`

## Message Format and Contextual Data
User messages sent to the LLM are in the format `[Username: "benricheson101", Nickname: "ben"]: content`. This enables the language model to differentiate between multiple users in the same thread. The bot cannot access messages outside of its reply chain. The only exception to this is through the use of the `fetch_discord_message` tool, which lets the LLM access an outside message by its Discord ID (e.g., a user links to a message and asks for its content).

For short threads, Mira can also include a capped slice of recent channel messages before the thread started. This helps with prompts like "what do you think?" while keeping the reply-chain transcript as the primary conversation.

Some basic contextual info is included in each thread:
```md
## Environment Context
- Your username: {{BOT_USERNAME}},
- Server name: {{SERVER_NAME}}
- Channel name: {{CHANNEL_NAME}}
- Channel description: {{CHANNEL_DESCRIPTION}}
- Model: {{MODEL}}
```

### Web Search
Web search is provided by SearXNG. Because it's not a web scraper, it only returns limited information and not full page content. In my testing this is often sufficient for simple queries, but doesn't hold up when extensive research is required.

# Running It
```sh
$ pnpm build
$ DATABASE_URL=sqlite:./db/mira.sqlite3 dbmate up
$ pnpm mira:update-rag
$ pnpm mira:start
```

### With Docker
```sh
$ docker compose up -d searxng
$ docker compose run --rm mira mira:update-rag
$ docker compose up -d
```

### Voice Transcription Service
The voice transcription model runs on [Modal](https://modal.com).
```sh
$ cd whisper
$ uv sync
$ uv run modal run main.py::download_model
$ uv run modal secret create mt-api API_KEY=random-string-here
$ uv run modal deploy main.py
```

## Configuration
`./config.toml`
```toml
[discord]
# discord bot token
token = ""
# list of discord server IDs that the bot can operate in. leave empty to enable everywhere
enabled_guilds = []

[sqlite]
# the path to the sqlite database
path = "./db/mira.sqlite3"

[provider]
# openrouter-compatible API url.
# note: if this contains `localhost`, it will switch from openrouter to ollama for local models
base_url = ""
# openrouter api key
api_key = ""
# system prompt injected in every conversation. environment context is automatically injected after this, but some placeholders are still available to use inside the system prompt as needed:
#   {{BOT_USERNAME}}
#   {{SERVER_NAME}}
#   {{CHANNEL_NAME}}
#   {{CHANNEL_DESCRIPTION}}
#   {{MODEL}}
system_prompt = "You are a helpful assistant."

[model]
# the name of the primary model to use for text chats
primary_model = ""
# optional: openrouter provider `order`
provider = []
# max number of messages in a conversation. if a thread exceeds this number, the oldest messages are removed
max_history = 20
# max output tokens
max_output = 8000
# optional: a different model to use when images/files are uploaded since not all models are multimodal.
# Use the provider's exact vision/video model id, e.g. your GLM-4.6V route if available.
multimodal_model = ""
# local TestChat images/videos are sent directly to the multimodal model up to this byte cap
max_media_bytes = 25000000
# send video attachments as multimodal file parts when the provider/model supports it
include_video = true
# optional: for routing mutliple models (simple questions -> small, hard questions -> primary)
router_model = ""
# optional:
small_model = ""

[rag]
# the model to use for word embeddings for the RAG tool
embedding_model = ""

[web_search]
# the searxng server url
searxng_url = ""
# api key for https://jina.ai
jina_api_key = ""

[transcription]
# modal endpoint
endpoint = ""
# bearer token
api_key = ""

[channel_context]
# include recent channel messages for short/new threads
enabled = true
# fetch up to this many messages before the conversation root
max_messages = 40
# character budgets keep the extra context token-bounded
max_total_chars = 2800
max_chars_per_message = 180
# skip channel context once the reply chain already has this many messages
skip_if_thread_has_at_least = 10
# include bot messages in channel context
include_bots = false

[ambient_chat]
# let Mira decide when to respond without a mention/reply or casually join in
enabled = true
# mini-model transcript window for the engagement decision
max_messages = 40
max_total_chars = 4000
max_chars_per_message = 220
# keep the decision cheap and conservative
decision_timeout_ms = 12000
reply_confidence = 0.72
ambient_confidence = 0.60
ambient_chance = 0.18
# cooldowns apply to ambient joins, not implicit replies to Mira
channel_cooldown_minutes = 20
global_cooldown_seconds = 90

[memory]
# store compact durable notes from completed conversations
enabled = true
# cap how much memory is injected into any one request
max_records = 35
max_total_chars = 2800
# mini-model timeout for extracting new memories after replies
extraction_timeout_ms = 20000

[response_agents]
# run cheap critic agents before sending Volty's final message
enabled = true
# optional OpenAI-compatible endpoint for the critic agents, e.g. Modal gateway /v1
base_url = ""
api_key = ""
# good local defaults to try: llama3.1:8b-instruct, qwen2.5:7b-instruct, qwen3:8b
anti_slop_model = "llama3.1:8b-instruct"
realism_model = "llama3.1:8b-instruct"
context_model = "llama3.1:8b-instruct"
# model used for the one-shot rewrite if a critic rejects the draft; empty uses primary_model
revision_model = ""
timeout_ms = 20000
# lets the context critic use search tools for current/external factual claims
context_verification = true
```

### Modal Agent Gateway
`./modal/agent_gateway.py` deploys an OpenAI-compatible gateway for response agents. It keeps a CPU gateway warm (`min_containers=1`) and wakes a GPU vLLM worker only when the gate decides the request needs the 8B critic model.

```sh
$ modal secret create Volty-agent-gateway AGENT_GATEWAY_API_KEY=change-me
$ modal deploy modal/agent_gateway.py
```

Then set:
```toml
[response_agents]
base_url = "https://YOUR-MODAL-ENDPOINT.modal.run/v1"
api_key = "change-me"
anti_slop_model = "agent-8b"
realism_model = "agent-8b"
context_model = "agent-8b"
```

Modal knobs worth tuning in `agent_gateway.py`: `min_containers` keeps the CPU gate warm, `scaledown_window` controls idle retention, and the GPU worker stays at `min_containers=0` so it can scale to zero.

For no GPU model reloads, set `GPU_MIN_CONTAINERS=1` in the Modal secret/environment so one GPU container keeps the model resident in VRAM. That costs more because the GPU stays allocated. For lowest cost, leave `GPU_MIN_CONTAINERS=0` and increase `GPU_SCALEDOWN_WINDOW` if you want the GPU to stay warm briefly after bursts.

## Local Simulation
You can test the social/memory shape without a Discord server:

```sh
$ pnpm sim:chat -- --turns=20
```

This creates `./db/sim.sqlite3`, runs a fake furry-server chat with multiple users, saves bot replies into the normal message tables, and writes full archived chats into `memory_chats`.

Inspect what was saved:

```sh
$ pnpm sim:inspect
```

To let a local model generate the fake human messages:

```sh
$ pnpm sim:chat -- --turns=20 --models
```

For a fuller test, point `provider.base_url` at local Ollama/OpenAI-compatible models and use the Modal or local response-agent endpoint, then inspect `messages`, `memory_chats`, `memories`, and `relationships` in `./db/sim.sqlite3`.

Full end-to-end simulation uses model-generated fake humans, the real engagement gate, Volty's real response path, response agents, memory extraction, relationships, and full chat archives:

```sh
$ pnpm sim:full -- --sessions=2 --turns=12 --reset
$ pnpm sim:inspect -- --db=./db/sim-full.sqlite3
```

This can spend real OpenRouter/Modal money if those endpoints are configured.

### TestChat Replay
If you have an exported `./testchat` folder with `channelyap [part x].csv` files and matching media filenames, replay a bounded slice through the real ambient gate, Volty response path, response agents, compact memory extraction, relationships, and full memory-chat archive:

```sh
$ pnpm testchat:replay -- --reset --limit=240 --respond-limit=3
$ pnpm sim:inspect -- --db=./db/testchat-replay.sqlite3
```

Useful flags:

- `--import-only` only loads the CSV messages into SQLite.
- `--start=1200 --limit=300` replays a later window.
- `--respond-limit=0` exercises import and gate setup without model replies.
- `--gate-every=5` checks fewer messages, which is cheaper for large sweeps.
- `--random-gate --random-gate-min=12 --random-gate-max=45` checks whether Volty wants to interject after random message gaps instead of on a fixed cadence.
- `--follow-window=30` keeps checking messages more closely after Volty replies, so follow-up conversation can continue until the gate loses interest.
- `--dir=./TestChat --db=./db/testchat-window.sqlite3` points at custom paths.
- `--include-bots` keeps exported `Mira#...` bot rows; by default replay skips them so Volty is tested against human chat instead of old bot output.
- `--emotion-injections=3 --emotion-every=40` uses the configured 8B/response-agent model to inject direct emotional stress-test messages into the replay. These are stored and handled through the same Volty response, memory, relationship, and archive path as normal chat.
- `--emotion-model=agent-8b` overrides the model used for those injected stress tests.
- `--media-injections=2 --media-every=35` copies real TestChat image/video attachments into direct test messages like `@Volty what do you see in this attachment?`. These go through the normal multimodal response path, so set `model.multimodal_model` to a vision/video-capable model such as your GLM-4.6V route.
- `--media-kind=image` or `--media-kind=video` forces the media stress test to use only that attachment type. If the provider route rejects video files, replay retries without the binary and keeps the test running.

The replay is intentionally bounded by default because it can spend real OpenRouter/Modal money when those endpoints are configured.

`./knowledge/<server_id>.toml`
```toml
[[entry]]
category = "mira-faq"
content = """
Question: Is the bot open source?
Answer: The bot is open source. The source code can be found on GitHub at https://github.com/Benricheson101/mira and is licensed under the MIT license.
"""
```
