import {createOpenAI} from '@ai-sdk/openai';
import {generateText, stepCountIs} from 'ai';
import {createOllama} from 'ai-sdk-ollama';

import {config} from './config';
import type {ConversationMessage} from './convo';
import {webSearch} from './tools/webSearch';

export type Role = 'user' | 'assistant' | 'system';

export class AIService {
  private openai: ReturnType<typeof createOpenAI>;
  private ollama: ReturnType<typeof createOllama>;

  readonly systemPrompt: string;

  constructor() {
    this.openai = createOpenAI({
      baseURL: `${config.openai.base_url}/v1`,
      apiKey: config.openai.api_key,
    });

    this.ollama = createOllama({
      baseURL: config.openai.base_url,
    });

    this.systemPrompt = config.openai.system_prompt;
  }

  async generateText({
    messages,
    context,
  }: {
    messages: ConversationMessage[];
    context: {
      botUsername: string;
      serverName: string;
      channelName: string;
      channelDescription: string;
    };
  }): Promise<{
    text: string;
    toolCalls?: {name: string; input: unknown}[];
  }> {
    const modelName = config.model.name;

    const systemPrompt = this.systemPrompt
      .replaceAll('{{BOT_USERNAME}}', context.botUsername)
      .replaceAll('{{SERVER_NAME}}', context.serverName)
      .replaceAll('{{CHANNEL_NAME}}', context.channelName)
      .replaceAll('{{CHANNEL_DESCRIPTION}}', context.channelDescription)
      .replaceAll('{{MODEL}}', modelName);

    const result = await generateText({
      model: this.ollama(modelName),
      system: systemPrompt,
      messages: messages,
      tools: {
        search_web: webSearch,
      },
      stopWhen: stepCountIs(3),
    });

    const toolCalls = result.toolCalls?.map(call => ({
      name: call.toolName,
      input: call.input,
    }));

    console.dir(result, {depth: null});

    return {
      text: result.text || 'Failed :(',
      toolCalls,
    };
  }
}
