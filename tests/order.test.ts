import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderItemsByDate, orderItemsForList } from '../src/domain/order.ts'
import type { Item, ItemDate } from '../src/domain/model.ts'

function item(id: string, position: number, date?: ItemDate): Item {
  return {
    id,
    listId: 'list',
    title: id,
    notes: '',
    imageId: null,
    externalUrl: null,
    ...(date === undefined ? {} : { date }),
    statusId: null,
    position,
  }
}

test('orders date-only before local date-time on the same day', () => {
  const items = [
    item('late', 0, { kind: 'local-date-time', value: '2026-04-03T18:00' }),
    item('date', 1, { kind: 'date-only', value: '2026-04-03' }),
    item('early', 2, { kind: 'local-date-time', value: '2026-04-03T09:00' }),
  ]

  assert.deepEqual(orderItemsByDate(items).map(({ id }) => id), ['date', 'early', 'late'])
})

test('uses explicit position for exact date ties and input order for duplicate positions', () => {
  const tied = { kind: 'date-only', value: '2026-04-03' } as const
  const items = [item('position-2-first', 2, tied), item('position-1', 1, tied), item('position-2-second', 2, tied)]

  assert.deepEqual(orderItemsByDate(items).map(({ id }) => id), ['position-1', 'position-2-first', 'position-2-second'])
})

test('orders past dates before future dates', () => {
  const items = [
    item('future', 0, { kind: 'date-only', value: '2030-01-01' }),
    item('past', 1, { kind: 'date-only', value: '2020-01-01' }),
    item('present', 2, { kind: 'date-only', value: '2026-01-01' }),
  ]

  assert.deepEqual(orderItemsByDate(items).map(({ id }) => id), ['past', 'present', 'future'])
})

test('puts undated items last and orders them by position', () => {
  const items = [item('undated-2', 2), item('dated', 3, { kind: 'date-only', value: '2026-01-01' }), item('undated-1', 1)]

  assert.deepEqual(orderItemsByDate(items).map(({ id }) => id), ['dated', 'undated-1', 'undated-2'])
})

test('applies chronological ordering only to date lists and preserves manual position ordering', () => {
  const items = [
    item('later', 0, { kind: 'date-only', value: '2026-04-03' }),
    item('earlier', 1, { kind: 'date-only', value: '2026-04-02' }),
    item('undated', 2),
  ]

  assert.deepEqual(orderItemsForList(items, 'date').map(({ id }) => id), ['earlier', 'later', 'undated'])
  assert.deepEqual(orderItemsForList(items, 'status').map(({ id }) => id), ['later', 'earlier', 'undated'])
  assert.deepEqual(items.map(({ id }) => id), ['later', 'earlier', 'undated'])
})

test('compares local date and time strings without timezone conversion and preserves item data', () => {
  const earlier = item('earlier', 0, { kind: 'local-date-time', value: '2026-03-08T01:30' })
  const later = item('later', 1, { kind: 'local-date-time', value: '2026-03-08T03:00' })
  const items = [later, earlier]
  const snapshot = structuredClone(items)

  const ordered = orderItemsByDate(items)

  assert.deepEqual(ordered.map(({ id }) => id), ['earlier', 'later'])
  assert.deepEqual(items, snapshot)
  assert.equal(ordered[0], earlier)
  assert.equal(ordered[1], later)
})
