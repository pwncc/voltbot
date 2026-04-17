import {
  ApplicationCommandType,
  InteractionContextType,
  REST,
  type RESTPutAPIApplicationCommandsJSONBody,
  Routes,
} from 'discord.js';

import {loadConfig} from '../src/config';

const CMDS: RESTPutAPIApplicationCommandsJSONBody = [
  {
    name: 'Transcribe',
    type: ApplicationCommandType.Message,
    contexts: [
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ],
  },
];

const main = async () => {
  const config = loadConfig('./config.toml', false);

  const rest = new REST().setToken(config.discord.token);

  const appID = Buffer.from(
    config.discord.token.split('.')[0],
    'base64'
  ).toString();

  const out = await rest.put(Routes.applicationCommands(appID), {
    body: CMDS,
  });

  console.dir(out, {depth: null});
};

main().catch(console.error);
