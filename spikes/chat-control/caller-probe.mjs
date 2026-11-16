// Read-only CC-00 probe. No caller IDs are accepted as tool arguments.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';

export function summarizeMetadata(meta) {
  const keys = [], correlation = {};
  const visit = (value, prefix = '', depth = 0) => {
    if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      // Credential fields and their subtrees do not even expose their key names.
      if (/token|secret|auth|password|cookie/i.test(key)) continue;
      const name = prefix ? `${prefix}.${key}` : key;
      keys.push(name.slice(0, 160));
      if (/(?:^|[/_.-])(?:thread|turn)[_-]?id$/i.test(name) && typeof item === 'string'
          && /^[a-zA-Z0-9_-]{1,100}$/.test(item)) correlation[name] = item;
      else visit(item, name, depth + 1);
    }
  };
  visit(meta);
  return { keys: keys.sort(), correlation, identityVerified: false,
    note: 'Observed transport metadata only; compare with relay IDs. Never grants a role.' };
}
export async function main() {
  const server = new McpServer({ name: 'cc00-caller-probe', version: '0.0.0' });
  server.registerTool('observe_caller', {
    description: 'Read-only CC-00 test: metadata key paths and thread/turn correlation IDs only.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (_args, extra) => {
    const result = summarizeMetadata(extra._meta);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
