// CC-00R only: private transport correlation, never caller-supplied identity.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { summarizeMetadata } from './caller-probe.mjs';

const target=path.resolve(process.argv[2]??'');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
assert(target.startsWith(path.join(repo,'.local/chat-control/CC-00R')+path.sep),'dedicated private evidence required');
const server=new McpServer({name:'cc00r-caller',version:'0.0.0'});
server.registerTool('observe_caller',{description:'Read-only CC-00R transport metadata correlation probe.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async(_args,extra)=>{
  const result=summarizeMetadata(extra._meta);
  appendFileSync(target,JSON.stringify({...result,process:{pid:process.pid,parentPid:process.ppid}})+'\n');
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
});
await server.connect(new StdioServerTransport());
