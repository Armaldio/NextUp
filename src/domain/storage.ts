import { CURRENT_SCHEMA_VERSION, emptyAppData, type AppData, type Item, type Status } from './model.ts'
import { InvalidDataError, validateAppData } from './validation.ts'

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}

export interface LocalDataDriver {
  readSnapshot(): Promise<unknown | undefined>
  writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>, deleteImageIds?: ReadonlySet<string>): Promise<void>
  readImage(id: string): Promise<Blob | undefined>
  deleteList?(snapshot: AppData, imageIdsToDelete: ReadonlySet<string>): Promise<void>
}

export class LocalDataRepository {
  private readonly driver: LocalDataDriver

  constructor(driver: LocalDataDriver) {
    this.driver = driver
  }

  async load(): Promise<AppData> {
    try {
      const raw = await this.driver.readSnapshot()
      if (raw === undefined) return emptyAppData()
      const data = validateAppData(migrateSnapshot(raw))
      for (const id of imageIds(data)) {
        if (!(await this.driver.readImage(id))) throw new InvalidDataError(`Item image ${id} is missing`)
      }
      if (isRecord(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion < CURRENT_SCHEMA_VERSION) await this.driver.writeData(data, new Map())
      return data
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(`Could not load saved data: ${errorMessage(error)}`, { cause: error })
    }
  }

  async save(data: AppData, images: ReadonlyMap<string, Blob> = new Map()): Promise<void> {
    try {
      const validated = validateAppData(data)
      for (const id of imageIds(validated)) {
        if (!images.has(id) && !(await this.driver.readImage(id))) {
          throw new InvalidDataError(`Item image ${id} is missing`)
        }
      }
      for (const [id, image] of images) {
        if (!id.trim() || !(image instanceof Blob)) throw new InvalidDataError('Image references must contain Blob data')
      }
      await this.driver.writeData(validated, images)
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(`Could not save data: ${errorMessage(error)}`, { cause: error })
    }
  }


  async saveItem(item: Item, image?: Blob): Promise<void> {
    try {
      const current = validateAppData(migrateSnapshot(await this.driver.readSnapshot() ?? emptyAppData()))
      const list = current.lists.find((entry) => entry.id === item.listId)
      if (!list) throw new InvalidDataError(`Item ${item.id} refers to a missing list`)
      const previous = current.items.find((entry) => entry.id === item.id)
      const prepared: Item = {
        ...item,
        position: previous?.position ?? Math.max(-1, ...current.items.filter((entry) => entry.listId === item.listId).map((entry) => entry.position)) + 1,
      }
      const next = validateAppData({ ...current, items: previous
        ? current.items.map((entry) => entry.id === item.id ? prepared : entry)
        : [...current.items, prepared] })
      if (image !== undefined && !(image instanceof Blob)) throw new InvalidDataError('Image references must contain Blob data')
      if (prepared.imageId && !image && !(await this.driver.readImage(prepared.imageId))) {
        throw new InvalidDataError(`Item image ${prepared.imageId} is missing`)
      }
      const images = new Map<string, Blob>()
      if (image && prepared.imageId) images.set(prepared.imageId, image)
      const deletedImages = new Set(current.items.flatMap((entry) => entry.imageId && !next.items.some((nextEntry) => nextEntry.imageId === entry.imageId) ? [entry.imageId] : []))
      await this.driver.writeData(next, images, deletedImages)
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(`Could not save item: ${errorMessage(error)}`, { cause: error })
    }
  }

  async addStatus(status: Status): Promise<void> {
    const current = await this.readCurrent('add stage')
    const list = current.lists.find((entry) => entry.id === status.listId)
    if (!list || list.mode !== 'status') throw new StorageError('Only manual lists can have stages')
    const ordered = current.statuses.filter((entry) => entry.listId === status.listId).sort((a, b) => a.order - b.order)
    const next = { ...current, statuses: [...current.statuses, { ...status, order: ordered.length }] }
    await this.writeCurrent(next, 'add stage')
  }

  async renameStatus(statusId: string, title: string): Promise<void> {
    const current = await this.readCurrent('rename stage')
    const status = current.statuses.find((entry) => entry.id === statusId)
    if (!status) throw new StorageError(`Stage ${statusId} was not found`)
    await this.writeCurrent({ ...current, statuses: current.statuses.map((entry) => entry.id === statusId ? { ...entry, title } : entry) }, 'rename stage')
  }

  async reorderStatus(statusId: string, targetIndex: number): Promise<void> {
    const current = await this.readCurrent('reorder stage')
    const status = current.statuses.find((entry) => entry.id === statusId)
    if (!status) throw new StorageError(`Stage ${statusId} was not found`)
    const ordered = current.statuses.filter((entry) => entry.listId === status.listId).sort((a, b) => a.order - b.order)
    const from = ordered.findIndex((entry) => entry.id === statusId)
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= ordered.length) throw new StorageError('Stage order is invalid')
    ordered.splice(from, 1)
    ordered.splice(targetIndex, 0, status)
    const orderById = new Map(ordered.map((entry, index) => [entry.id, index]))
    await this.writeCurrent({ ...current, statuses: current.statuses.map((entry) => entry.listId === status.listId ? { ...entry, order: orderById.get(entry.id)! } : entry) }, 'reorder stage')
  }

