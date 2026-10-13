import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRoute } from '../src/router.ts'

test('matches the home, list detail, and item detail routes', () => {
  assert.deepEqual(parseRoute('/'), { name: 'home' })
  assert.deepEqual(parseRoute('/lists/list-17'), { name: 'list-detail', listId: 'list-17' })
  assert.deepEqual(parseRoute('/lists/list-17/items/item-42'), {
    name: 'item-detail',
    listId: 'list-17',
    itemId: 'item-42',
  })
})

test('sends malformed and unknown paths to the not-found placeholder', () => {
  assert.deepEqual(parseRoute('/lists'), { name: 'not-found' })
  assert.deepEqual(parseRoute('/lists/list/items'), { name: 'not-found' })
  assert.deepEqual(parseRoute('/lists/%E0%A4%A'), { name: 'not-found' })
})
