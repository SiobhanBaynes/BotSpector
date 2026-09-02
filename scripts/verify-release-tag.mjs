import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const sourceRef = process.env.BUILD_SOURCEBRANCH ?? process.argv[2]

if (!sourceRef) {
  throw new Error('Set BUILD_SOURCEBRANCH or pass a release tag as the first argument.')
}

const tag = sourceRef.replace(/^refs\/tags\//, '')
const expectedTag = `v${packageJson.version}`

if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`)
}

console.log(`Release tag ${tag} matches package version ${packageJson.version}.`)
