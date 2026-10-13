import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createId } from '../src/domain/id.ts'

test('creates UUID-shaped identifiers without Web Crypto for insecure origins', () => {
  const first = createId(undefined)
  const second = createId(undefined)

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(first, second)
})

test('uses cryptographic random bytes when available', () => {
  const source = { getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    if (array instanceof Uint8Array) array.fill(0)
    return array
  } } as Crypto

  assert.equal(createId(source), '00000000-0000-4000-8000-000000000000')
})
