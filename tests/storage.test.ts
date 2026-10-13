import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppData } from '../src/domain/model.ts'
import { IndexedDbDriver, LocalDataRepository, StorageError, type LocalDataDriver } from '../src/domain/storage.ts'
import { InvalidDataError, validateAppData } from '../src/domain/validation.ts'

const sampleData: AppData = {
  schemaVersion: 3,
  lists: [{ id: 'list-1', title: 'Reading', mode: 'status', sortOrder: 0, icon: null }],
  statuses: [
    { id: 'status-1', listId: 'list-1', title: 'To read', order: 0 },
    { id: 'status-2', listId: 'list-1', title: 'Done', order: 1 },
  ],
  items: [{
    id: 'item-1',
    listId: 'list-1',
    title: 'The Left Hand of Darkness',
    notes: 'Keep this note',
    imageId: 'image-1', externalUrl: null,
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

  async writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>, deleteImageIds: ReadonlySet<string> = new Set()): Promise<void> {
    this.checkAvailable()
    this.writeCount += 1
    this.snapshot = structuredClone(snapshot)
    this.images = new Map([...this.images, ...images])
    for (const id of deleteImageIds) if (!images.has(id)) this.images.delete(id)
  }

  async deleteList(snapshot: AppData, imageIdsToDelete: ReadonlySet<string>): Promise<void> {
    this.writeCount += 1
    this.snapshot = structuredClone(snapshot)
    for (const id of imageIdsToDelete) this.images.delete(id)
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
    schemaVersion: 3,
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

test('supports per-list stage CRUD and persists arbitrary stage ordering', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  await repository.save(sampleData, new Map([['image-1', new Blob(['image'])]]))

  await repository.addStatus({ id: 'status-3', listId: 'list-1', title: 'Reading now', order: 99 })
  await repository.addStatus({ id: 'status-4', listId: 'list-1', title: 'On hold', order: 99 })
  await repository.renameStatus('status-3', 'In progress')
  await repository.reorderStatus('status-4', 0)

  const loaded = await repository.load()
  assert.deepEqual(loaded.statuses.filter((status) => status.listId === 'list-1').sort((a, b) => a.order - b.order).map(({ id, title, order }) => ({ id, title, order })), [
    { id: 'status-4', title: 'On hold', order: 0 },
    { id: 'status-1', title: 'To read', order: 1 },
    { id: 'status-2', title: 'Done', order: 2 },
    { id: 'status-3', title: 'In progress', order: 3 },
  ])
  assert.deepEqual(loaded.items, sampleData.items)
})

test('stage removal requires reassignment and preserves every item field and position', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  await repository.save(sampleData, new Map([['image-1', new Blob(['image'])]]))
  const before = await repository.load()

  await repository.deleteStatus('status-1', null)
  assert.deepEqual(await repository.load(), before)
  await repository.deleteStatus('status-1', 'status-2')

  const loaded = await repository.load()
  assert.deepEqual(loaded.items, [{ ...sampleData.items[0], statusId: 'status-2' }])
  assert.deepEqual(loaded.statuses, [{ ...sampleData.statuses[1], order: 0 }])
  assert.equal(await driver.images.get('image-1')?.text(), 'image')
  await assert.rejects(() => repository.deleteStatus('status-2', null), /keep at least one stage/i)
  assert.deepEqual(await repository.load(), loaded)
})

test('removes an empty stage without requiring a destination', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  await repository.save(sampleData, new Map([['image-1', new Blob(['image'])]]))

  await repository.deleteStatus('status-2', null)

  const loaded = await repository.load()
  assert.deepEqual(loaded.statuses, [sampleData.statuses[0]])
  assert.deepEqual(loaded.items, sampleData.items)
})

test('date lists cannot gain stages through the repository helpers', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  const dateList: AppData = { schemaVersion: 3, lists: [{ id: 'calendar', title: 'Calendar', mode: 'date', sortOrder: 0, icon: null }], statuses: [], items: [] }
  await repository.save(dateList)
  await assert.rejects(() => repository.addStatus({ id: 'stage', listId: 'calendar', title: 'Stage', order: 0 }), /only manual lists/i)
  assert.deepEqual(await repository.load(), dateList)
})

test('rejects malformed snapshots and broken list, status, and image references', async (t) => {
  const invalidCases: { snapshot: unknown; expectedMessage: RegExp }[] = [
    { snapshot: { schemaVersion: 3, lists: 'not an array', statuses: [], items: [] }, expectedMessage: /must be arrays/i },
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
    schemaVersion: 3,
    lists: [{ id: 'calendar', title: 'Calendar', mode: 'date', sortOrder: 0, icon: null }],
    statuses: [],
    items: [{ id: 'event', listId: 'calendar', title: 'Appointment', notes: '', imageId: null, externalUrl: null, date: { kind: 'local-date-time', value: '2026-10-13T09:30' }, statusId: null, position: 0 }],
  }
  const driver = new MemoryDriver()

  await new LocalDataRepository(driver).save(dateList)

  assert.deepEqual(await new LocalDataRepository(driver).load(), dateList)
})

