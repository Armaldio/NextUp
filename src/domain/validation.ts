import { CURRENT_SCHEMA_VERSION, type AppData, type Item, type ItemDate, type List, type Status } from './model.ts'

export class InvalidDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDataError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new InvalidDataError(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function order(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidDataError(`${label} must be a non-negative integer`)
  }
  return value as number
}

function validDate(value: unknown): value is ItemDate {
  if (!record(value) || (value.kind !== 'date-only' && value.kind !== 'local-date-time') || typeof value.value !== 'string') return false
  const pattern = value.kind === 'date-only'
    ? /^(\d{4})-(\d{2})-(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  const parts = value.value.match(pattern)
  if (!parts) return false
  const [, rawYear, rawMonth, rawDay] = parts
  const year = Number(rawYear)
  const month = Number(rawMonth)
  const day = Number(rawDay)
  if (month < 1 || month > 12) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > daysInMonth[month - 1]) return false
  if (value.kind === 'local-date-time') {
    const [, , , , hour, minute, second] = parts
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return false
  }
  return true
}

function parseList(value: unknown): List {
  if (!record(value)) throw new InvalidDataError('List must be an object')
  if (value.mode !== 'status' && value.mode !== 'date') throw new InvalidDataError('List mode is invalid')
  return {
    id: text(value.id, 'List id'),
    title: text(value.title, 'List title'),
    mode: value.mode,
    sortOrder: order(value.sortOrder, 'List sortOrder'),
    icon: value.icon === undefined || value.icon === null ? null : text(value.icon, 'List icon'),
  }
}

function parseStatus(value: unknown): Status {
  if (!record(value)) throw new InvalidDataError('Status must be an object')
  return {
    id: text(value.id, 'Status id'),
    listId: text(value.listId, 'Status listId'),
    title: text(value.title, 'Status title'),
    order: order(value.order, 'Status order'),
  }
}

function validExternalUrl(value: unknown): string {
  const urlText = text(value, 'Item externalUrl')
  let url: URL
  try { url = new URL(urlText) } catch { throw new InvalidDataError('Item externalUrl must be a valid HTTP or HTTPS URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidDataError('Item externalUrl must use HTTP or HTTPS')
  return urlText
}

function parseItem(value: unknown): Item {
  if (!record(value)) throw new InvalidDataError('Item must be an object')
  const imageId = value.imageId === null ? null : text(value.imageId, 'Item imageId')
  if (imageId !== null && /^blob:/i.test(imageId)) {
    throw new InvalidDataError('Item imageId must be a durable local reference, not an object URL')
  }
  const item: Item = {
    id: text(value.id, 'Item id'),
    listId: text(value.listId, 'Item listId'),
    title: text(value.title, 'Item title'),
    notes: text(value.notes, 'Item notes', true),
    imageId,
    externalUrl: value.externalUrl === undefined || value.externalUrl === null ? null : validExternalUrl(value.externalUrl),
    statusId: value.statusId === null ? null : text(value.statusId, 'Item statusId'),
    position: order(value.position, 'Item position'),
  }
  if (value.date !== undefined) {
    if (!validDate(value.date)) throw new InvalidDataError('Item date is invalid')
    item.date = value.date
  }
  return item
}

function uniqueIds(data: AppData): void {
  const ids = new Set<string>()
  for (const id of [...data.lists.map((entry) => entry.id), ...data.statuses.map((entry) => entry.id), ...data.items.map((entry) => entry.id)]) {
    if (ids.has(id)) throw new InvalidDataError(`Duplicate id: ${id}`)
    ids.add(id)
  }
}

export function validateAppData(value: unknown): AppData {
  if (!record(value) || value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new InvalidDataError('Unsupported or missing schema version')
  }
  if (!Array.isArray(value.lists) || !Array.isArray(value.statuses) || !Array.isArray(value.items)) {
    throw new InvalidDataError('Lists, statuses, and items must be arrays')
  }
  const data: AppData = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lists: value.lists.map(parseList),
    statuses: value.statuses.map(parseStatus),
    items: value.items.map(parseItem),
  }
  uniqueIds(data)
  const lists = new Map(data.lists.map((list) => [list.id, list]))
  const statuses = new Map(data.statuses.map((status) => [status.id, status]))
  const listOrders = new Set<number>()
  const statusOrders = new Set<string>()
  const itemPositions = new Set<string>()

  for (const list of data.lists) {
    if (listOrders.has(list.sortOrder)) throw new InvalidDataError(`Duplicate list sortOrder: ${list.sortOrder}`)
    listOrders.add(list.sortOrder)
  }

  for (const status of data.statuses) {
    const list = lists.get(status.listId)
    if (!list) throw new InvalidDataError(`Status ${status.id} refers to a missing list`)
    if (list.mode === 'date') throw new InvalidDataError(`Date list ${list.id} cannot have statuses`)
    const key = `${status.listId}:${status.order}`
    if (statusOrders.has(key)) throw new InvalidDataError(`Duplicate status order in list ${status.listId}`)
    statusOrders.add(key)
  }
  for (const item of data.items) {
    const list = lists.get(item.listId)
    if (!list) throw new InvalidDataError(`Item ${item.id} refers to a missing list`)
    const positionKey = `${item.listId}:${item.position}`
    if (itemPositions.has(positionKey)) throw new InvalidDataError(`Duplicate item position in list ${item.listId}`)
    itemPositions.add(positionKey)
    if (item.statusId !== null) {
      const status = statuses.get(item.statusId)
      if (!status || status.listId !== item.listId) throw new InvalidDataError(`Item ${item.id} refers to an invalid status`)
    }
    if (list.mode === 'date' && item.statusId !== null) throw new InvalidDataError(`Date list item ${item.id} cannot have a status`)
  }
  return data
}
