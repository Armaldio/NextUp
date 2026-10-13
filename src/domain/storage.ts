import { emptyAppData, type AppData } from './model.ts'
import { InvalidDataError, validateAppData } from './validation.ts'

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}

export interface LocalDataDriver {
  readSnapshot(): Promise<unknown | undefined>
  writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>): Promise<void>
  readImage(id: string): Promise<Blob | undefined>
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
      if (isRecord(raw) && raw.schemaVersion === 0) await this.driver.writeData(data, new Map())
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
  return { ...record, schemaVersion: 1 }
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
const DATABASE_VERSION = 1
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

  async writeData(snapshot: AppData, images: ReadonlyMap<string, Blob>): Promise<void> {
    const database = await this.open()
    try {
      const transaction = database.transaction([SNAPSHOT_STORE, IMAGE_STORE], 'readwrite')
      const completed = transactionDone(transaction)
      try {
        transaction.objectStore(SNAPSHOT_STORE).put(snapshot, SNAPSHOT_KEY)
        const imageStore = transaction.objectStore(IMAGE_STORE)
        for (const [id, image] of images) imageStore.put(image, id)
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
