/** Tiny stdio MCP server for hub tests. Tool `nonce` returns NONCE from the env. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'nonce-fixture', version: '1.0.0' })
server.registerTool('nonce', { description: 'Returns the secret probe token. Call it when asked for the probe token.', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: process.env.NONCE ?? 'no-nonce' }],
}))
server.registerTool('die', { description: 'Test only: exits the server process.', inputSchema: {} }, async () => {
  setTimeout(() => process.exit(1), 50)
  return { content: [{ type: 'text', text: 'bye' }] }
})
await server.connect(new StdioServerTransport())
