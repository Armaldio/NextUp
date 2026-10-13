export const CURRENT_SCHEMA_VERSION = 1 as const

export type ListMode = 'status' | 'date'

export interface List {
  id: string
  title: string
  mode: ListMode
  sortOrder: number
}

export interface Status {
  id: string
  listId: string
  title: string
  order: number
}

export type ItemDate =
  | { kind: 'date-only'; value: string }
  | { kind: 'local-date-time'; value: string }

export interface Item {
  id: string
  listId: string
  title: string
  notes: string
  imageId: string | null
  date?: ItemDate
  statusId: string | null
  position: number
}

export interface AppData {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  lists: List[]
  statuses: Status[]
  items: Item[]
}

export function emptyAppData(): AppData {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, lists: [], statuses: [], items: [] }
}
