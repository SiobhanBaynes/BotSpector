export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

/** Include only non-null values explicitly declared by a tool's input schema. */
export function buildArgs(
  tool: McpTool,
  values: Record<string, unknown>
): Record<string, unknown> {
  const properties = tool.inputSchema.properties ?? {}
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && Object.hasOwn(properties, key)) {
      args[key] = value
    }
  }
  return args
}

function parseContainerAt(text: string, start: number): unknown {
  const expectedClosers: string[] = []
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      expectedClosers.push('}')
    } else if (character === '[') {
      expectedClosers.push(']')
    } else if (character === '}' || character === ']') {
      if (expectedClosers.pop() !== character) return null
      if (expectedClosers.length === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }

  return null
}

/** Extract a JSON value from a tool's text output, tolerating surrounding prose. */
export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Tool output sometimes wraps JSON in prose or a Markdown fence.
  }

  for (let index = 0; index < trimmed.length; index++) {
    if (trimmed[index] !== '{' && trimmed[index] !== '[') continue
    const parsed = parseContainerAt(trimmed, index)
    if (parsed !== null) return parsed
  }
  return null
}