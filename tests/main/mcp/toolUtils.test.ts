import { describe, expect, it } from 'vitest'
import {
  buildArgs,
  parseJsonFromText,
  type McpTool
} from '../../../src/main/mcp/toolUtils'

function makeTool(properties?: Record<string, unknown>): McpTool {
  return {
    name: 'example',
    description: 'Example tool',
    inputSchema: { type: 'object', properties }
  }
}

describe('buildArgs', () => {
  it('includes values declared by the tool schema', () => {
    const tool = makeTool({ project: {}, repository: {} })

    expect(buildArgs(tool, { project: 'Bots', repository: 'App' })).toEqual({
      project: 'Bots',
      repository: 'App'
    })
  })

  it('omits values not declared by the tool schema', () => {
    const tool = makeTool({ project: {} })

    expect(buildArgs(tool, { project: 'Bots', unsupported: 'value' })).toEqual({
      project: 'Bots'
    })
  })

  it('omits null and undefined values', () => {
    const tool = makeTool({ project: {}, repository: {}, branch: {} })

    expect(buildArgs(tool, { project: 'Bots', repository: null, branch: undefined })).toEqual({
      project: 'Bots'
    })
  })

  it.each([
    ['false', false],
    ['zero', 0],
    ['an empty string', '']
  ])('preserves %s', (_label, value) => {
    expect(buildArgs(makeTool({ value: {} }), { value })).toEqual({ value })
  })

  it('preserves structured values', () => {
    const value = { ids: [1, 2], options: { active: true } }

    expect(buildArgs(makeTool({ value: {} }), { value })).toEqual({ value })
  })

  it('returns an empty object when the schema has no properties', () => {
    expect(buildArgs(makeTool(), { project: 'Bots' })).toEqual({})
  })

  it('does not accept inherited property names', () => {
    const properties = Object.create({ inherited: {} }) as Record<string, unknown>

    expect(buildArgs(makeTool(properties), { inherited: 'value' })).toEqual({})
  })
})

describe('parseJsonFromText', () => {
  it.each([
    ['an object', '{"name":"BotSpector"}', { name: 'BotSpector' }],
    ['an array', '[1,2,3]', [1, 2, 3]],
    ['a string', '"ready"', 'ready'],
    ['a number', '42', 42],
    ['a boolean', 'true', true],
    ['null', 'null', null]
  ])('parses exact JSON containing %s', (_label, text, expected) => {
    expect(parseJsonFromText(text)).toEqual(expected)
  })

  it('ignores surrounding whitespace', () => {
    expect(parseJsonFromText('\n  {"ok":true}  \t')).toEqual({ ok: true })
  })

  it('extracts an object from surrounding prose', () => {
    expect(parseJsonFromText('Tool result: {"ok":true,"count":2} Complete.')).toEqual({
      ok: true,
      count: 2
    })
  })

  it('extracts an array from a Markdown fence', () => {
    expect(parseJsonFromText('Result:\n```json\n[{"id":1},{"id":2}]\n```')).toEqual([
      { id: 1 },
      { id: 2 }
    ])
  })

  it('handles nested arrays and objects', () => {
    const text = 'Result: {"items":[{"id":1,"tags":["a","b"]}]}'

    expect(parseJsonFromText(text)).toEqual({
      items: [{ id: 1, tags: ['a', 'b'] }]
    })
  })

  it('ignores braces and brackets inside JSON strings', () => {
    const text = 'Result: {"template":"Use {name} and [items]","ok":true} trailing'

    expect(parseJsonFromText(text)).toEqual({
      template: 'Use {name} and [items]',
      ok: true
    })
  })

  it('skips a malformed container before valid JSON', () => {
    expect(parseJsonFromText('Template: {name}; result: {"ok":true}')).toEqual({ ok: true })
  })

  it('returns the first valid JSON container', () => {
    expect(parseJsonFromText('{"first":1}\n{"second":2}')).toEqual({ first: 1 })
  })

  it.each(['', 'plain text', '{"broken":', '[1,2', '{invalid}']) (
    'returns null when no valid JSON can be extracted from %j',
    (text) => {
      expect(parseJsonFromText(text)).toBeNull()
    }
  )
})