  async deleteStatus(statusId: string, destinationStatusId: string | null): Promise<void> {
    const current = await this.readCurrent('remove stage')
    const removed = current.statuses.find((entry) => entry.id === statusId)
    if (!removed) throw new StorageError(`Stage ${statusId} was not found`)
    const remaining = current.statuses.filter((entry) => entry.listId === removed.listId && entry.id !== statusId)
    if (remaining.length === 0) throw new StorageError('A manual list must keep at least one stage')
    const affected = current.items.filter((item) => item.statusId === statusId)
    if (affected.length && !destinationStatusId) return
    if (destinationStatusId && !remaining.some((entry) => entry.id === destinationStatusId)) throw new StorageError('Choose another stage in this list')
    const statuses = current.statuses.filter((entry) => entry.id !== statusId).map((entry) => entry.listId === removed.listId ? { ...entry, order: entry.order > removed.order ? entry.order - 1 : entry.order } : entry)
    const items = destinationStatusId ? current.items.map((item) => item.statusId === statusId ? { ...item, statusId: destinationStatusId } : item) : current.items
    await this.writeCurrent({ ...current, statuses, items }, 'remove stage')
  }

  private async readCurrent(action: string): Promise<AppData> {
    try { return validateAppData(migrateSnapshot(await this.driver.readSnapshot() ?? emptyAppData())) }
    catch (error) { throw new StorageError(`Could not ${action}: ${errorMessage(error)}`, { cause: error }) }
  }

  private async writeCurrent(data: AppData, action: string): Promise<void> {
    try { await this.driver.writeData(validateAppData(data), new Map()) }
    catch (error) { throw new StorageError(`Could not ${action}: ${errorMessage(error)}`, { cause: error }) }
  }

  async deleteItem(itemId: string): Promise<void> {
    try {
      const current = validateAppData(migrateSnapshot(await this.driver.readSnapshot() ?? emptyAppData()))
      const removed = current.items.find((item) => item.id === itemId)
      if (!removed) return
      const next = validateAppData({ ...current, items: current.items.filter((item) => item.id !== itemId) })
      const deletedImages = new Set(removed.imageId && !next.items.some((item) => item.imageId === removed.imageId) ? [removed.imageId] : [])
      await this.driver.writeData(next, new Map(), deletedImages)
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(`Could not delete item: ${errorMessage(error)}`, { cause: error })
    }
  }

