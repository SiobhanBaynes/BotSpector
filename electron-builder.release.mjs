import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

const { build } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default {
  ...build,
  mac: {
    ...build.mac,
    hardenedRuntime: true,
    notarize: true
  }
}
