// Writes contract/protocol.json, the JSON Schema form of the wire protocol.
// Ace keeps an independent copy of the protocol and checks it against this file,
// so any change here must be released together with the matching Ace change.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { protocolContract } from '../src/contract'

const path = join(__dirname, '..', 'contract', 'protocol.json')
const expected = JSON.stringify(protocolContract(), null, 2) + '\n'
async function main() {
  if (process.argv.includes('--check')) {
    const actual = await readFile(path, 'utf8').catch(() => '')
    if (actual !== expected) {
      process.stderr.write('contract/protocol.json is out of date. Run `npm run contract` and review the change.\n')
      process.exit(1)
    }
  } else {
    await writeFile(path, expected)
  }
}
void main()
