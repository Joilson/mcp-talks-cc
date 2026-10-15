import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getEmbedder } from '../embeddings/localEmbedder.ts';
import { closeDriver } from '../neo4j/driver.ts';
import { registerSearchMemoryTool } from './tools/searchMemory.ts';
import { registerGetSessionTranscriptTool } from './tools/getSessionTranscript.ts';
import { registerFindRelatedPlansTool } from './tools/findRelatedPlans.ts';
import { registerFindDecisionsTool } from './tools/findDecisions.ts';
import { registerListProjectActivityTool } from './tools/listProjectActivity.ts';
import { registerFindSimilarChunksTool } from './tools/findSimilarChunks.ts';
import { registerExpandHitsTool } from './tools/expandHits.ts';
import { registerRecallTaskTool } from './tools/recallTask.ts';
import { registerRecallContextPrompt } from './prompts/recallContext.ts';
import { registerExtractDecisionPrompt } from './prompts/extractDecision.ts';
import { registerStatsResource } from './resources/stats.ts';
import { registerSchemaResource } from './resources/schema.ts';
import { registerProfileResource } from './resources/profile.ts';
import { startWarmSocket } from './warmSocket.ts';

const server = new McpServer({
  name: 'mcp-talks-cc',
  version: '0.3.1',
});

registerSearchMemoryTool(server);
registerGetSessionTranscriptTool(server);
registerFindRelatedPlansTool(server);
registerFindDecisionsTool(server);
registerListProjectActivityTool(server);
registerFindSimilarChunksTool(server);
registerExpandHitsTool(server);
registerRecallTaskTool(server);

registerRecallContextPrompt(server);
registerExtractDecisionPrompt(server);

registerStatsResource(server);
registerSchemaResource(server);
registerProfileResource(server);

await server.connect(new StdioServerTransport());
console.error('[mcp] mcp-talks-cc server connected (stdio)');

// Preload the embedder in the background so the first search isn't cold.
// Must NOT block server.connect above: the bge-m3 cold load is ~30-60s and
// would stall the MCP initialize handshake, making the client time out.
void getEmbedder().catch((e) => console.error('[mcp] embedder preload failed:', e));

// Socket local pros hooks de push (UserPromptSubmit/PostToolUse). Desligável
// com MCP_TALKS_DISABLE_PUSH=1 (a suite desliga).
if (process.env.MCP_TALKS_DISABLE_PUSH !== '1') startWarmSocket();

// Claude Code fecha o stdin quando a sessão acaba: sem isto o driver do Neo4j
// seguraria o processo vivo e o socket ficaria órfão.
process.stdin.on('close', async () => {
  await closeDriver().catch(() => {});
  process.exit(0);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await closeDriver();
    process.exit(0);
  });
}
