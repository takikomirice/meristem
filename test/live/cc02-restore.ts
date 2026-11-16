// Remove only the MCP namespace introduced by this disposable test.
export function removeFixtureMcp(current: string, original: string): string {
  const ownedSection = /^\s*\[mcp_servers\.meristem(?:\.|\])/;
  if (original.split(/\r?\n/).some(line => ownedSection.test(line))) throw new Error('fixture did not own this MCP namespace');
  let owned = false;
  return current.split(/(?<=\n)/).filter(line => {
    if (/^\s*\[/.test(line)) owned = ownedSection.test(line);
    return !owned;
  }).join('');
}