test('accepts external HTTP links and rejects unsafe protocols', () => {
  assert.doesNotThrow(() => validateAppData({ ...sampleData, items: [{ ...sampleData.items[0], externalUrl: 'https://example.com/path' }] }))
  assert.throws(() => validateAppData({ ...sampleData, items: [{ ...sampleData.items[0], externalUrl: 'javascript:alert(1)' }] }), /HTTP or HTTPS/i)
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
  const original = { ...sampleData, schemaVersion: 0, lists: sampleData.lists.map(({ icon: _icon, ...list }) => list), items: sampleData.items.map(({ externalUrl: _url, ...item }) => item) }
  const image = new Blob(['old image'], { type: 'image/png' })
  driver.snapshot = structuredClone(original)
  driver.images.set('image-1', image)

  assert.deepEqual(await new LocalDataRepository(driver).load(), sampleData)
  assert.deepEqual(driver.snapshot, sampleData)
  assert.equal(await driver.images.get('image-1')?.text(), 'old image')
  assert.equal(driver.writeCount, 1)
})

test('rejects ambiguous or invalid v0 data without persisting a migration', async (t) => {
  const ambiguous = structuredClone({ ...sampleData, schemaVersion: 0, lists: sampleData.lists.map(({ icon: _icon, ...list }) => list), items: sampleData.items.map(({ externalUrl: _url, ...item }) => item) }) as Record<string, unknown>
  ambiguous.lists = [{ id: 'list-1', title: 'Missing historical mode' }]
  const missingImage = structuredClone({ ...sampleData, schemaVersion: 0, lists: sampleData.lists.map(({ icon: _icon, ...list }) => list), items: sampleData.items.map(({ externalUrl: _url, ...item }) => item) })
  const unknownShape = { ...missingImage, legacyPayload: { content: 'unrecognized' } }
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

test('creates, updates, and deletes items without moving them when their date changes', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  await repository.save(sampleData, new Map([['image-1', new Blob(['image'])]]))
  const created = { ...sampleData.items[0], id: 'item-2', title: 'Second item', imageId: null, externalUrl: 'https://example.com', date: { kind: 'local-date-time' as const, value: '2026-10-14T12:30' }, position: 5 }
  await repository.saveItem(created)
  const edited = { ...created, date: { kind: 'date-only' as const, value: '2026-10-15' } }
  await repository.saveItem(edited)
  const reloaded = await repository.load()
  assert.equal(reloaded.items.find((item) => item.id === created.id)?.position, 5)
  assert.deepEqual(reloaded.items.find((item) => item.id === created.id)?.date, edited.date)
  assert.equal(reloaded.items.find((item) => item.id === created.id)?.externalUrl, 'https://example.com')
  await repository.deleteItem('item-1')
  assert.equal(driver.images.has('image-1'), false)
})

test('rejects an item image reference without a new or persisted Blob before writing', async () => {
  const driver = new MemoryDriver()
  driver.snapshot = structuredClone(sampleData)
  driver.images.set('image-1', new Blob(['existing image']))
  const before = structuredClone(driver.snapshot)
  const repository = new LocalDataRepository(driver)
  const item = { ...sampleData.items[0], id: 'item-with-missing-image', imageId: 'missing-image' }

  await assert.rejects(() => repository.saveItem(item), /image missing-image is missing/i)
  assert.deepEqual(driver.snapshot, before)
  assert.equal(driver.writeCount, 0)
})

test('migrates v1 lists losslessly and adds empty icon fields', async () => {
  const driver = new MemoryDriver()
  const old = structuredClone(sampleData) as Record<string, any>
  old.schemaVersion = 1
  delete old.items[0].externalUrl
  delete old.lists[0].icon
  driver.snapshot = old
  driver.images.set('image-1', new Blob(['kept image'], { type: 'image/png' }))
  const loaded = await new LocalDataRepository(driver).load()
  assert.equal(loaded.schemaVersion, 3)
  assert.deepEqual(loaded.lists[0], { ...sampleData.lists[0], icon: null })
  assert.deepEqual(loaded.statuses, sampleData.statuses)
  assert.deepEqual(loaded.items, sampleData.items)
  assert.equal(await driver.images.get('image-1')?.text(), 'kept image')
})

test('migrates v2 items with no external link without losing existing fields', async () => {
  const driver = new MemoryDriver()
  const old = structuredClone(sampleData) as Record<string, any>
  old.schemaVersion = 2
  delete old.items[0].externalUrl
  driver.snapshot = old
  driver.images.set('image-1', new Blob(['preserved']))
  const loaded = await new LocalDataRepository(driver).load()
  assert.equal(loaded.schemaVersion, 3)
  assert.equal(loaded.items[0].externalUrl, null)
  assert.equal(loaded.items[0].date?.kind, 'date-only')
  assert.equal(await driver.images.get('image-1')?.text(), 'preserved')
})

test('deletes list data and only image blobs that are no longer referenced', async () => {
  const driver = new MemoryDriver()
  const repository = new LocalDataRepository(driver)
  const shared = { id: 'shared-list', title: 'Shared', mode: 'date' as const, sortOrder: 1, icon: null }
  driver.snapshot = { ...sampleData, lists: [...sampleData.lists, shared], items: [...sampleData.items, { ...sampleData.items[0], id: 'other-item', listId: shared.id, statusId: null, position: 17 }] }
  driver.images.set('image-1', new Blob(['shared image']))
  await repository.deleteList('list-1')
  assert.deepEqual(driver.snapshot, { schemaVersion: 3, lists: [{ ...shared, sortOrder: 0 }], statuses: [], items: [{ ...sampleData.items[0], id: 'other-item', listId: shared.id, statusId: null, position: 17 }] })
  assert.equal(await driver.images.get('image-1')?.text(), 'shared image')
})
