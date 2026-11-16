import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pipeRequest } from '../../src/protocol.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = new Client({ name: 'owned-native-fixture', version: '0' }, config.humanAction ? { capabilities: { elicitation: { form: {} } } } : undefined);
if (config.humanAction) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: config.humanAction, content: {} }));
try {
  if (config.direct) {
    writeFileSync(config.output, JSON.stringify(await pipeRequest(config.pipeName, config.direct)));
    process.exit(0);
  }
  await client.connect(config.bridged ? new StdioServerTransport() : new StdioClientTransport({ command: process.execPath, args: [config.entryPoint, '--pipe', config.pipeName], stderr: 'pipe' }));
  const result = await client.callTool({ name: config.name, arguments: config.args, _meta: config.metadata });
  writeFileSync(config.output, JSON.stringify(result));
} finally { await client.close(); }