  async deleteList(listId: string): Promise<void> {
    try {
      const current = validateAppData(migrateSnapshot(await this.driver.readSnapshot() ?? emptyAppData()))
      const removedImages = new Set(current.items.filter((item) => item.listId === listId && item.imageId).map((item) => item.imageId as string))
      const next: AppData = {
        ...current,
        lists: current.lists.filter((list) => list.id !== listId).map((list, index) => ({ ...list, sortOrder: index })),
        statuses: current.statuses.filter((status) => status.listId !== listId),
        items: current.items.filter((item) => item.listId !== listId),
      }
      const retainedImages = imageIds(next)
      for (const id of retainedImages) removedImages.delete(id)
      if (this.driver.deleteList) await this.driver.deleteList(validateAppData(next), removedImages)
      else await this.driver.writeData(validateAppData(next), new Map())
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(`Could not delete list: ${errorMessage(error)}`, { cause: error })
    }
  }

  async getImage(id: string): Promise<Blob | undefined> {
    try {
      return await this.driver.readImage(id)
    } catch (error) {
      throw new StorageError(`Could not load image: ${errorMessage(error)}`, { cause: error })
    }
  }
}

function imageIds(data: AppData): Set<string> {
  return new Set(data.items.flatMap((item) => item.imageId === null ? [] : [item.imageId]))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown storage error'
}

function migrateSnapshot(value: unknown): unknown {
  if (!isRecord(value) || !('schemaVersion' in value)) return value
  const record = value
  if (record.schemaVersion === 1) {
    assertKeys(record, ['schemaVersion', 'lists', 'statuses', 'items'], [], 'Version 1 snapshot')
    if (!Array.isArray(record.lists) || !Array.isArray(record.statuses) || !Array.isArray(record.items)) throw new InvalidDataError('Version 1 snapshot is malformed')
    for (const list of record.lists) assertKeys(list, ['id', 'title', 'mode', 'sortOrder'], [], 'Version 1 list')
    for (const status of record.statuses) assertKeys(status, ['id', 'listId', 'title', 'order'], [], 'Version 1 status')
    for (const item of record.items) assertKeys(item, ['id', 'listId', 'title', 'notes', 'imageId', 'statusId', 'position'], ['date'], 'Version 1 item')
    return { ...record, schemaVersion: 3, lists: record.lists.map((list) => ({ ...list as object, icon: null })), items: record.items.map((item) => ({ ...item as object, externalUrl: null })) }
  }
  if (record.schemaVersion === 2) {
    assertKeys(record, ['schemaVersion', 'lists', 'statuses', 'items'], [], 'Version 2 snapshot')
    if (!Array.isArray(record.lists) || !Array.isArray(record.statuses) || !Array.isArray(record.items)) throw new InvalidDataError('Version 2 snapshot is malformed')
    for (const list of record.lists) assertKeys(list, ['id', 'title', 'mode', 'sortOrder', 'icon'], [], 'Version 2 list')
    for (const status of record.statuses) assertKeys(status, ['id', 'listId', 'title', 'order'], [], 'Version 2 status')
    for (const item of record.items) assertKeys(item, ['id', 'listId', 'title', 'notes', 'imageId', 'statusId', 'position'], ['date'], 'Version 2 item')
    return { ...record, schemaVersion: 3, items: record.items.map((item) => ({ ...item as object, externalUrl: null })) }
  }
  if (record.schemaVersion !== 0) return value
  // The repository history predating this model has no stored domain shape to infer from.
  // Only migrate a complete snapshot with the current fields, changing its version marker.
  assertKeys(record, ['schemaVersion', 'lists', 'statuses', 'items'], [], 'Version 0 snapshot')
  if (!Array.isArray(record.lists) || !Array.isArray(record.statuses) || !Array.isArray(record.items)) {
    throw new InvalidDataError('Version 0 snapshot is malformed')
  }
  for (const list of record.lists) assertKeys(list, ['id', 'title', 'mode', 'sortOrder'], [], 'Version 0 list')
  for (const status of record.statuses) assertKeys(status, ['id', 'listId', 'title', 'order'], [], 'Version 0 status')
  for (const item of record.items) {
    assertKeys(item, ['id', 'listId', 'title', 'notes', 'imageId', 'statusId', 'position'], ['date'], 'Version 0 item')
  }
  return { ...record, schemaVersion: 3, lists: record.lists.map((list) => ({ ...list as object, icon: null })), items: record.items.map((item) => ({ ...item as object, externalUrl: null })) }
}

