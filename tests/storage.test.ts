import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppData } from '../src/domain/model.ts'
import { IndexedDbDriver, LocalDataRepository, StorageError, type LocalDataDriver } from '../src/domain/storage.ts'
import { InvalidDataError, validateAppData } from '../src/domain/validation.ts'

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
  writeCount = 0

  async readSnapshot(): Promise<unknown | undefined> {
    this.checkAvailable()
    return this.snapshot
  }

  async writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>): Promise<void> {
    this.checkAvailable()
    this.writeCount += 1
    this.snapshot = structuredClone(snapshot)
    this.images = new Map([...this.images, ...images])
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
  const invalidCases: { snapshot: unknown; expectedMessage: RegExp }[] = [
    { snapshot: { schemaVersion: 1, lists: 'not an array', statuses: [], items: [] }, expectedMessage: /must be arrays/i },
    { snapshot: { ...sampleData, items: [{ ...sampleData.items[0], listId: 'missing-list' }] }, expectedMessage: /missing list/i },
    { snapshot: { ...sampleData, items: [{ ...sampleData.items[0], statusId: 'missing-status' }] }, expectedMessage: /invalid status/i },
    { snapshot: { ...sampleData, items: [{ ...sampleData.items[0], imageId: 'missing-image' }] }, expectedMessage: /image missing-image is missing/i },
    { snapshot: { ...sampleData, statuses: [{ ...sampleData.statuses[0], listId: 'missing-list' }] }, expectedMessage: /status .* missing list/i },
    { snapshot: { ...sampleData, items: [{ ...sampleData.items[0], date: { kind: 'date-only', value: '2026-02-30' } }] }, expectedMessage: /date is invalid/i },
    { snapshot: { ...sampleData, statuses: [...sampleData.statuses, { ...sampleData.statuses[0], id: 'list-1' }] }, expectedMessage: /duplicate id/i },
    { snapshot: { ...sampleData, statuses: [...sampleData.statuses, { ...sampleData.statuses[1], id: 'status-3', order: 0 }] }, expectedMessage: /duplicate status order/i },
    { snapshot: { ...sampleData, items: [...sampleData.items, { ...sampleData.items[0], id: 'item-2' }] }, expectedMessage: /duplicate item position/i },
  ]

  for (const { snapshot, expectedMessage } of invalidCases) {
    await t.test(`rejects snapshot: ${expectedMessage}`, async () => {
      const driver = new MemoryDriver()
      driver.snapshot = structuredClone(snapshot)
      driver.images.set('image-1', new Blob(['existing image'], { type: 'image/png' }))
      const before = structuredClone(driver.snapshot)
      await assert.rejects(
        () => new LocalDataRepository(driver).load(),
        (error: unknown) => error instanceof StorageError
          && error.cause instanceof InvalidDataError
          && expectedMessage.test(error.cause.message),
      )
      assert.deepEqual(driver.snapshot, before)
      assert.equal(driver.writeCount, 0)
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

test('migrates a complete v0 snapshot without changing model fields or image data', async () => {
  const driver = new MemoryDriver()
  const original = { ...sampleData, schemaVersion: 0 }
  const image = new Blob(['old image'], { type: 'image/png' })
  driver.snapshot = structuredClone(original)
  driver.images.set('image-1', image)

  assert.deepEqual(await new LocalDataRepository(driver).load(), sampleData)
  assert.deepEqual(driver.snapshot, sampleData)
  assert.equal(await driver.images.get('image-1')?.text(), 'old image')
  assert.equal(driver.writeCount, 1)
})

test('rejects ambiguous or invalid v0 data without persisting a migration', async (t) => {
  const ambiguous = structuredClone({ ...sampleData, schemaVersion: 0 }) as Record<string, unknown>
  ambiguous.lists = [{ id: 'list-1', title: 'Missing historical mode' }]
  const missingImage = structuredClone({ ...sampleData, schemaVersion: 0 })
  const unknownShape = { ...sampleData, schemaVersion: 0, legacyPayload: { content: 'unrecognized' } }
  const cases = [
    { value: ambiguous, expectedMessage: /ambiguous or unsupported shape/i },
    { value: missingImage, expectedMessage: /image image-1 is missing/i },
    { value: unknownShape, expectedMessage: /ambiguous or unsupported shape/i },
  ]

  for (const { value, expectedMessage } of cases) {
    await t.test(`does not write: ${expectedMessage}`, async () => {
      const driver = new MemoryDriver()
      driver.snapshot = structuredClone(value)
      const before = structuredClone(driver.snapshot)
      await assert.rejects(
        () => new LocalDataRepository(driver).load(),
        (error: unknown) => error instanceof StorageError
          && error.cause instanceof InvalidDataError
          && expectedMessage.test(error.cause.message),
      )
      assert.deepEqual(driver.snapshot, before)
      assert.equal(driver.writeCount, 0)
    })
  }
})

test('reports storage unavailability as a recoverable error', async () => {
  const driver = new MemoryDriver()
  driver.unavailable = true

  await assert.rejects(() => new LocalDataRepository(driver).load(), StorageError)
})

test('reports a browser without IndexedDB as a recoverable storage error', async () => {
  await assert.rejects(() => new LocalDataRepository(new IndexedDbDriver()).load(), StorageError)
})
