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
      if (isRecord(raw) && raw.schemaVersion === 0) await this.driver.writeData(data, new Map())
      for (const id of imageIds(data)) {
        if (!(await this.driver.readImage(id))) throw new InvalidDataError(`Item image ${id} is missing`)
      }
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
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return value
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 0) return value
  if (!Array.isArray(record.lists) || !Array.isArray(record.statuses) || !Array.isArray(record.items)) {
    throw new InvalidDataError('Version 0 snapshot is malformed')
  }
  return {
    schemaVersion: 1,
    lists: record.lists.map((list, index) => isRecord(list) ? { ...list, mode: 'status', sortOrder: index } : list),
    statuses: record.statuses.map((status, index) => isRecord(status) ? { ...status, order: index } : status),
    items: record.items.map((item, index) => isRecord(item) ? { ...item, imageId: null, position: index } : item),
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
      transaction.objectStore(SNAPSHOT_STORE).put(snapshot, SNAPSHOT_KEY)
      const imageStore = transaction.objectStore(IMAGE_STORE)
      for (const [id, image] of images) imageStore.put(image, id)
      await transactionDone(transaction)
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
