import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { protocolContract } from '../src/contract'

it('matches the committed protocol contract', () => {
  const committed = JSON.parse(readFileSync(new URL('../contract/protocol.json', import.meta.url), 'utf8'))
  expect(protocolContract()).toEqual(committed)
})
