import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: 'qa-probe', version: '1.0.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  await client.connect(transport)
  return client
}

describe('qa discover daemon tools', () => {
  it('lists tools + sample search on twoplus @8765', async () => {
    const client = await connect(8765)
    const { tools } = await client.listTools()
    const searchTool = tools.find(t => /search/i.test(t.name))
    let searchResult = null as any
    if (searchTool !== undefined) {
      const res = await client.callTool({ name: searchTool.name, arguments: { query: 'twoplus server' } } as never)
      searchResult = (res.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('')
    }
    await client.close()
    writeFileSync('/tmp/qa-discover-result.json', JSON.stringify({
      toolNames: tools.map(t => t.name),
      searchTool: searchTool?.name ?? null,
      searchSchema: searchTool?.inputSchema ?? null,
      searchResultSample: searchResult ? searchResult.slice(0, 2000) : null,
    }, null, 2))
  }, 30_000)
})
