import { describe, expect, it } from 'vitest'
import { buildResolutionEvidence } from '../../../src/main/agent/resolutionEvidence'

describe('resolution evidence', () => {
  it('includes a fix made outside the finding file', () => {
    const evidence = buildResolutionEvidence(
      [
        {
          path: 'src/main/mcp/adoClient.ts',
          before: 'const connections = new Map()\n',
          after: 'const connections = new Map<string, ConnectionState>()\n'
        },
        {
          path: '/src/main/ipc.ts',
          before: 'secrets.setAdoPat(profileId, pat)\nreturn ok(settings)\n',
          after:
            'secrets.setAdoPat(profileId, pat)\nawait disconnectAdoClients()\nreturn ok(settings)\n'
        }
      ],
      '/src/main/mcp/adoClient.ts'
    )

    expect(evidence.indexOf('adoClient.ts')).toBeLessThan(evidence.indexOf('ipc.ts'))
    expect(evidence).toContain('await disconnectAdoClients()')
  })
})
