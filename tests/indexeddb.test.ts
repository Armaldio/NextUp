import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import type { AppData } from '../src/domain/model.ts'
import { IndexedDbDriver } from '../src/domain/storage.ts'

const originalData: AppData = {
  schemaVersion: 1,
  lists: [{ id: 'list-1', title: 'Read', mode: 'status', sortOrder: 0 }],
  statuses: [{ id: 'status-1', listId: 'list-1', title: 'Next', order: 0 }],
  items: [{ id: 'item-1', listId: 'list-1', title: 'Book', notes: '', imageId: 'image-1', statusId: 'status-1', position: 2 }],
}

test('opens, writes, closes, and reopens a persisted snapshot and Blob image', async () => {
  const factory = new IDBFactory()
  const image = new Blob(['image content'], { type: 'image/png' })

  await new IndexedDbDriver(factory).writeData(originalData, new Map([['image-1', image]]))

  const reopenedDriver = new IndexedDbDriver(factory)
  assert.deepEqual(await reopenedDriver.readSnapshot(), originalData)
  const reopenedImage = await reopenedDriver.readImage('image-1')
  assert.equal(reopenedImage?.type, 'image/png')
  assert.equal(await reopenedImage?.text(), 'image content')
})

test('keeps existing Blob images when later saves omit them', async () => {
  const factory = new IDBFactory()
  const driver = new IndexedDbDriver(factory)
  const image = new Blob(['retained image'], { type: 'image/jpeg' })
  const nextData: AppData = { ...originalData, items: [{ ...originalData.items[0], title: 'Updated title' }] }

  await driver.writeData(originalData, new Map([['image-1', image]]))
  await driver.writeData(nextData, new Map())

  assert.deepEqual(await new IndexedDbDriver(factory).readSnapshot(), nextData)
  assert.equal(await (await driver.readImage('image-1'))?.text(), 'retained image')
})

test('aborts a failed readwrite transaction without changing the previous snapshot or images', async () => {
  const factory = new IDBFactory()
  const driver = new IndexedDbDriver(factory)
  const image = new Blob(['prior image'], { type: 'image/png' })
  await driver.writeData(originalData, new Map([['image-1', image]]))

  const invalidKey = {} as unknown as string
  const invalidImages = new Map([[invalidKey, new Blob(['invalid write'])]])
  const attemptedData: AppData = { ...originalData, items: [{ ...originalData.items[0], title: 'Must not persist' }] }

  await assert.rejects(() => driver.writeData(attemptedData, invalidImages))

  const reopenedDriver = new IndexedDbDriver(factory)
  assert.deepEqual(await reopenedDriver.readSnapshot(), originalData)
  assert.equal(await (await reopenedDriver.readImage('image-1'))?.text(), 'prior image')
})
