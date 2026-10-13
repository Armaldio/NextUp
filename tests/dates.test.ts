import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAppData } from '../src/domain/validation.ts'

const emptyModel = {
  schemaVersion: 1,
  lists: [{ id: 'dates', title: 'Dates', mode: 'date', sortOrder: 0 }],
  statuses: [],
  items: [],
}

function validateDate(value: string): void {
  validateAppData({
    ...emptyModel,
    items: [{ id: 'date-item', listId: 'dates', title: 'Date', notes: '', imageId: null, date: { kind: 'date-only', value }, statusId: null, position: 0 }],
  })
}

test('validates date-only values using Gregorian components, independent of local time zones', () => {
  for (const value of ['0001-01-01', '0000-02-29', '0096-02-29', '2000-02-29', '2011-12-30']) {
    assert.doesNotThrow(() => validateDate(value), value)
  }
})

test('rejects impossible dates and non-leap century dates', () => {
  for (const value of ['0001-02-29', '0099-02-29', '1900-02-29', '2026-02-29', '2026-04-31']) {
    assert.throws(() => validateDate(value), /date is invalid/i, value)
  }
})
