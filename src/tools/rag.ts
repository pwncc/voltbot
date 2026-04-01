import {tool} from 'ai';
import type {GuildMember} from 'discord.js';
import {z} from 'zod';

import type {AIService} from '../ai';
import type {Database} from '../db';

const getEmbeddingQuery = (query: string) =>
  `Instruct: given a query about a Discord server's rules, FAQs or Discord bots, find the relevant result that answers the query\nQuery: ${query}`;

export const ragTools = (member: GuildMember, db: Database, ai: AIService) => ({
  query_server_knowledge: tool({
    description:
      "Search the Discord server knowledge base for information related to the server, like rules, FAQs, and other server information. Additionally the knowledge base may contain information about the bot itself beyond what is offered by the system prompt. Use this when the user asks what's allowed, or other questions about the server or bot. The query should be in the form of a question.",
    inputSchema: z.object({
      query: z
        .string()
        .describe('The specific topic, question, or keywords to look up.'),
    }),

    async execute({query}) {
      const ragQuery = getEmbeddingQuery(query);
      const queryEmbedding = await ai.getEmbedding(ragQuery);

      const result = db.queryRag(queryEmbedding, BigInt(member.guild.id), 10);

      if (!result.length) {
        return "No relevant information was found for this query. Answer using general knowledge, or tell the user you don't have specific info on this.";
      }

      const results = result.map(r => ({
        category: r.category,
        distance: r.distance.toFixed(4),
        content: r.content,
      }));

      return results;
    },
  }),
});
