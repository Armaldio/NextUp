import type { Item, ListMode } from './model.ts'

/** Order one list without changing its stored items. */
export function orderItemsForList(items: readonly Item[], mode: ListMode): Item[] {
  if (mode === 'date') return orderItemsByDate(items)
  return [...items].sort((left, right) => left.position - right.position)
}

/** Return items in date-mode order without changing the items themselves. */
export function orderItemsByDate(items: readonly Item[]): Item[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftDate = left.item.date
      const rightDate = right.item.date

      if (leftDate === undefined || rightDate === undefined) {
        if (leftDate === undefined && rightDate !== undefined) return 1
        if (leftDate !== undefined && rightDate === undefined) return -1
      } else {
        const dateOrder = compareDate(leftDate, rightDate)
        if (dateOrder !== 0) return dateOrder
      }

      return left.item.position - right.item.position || left.index - right.index
    })
    .map(({ item }) => item)
}

function compareDate(left: NonNullable<Item['date']>, right: NonNullable<Item['date']>): number {
  const valueOrder = left.value < right.value ? -1 : left.value > right.value ? 1 : 0
  if (valueOrder !== 0) return valueOrder
  if (left.kind === right.kind) return 0
  return left.kind === 'date-only' ? -1 : 1
}