function assertKeys(value: unknown, required: string[], optional: string[], label: string): void {
  if (!isRecord(value)) throw new InvalidDataError(`${label} must be an object`)
  const allowed = new Set([...required, ...optional])
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new InvalidDataError(`${label} has an ambiguous or unsupported shape`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DATABASE_NAME = 'nextup-local-data'
const DATABASE_VERSION = 2
const SNAPSHOT_STORE = 'snapshots'
const IMAGE_STORE = 'images'
const SNAPSHOT_KEY = 'current'

export class IndexedDbDriver implements LocalDataDriver {
  private readonly factory: IDBFactory | undefined

  constructor(factory?: IDBFactory) {
    this.factory = factory
  }

  async readSnapshot(): Promise<unknown | undefined> {
    const database = await this.open()
    try {
      const transaction = database.transaction(SNAPSHOT_STORE, 'readonly')
      const result = await requestResult(transaction.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY))
      await transactionDone(transaction)
      return result as unknown | undefined
    } finally {
      database.close()
    }
  }

  async writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>, deleteImageIds: ReadonlySet<string> = new Set()): Promise<void> {
    const database = await this.open()
    try {
      const transaction = database.transaction([SNAPSHOT_STORE, IMAGE_STORE], 'readwrite')
      const completed = transactionDone(transaction)
      try {
        transaction.objectStore(SNAPSHOT_STORE).put(snapshot, SNAPSHOT_KEY)
        const imageStore = transaction.objectStore(IMAGE_STORE)
        for (const [id, image] of images) imageStore.put(image, id)
        for (const id of deleteImageIds) if (!images.has(id)) imageStore.delete(id)
        await completed
      } catch (error) {
        try {
          transaction.abort()
        } catch {
          // The transaction may already have aborted or committed.
        }
        await completed.catch(() => undefined)
        throw error
      }
    } finally {
      database.close()
    }
  }

  async deleteList(snapshot: AppData, imageIdsToDelete: ReadonlySet<string>): Promise<void> {
    const database = await this.open()
    try {
      const transaction = database.transaction([SNAPSHOT_STORE, IMAGE_STORE], 'readwrite')
      const completed = transactionDone(transaction)
      transaction.objectStore(SNAPSHOT_STORE).put(snapshot, SNAPSHOT_KEY)
      const images = transaction.objectStore(IMAGE_STORE)
      for (const id of imageIdsToDelete) images.delete(id)
      await completed
    } finally { database.close() }
  }

  async readImage(id: string): Promise<Blob | undefined> {
    const database = await this.open()
    try {
      const transaction = database.transaction(IMAGE_STORE, 'readonly')
      const result = await requestResult(transaction.objectStore(IMAGE_STORE).get(id))
      await transactionDone(transaction)
      return result instanceof Blob ? result : undefined
    } finally {
      database.close()
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest
      try {
        const factory = this.factory ?? globalThis.indexedDB
        if (!factory) throw new Error('IndexedDB is not available in this browser')
        request = factory.open(DATABASE_NAME, DATABASE_VERSION)
      } catch (error) {
        reject(error)
        return
      }
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) database.createObjectStore(SNAPSHOT_STORE)
        if (!database.objectStoreNames.contains(IMAGE_STORE)) database.createObjectStore(IMAGE_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'))
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another tab'))
    })
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}
