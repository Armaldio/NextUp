import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppData } from '../src/domain/model.ts'
import { IndexedDbDriver, LocalDataRepository, StorageError, type LocalDataDriver } from '../src/domain/storage.ts'
import { validateAppData } from '../src/domain/validation.ts'

const sampleData: AppData = {
  schemaVersion: 1,
  lists: [{ id: 'list-1', title: 'Reading', mode: 'status', sortOrder: 0 }],
  statuses: [
    { id: 'status-1', listId: 'list-1', title: 'To read', order: 0 },
    { id: 'status-2', listId: 'list-1', title: 'Done', order: 1 },
  ],
  items: [{
    id: 'item-1',
    listId: 'list-1',
    title: 'The Left Hand of Darkness',
    notes: 'Keep this note',
    imageId: 'image-1',
    date: { kind: 'date-only', value: '2026-10-13' },
    statusId: 'status-1',
    position: 4,
  }],
}

class MemoryDriver implements LocalDataDriver {
  snapshot: unknown | undefined
  images = new Map<string, Blob>()
  unavailable = false

  async readSnapshot(): Promise<unknown | undefined> {
    this.checkAvailable()
    return this.snapshot
  }

  async writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>): Promise<void> {
    this.checkAvailable()
    this.snapshot = structuredClone(snapshot)
    this.images = new Map(images)
  }

  async readImage(id: string): Promise<Blob | undefined> {
    this.checkAvailable()
    return this.images.get(id)
  }

  private checkAvailable(): void {
    if (this.unavailable) throw new Error('Storage disabled')
  }
}

test('loads an empty, versioned model when no data has been saved', async () => {
  const repository = new LocalDataRepository(new MemoryDriver())

  assert.deepEqual(await repository.load(), {
    schemaVersion: 1,
    lists: [],
    statuses: [],
    items: [],
  })
})

test('persists ordered statuses, item positions, date values, and durable image blobs', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  const image = new Blob(['image bytes'], { type: 'image/png' })

  await repository.save(sampleData, new Map([['image-1', image]]))
  const reloadedRepository = new LocalDataRepository(driver)

  assert.deepEqual(await reloadedRepository.load(), sampleData)
  assert.equal(await (await reloadedRepository.getImage('image-1'))?.text(), 'image bytes')
})

test('rejects malformed snapshots and broken list, status, and image references', async (t) => {
  const invalidSnapshots: unknown[] = [
    { schemaVersion: 1, lists: 'not an array', statuses: [], items: [] },
    { ...sampleData, items: [{ ...sampleData.items[0], listId: 'missing-list' }] },
    { ...sampleData, items: [{ ...sampleData.items[0], statusId: 'missing-status' }] },
    { ...sampleData, items: [{ ...sampleData.items[0], imageId: 'missing-image' }] },
    { ...sampleData, statuses: [{ ...sampleData.statuses[0], listId: 'missing-list' }] },
    { ...sampleData, items: [{ ...sampleData.items[0], date: { kind: 'date-only', value: '2026-02-30' } }] },
    { ...sampleData, statuses: [...sampleData.statuses, { ...sampleData.statuses[0], id: 'list-1' }] },
    { ...sampleData, statuses: [...sampleData.statuses, { ...sampleData.statuses[1], id: 'status-3', order: 0 }] },
    { ...sampleData, items: [...sampleData.items, { ...sampleData.items[0], id: 'item-2' }] },
  ]

  for (const snapshot of invalidSnapshots) {
    await t.test('invalid snapshot is reported', async () => {
      const driver = new MemoryDriver()
      driver.snapshot = snapshot
      await assert.rejects(() => new LocalDataRepository(driver).load(), StorageError)
    })
  }
})

test('date lists keep statuses absent and accept items without a status', async () => {
  const dateList: AppData = {
    schemaVersion: 1,
    lists: [{ id: 'calendar', title: 'Calendar', mode: 'date', sortOrder: 0 }],
    statuses: [],
    items: [{ id: 'event', listId: 'calendar', title: 'Appointment', notes: '', imageId: null, date: { kind: 'local-date-time', value: '2026-10-13T09:30' }, statusId: null, position: 0 }],
  }
  const driver = new MemoryDriver()

  await new LocalDataRepository(driver).save(dateList)

  assert.deepEqual(await new LocalDataRepository(driver).load(), dateList)
})

test('rejects object URLs as persisted image references', () => {
  assert.throws(
    () => validateAppData({ ...sampleData, items: [{ ...sampleData.items[0], imageId: 'blob:https://app.invalid/temporary' }] }),
    /durable local reference/i,
  )
})

test('rejects an unsupported schema version without clearing stored data', async () => {
  const driver = new MemoryDriver()
  const original = { ...sampleData, schemaVersion: 99 }
  driver.snapshot = original

  await assert.rejects(() => new LocalDataRepository(driver).load(), /schema version/i)
  assert.deepEqual(driver.snapshot, original)
})

test('migrates the original unversioned model while preserving user content', async () => {
  const driver = new MemoryDriver()
  driver.snapshot = {
    schemaVersion: 0,
    lists: [{ id: 'old-list', title: 'Old list' }],
    statuses: [{ id: 'old-status', listId: 'old-list', title: 'Open' }],
    items: [{ id: 'old-item', listId: 'old-list', title: 'Old item', notes: 'Keep me', statusId: 'old-status' }],
  }

  assert.deepEqual(await new LocalDataRepository(driver).load(), {
    schemaVersion: 1,
    lists: [{ id: 'old-list', title: 'Old list', mode: 'status', sortOrder: 0 }],
    statuses: [{ id: 'old-status', listId: 'old-list', title: 'Open', order: 0 }],
    items: [{ id: 'old-item', listId: 'old-list', title: 'Old item', notes: 'Keep me', imageId: null, statusId: 'old-status', position: 0 }],
  })
  assert.equal((driver.snapshot as AppData).schemaVersion, 1)
})

test('reports storage unavailability as a recoverable error', async () => {
  const driver = new MemoryDriver()
  driver.unavailable = true

  await assert.rejects(() => new LocalDataRepository(driver).load(), StorageError)
})

test('reports a browser without IndexedDB as a recoverable storage error', async () => {
  await assert.rejects(() => new LocalDataRepository(new IndexedDbDriver()).load(), StorageError)
})
