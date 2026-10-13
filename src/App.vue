<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IndexedDbDriver, LocalDataRepository, StorageError } from './domain/storage.ts'
import type { AppData, Item, ItemDate, ListMode } from './domain/model.ts'
import { createId } from './domain/id.ts'
import { orderItemsForList } from './domain/order.ts'
import { useAppRoute } from './router.ts'

const repository = new LocalDataRepository(new IndexedDbDriver())
const { route, navigate } = useAppRoute()
const data = ref<AppData | null>(null)
const loadError = ref('')
const isLoading = ref(true)
const creating = ref(false)
const title = ref('')
const mode = ref<ListMode>('status')
const icon = ref('')
const deleting = ref<string | null>(null)
const deleteDialog = ref<HTMLDialogElement | null>(null)
const deleteTrigger = ref<HTMLButtonElement | null>(null)
const listHeading = ref<HTMLElement | null>(null)
let focusAfterDelete = false
const saving = ref(false)
const lists = computed(() => [...(data.value?.lists ?? [])].sort((a, b) => a.sortOrder - b.sortOrder))
const activeList = computed(() => { const currentRoute = route.value; return currentRoute.name === 'list-detail' || currentRoute.name === 'item-detail' ? data.value?.lists.find((list) => list.id === currentRoute.listId) : undefined })
const activeItems = computed(() => orderItemsForList(data.value?.items.filter((item) => item.listId === activeList.value?.id) ?? [], activeList.value?.mode ?? 'status'))
const undatedItems = computed(() => activeList.value?.mode === 'date' ? activeItems.value.filter((item) => !item.date) : [])
const manualStages = computed(() => {
  if (!activeList.value || activeList.value.mode !== 'status' || !data.value) return []
  const items = data.value.items.filter((item) => item.listId === activeList.value!.id)
  const stages: { id: string | null; title: string; items: Item[] }[] = data.value.statuses.filter((status) => status.listId === activeList.value!.id).sort((a, b) => a.order - b.order)
    .map((status) => ({ id: status.id, title: status.title, items: items.filter((item) => item.statusId === status.id).sort((a, b) => a.position - b.position) }))
  const unassigned = items.filter((item) => item.statusId === null).sort((a, b) => a.position - b.position)
  if (unassigned.length) stages.push({ id: null, title: 'No stage', items: unassigned })
  return stages
})
const currentItem = computed(() => { const currentRoute = route.value; return currentRoute.name === 'item-detail' ? data.value?.items.find((item) => item.id === currentRoute.itemId && item.listId === currentRoute.listId) : undefined })
const itemTitle = ref('')
const itemNotes = ref('')
const itemLink = ref('')
const itemStatusId = ref<string | null>(null)
const itemDateKind = ref<'none' | 'date-only' | 'local-date-time'>('none')
const itemDateValue = ref('')
const itemImageId = ref<string | null>(null)
const itemImage = ref<Blob | null>(null)
const itemImageUrl = ref('')
const homeImageUrls = ref(new Map<string, string>())
const failedHomeImages = ref(new Set<string>())
const initializedHomeRails = new Set<string>()
const homeRailPositions = new Map<string, number>()
let homePreviewRun = 0
const itemError = ref('')
const stageTitle = ref('')
const stageError = ref('')
const stageRemoval = ref<string | null>(null)
const stageDestination = ref<string | null>(null)
const snapshotMutationPending = ref(false)
const itemFormOpen = ref(false)
const editingItemId = ref<string | null>(null)
const maxImageBytes = 5 * 1024 * 1024
const statusForItem = (item: Item) => data.value?.statuses.find((status) => status.id === item.statusId)?.title ?? ''
function beginSnapshotMutation(): boolean {
  if (snapshotMutationPending.value) return false
  snapshotMutationPending.value = true
  return true
}
function endSnapshotMutation(): void { snapshotMutationPending.value = false }
function dateLabel(item: Item): string {
  if (!item.date) return 'No date'
  const value = item.date.kind === 'date-only' ? item.date.value : item.date.value.replace('T', ' ')
  return `${value} · ${item.date.kind === 'date-only' ? 'Date only' : 'Local time'}`
}
function homeItemsForList(list: AppData['lists'][number]): { item: Item; statusTitle: string }[] {
  const items = data.value?.items.filter((item) => item.listId === list.id) ?? []
  if (list.mode === 'date') return orderItemsForList(items, 'date').map((item) => ({ item, statusTitle: '' }))
  const statuses = (data.value?.statuses ?? []).filter((status) => status.listId === list.id).sort((a, b) => a.order - b.order)
  return [
    ...statuses.flatMap((status) => orderItemsForList(items.filter((item) => item.statusId === status.id), 'status').map((item) => ({ item, statusTitle: status.title }))),
    ...orderItemsForList(items.filter((item) => item.statusId === null), 'status').map((item) => ({ item, statusTitle: 'No stage' })),
  ]
}
function homeItemDate(item: Item): string {
  if (!item.date) return 'No date'
  return item.date.kind === 'date-only' ? item.date.value : item.date.value.replace('T', ' ')
}
function initialHomeItem(list: AppData['lists'][number]): Item | undefined {
  const entries = homeItemsForList(list)
  if (list.mode === 'status') {
    const statuses = (data.value?.statuses ?? []).filter((status) => status.listId === list.id).sort((a, b) => a.order - b.order)
    const targetStatuses = statuses.filter((status) => ['in progress', 'up next'].includes(status.title.trim().toLowerCase()))
    return entries.find((entry) => targetStatuses.some((status) => status.id === entry.item.statusId))?.item
  }
  const datedItems = entries.map((entry) => entry.item).filter((item): item is Item & { date: ItemDate } => Boolean(item.date))
  if (!datedItems.length) return undefined
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const localNow = `${today}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return datedItems.find((item) => (item.date.kind === 'date-only' ? item.date.value >= today : item.date.value >= localNow)) ?? datedItems[0]
}
function registerHomeRail(list: AppData['lists'][number], element: Element | null): void {
  if (!element || !(element instanceof HTMLElement)) return
  const rail = element
  if (initializedHomeRails.has(list.id)) {
    rail.scrollLeft = homeRailPositions.get(list.id) ?? rail.scrollLeft
    return
  }
  const target = initialHomeItem(list)
  if (!target) return
  initializedHomeRails.add(list.id)
  void nextTick(() => requestAnimationFrame(() => {
    const card = rail.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(target.id)}"]`)
    if (!card) return
    const cardLeft = card.getBoundingClientRect().left - rail.getBoundingClientRect().left + rail.scrollLeft
    rail.scrollLeft = Math.max(0, cardLeft - (rail.clientWidth - card.offsetWidth) / 2)
    homeRailPositions.set(list.id, rail.scrollLeft)
  }))
}
function rememberHomeRailPosition(listId: string, event: Event): void {
  homeRailPositions.set(listId, (event.currentTarget as HTMLElement).scrollLeft)
}
function scrollHomeRailWithKeyboard(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).scrollBy({ left: event.key === 'ArrowRight' ? 240 : -240, behavior: 'smooth' })
}
function scrollHomeRailWithWheel(event: WheelEvent): void {
  if (event.deltaX !== 0 || event.deltaY === 0) return
  const rail = event.currentTarget as HTMLElement
  const maxScrollLeft = rail.scrollWidth - rail.clientWidth
  if (maxScrollLeft <= 0) return
  if (event.deltaY > 0 ? rail.scrollLeft >= maxScrollLeft : rail.scrollLeft <= 0) return
  event.preventDefault()
  rail.scrollLeft += event.deltaY
}
function detailPath(item: Item): string { return `/lists/${encodeURIComponent(item.listId)}/items/${encodeURIComponent(item.id)}` }
function clearItemForm(): void { itemFormOpen.value = false; editingItemId.value = null; itemTitle.value = ''; itemNotes.value = ''; itemLink.value = ''; itemStatusId.value = null; itemDateKind.value = 'none'; itemDateValue.value = ''; itemImageId.value = null; itemImage.value = null; itemError.value = '' }
function editItem(item?: Item): void {
  if (snapshotMutationPending.value) return
  itemFormOpen.value = true
  editingItemId.value = item?.id ?? null; itemTitle.value = item?.title ?? ''; itemNotes.value = item?.notes ?? ''; itemLink.value = item?.externalUrl ?? ''; itemStatusId.value = item ? item.statusId : (data.value?.statuses.find((status) => status.listId === activeList.value?.id)?.id ?? null)
  itemDateKind.value = item?.date?.kind ?? 'none'; itemDateValue.value = item?.date?.value ?? ''; itemImageId.value = item?.imageId ?? null; itemImage.value = null; itemError.value = ''
}
async function selectItemImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { itemError.value = 'Choose a PNG, JPEG, GIF, or WebP image.'; input.value = ''; return }
  if (file.size > maxImageBytes) { itemError.value = 'Choose an image smaller than 5 MB.'; input.value = ''; return }
  itemImage.value = file; itemImageId.value = createId(); itemError.value = ''
}
async function saveItem(): Promise<void> {
  if (snapshotMutationPending.value || !activeList.value || !data.value || !itemTitle.value.trim()) return
  if (!beginSnapshotMutation()) return
  itemError.value = ''; saving.value = true
  try {
    const list = activeList.value!
    const date: ItemDate | undefined = itemDateKind.value === 'none' ? undefined : { kind: itemDateKind.value, value: itemDateValue.value }
    const item: Item = { id: editingItemId.value ?? createId(), listId: list.id, title: itemTitle.value.trim(), notes: itemNotes.value, imageId: itemImageId.value, externalUrl: itemLink.value.trim() || null, ...(date ? { date } : {}), statusId: list.mode === 'status' ? itemStatusId.value : null, position: editingItemId.value ? data.value!.items.find((entry) => entry.id === editingItemId.value)?.position ?? 0 : Math.max(-1, ...activeItems.value.map((entry) => entry.position)) + 1 }
    await repository.saveItem(item, itemImage.value ?? undefined); data.value = await repository.load(); clearItemForm()
  }
  catch (error) { itemError.value = error instanceof Error ? error.message : 'Item could not be saved.' }
  finally { saving.value = false; endSnapshotMutation() }
}
async function removeItem(item: Item): Promise<void> {
  if (snapshotMutationPending.value) return
  if (!window.confirm(`Delete “${item.title}”? This also removes its image if no other item uses it.`)) return
  if (!beginSnapshotMutation()) return
  try { await repository.deleteItem(item.id); data.value = await repository.load(); if (route.value.name === 'item-detail') navigate(`/lists/${encodeURIComponent(item.listId)}`) }
  catch (error) { itemError.value = error instanceof Error ? error.message : 'Item could not be deleted.' }
  finally { endSnapshotMutation() }
}
async function moveUndatedItem(item: Item, offset: number): Promise<void> {
  if (snapshotMutationPending.value) return
  if (!activeList.value || activeList.value.mode !== 'date' || item.date) return
  const index = undatedItems.value.findIndex((entry) => entry.id === item.id)
  const targetIndex = index + offset
  if (index < 0 || targetIndex < 0 || targetIndex >= undatedItems.value.length) return
  const orderedIds = undatedItems.value.map((entry) => entry.id)
  const movingId = orderedIds[index]!
  orderedIds[index] = orderedIds[targetIndex]!
  orderedIds[targetIndex] = movingId
  itemError.value = ''
  if (!beginSnapshotMutation()) return
  try {
    await repository.reorderUndatedItems(activeList.value.id, orderedIds)
    data.value = await repository.load()
  } catch (error) { itemError.value = error instanceof Error ? error.message : 'Undated item order could not be saved.' }
  finally { endSnapshotMutation() }
}
async function moveManualItem(item: Item, offset: number): Promise<void> {
  if (snapshotMutationPending.value) return
  const stage = manualStages.value.find((entry) => entry.id === item.statusId)
  if (!activeList.value || activeList.value.mode !== 'status' || !stage) return
  const index = stage.items.findIndex((entry) => entry.id === item.id)
  const targetIndex = index + offset
  if (index < 0 || targetIndex < 0 || targetIndex >= stage.items.length) return
  const orderedIds = stage.items.map((entry) => entry.id)
  const [movingId] = orderedIds.splice(index, 1)
  orderedIds.splice(targetIndex, 0, movingId!)
  itemError.value = ''
  if (!beginSnapshotMutation()) return
  try {
    await repository.reorderManualStageItems(activeList.value.id, stage.id, orderedIds)
    data.value = await repository.load()
  } catch (error) { itemError.value = error instanceof Error ? error.message : 'Manual item order could not be saved.' }
  finally { endSnapshotMutation() }
}
async function loadDetailImage(): Promise<void> {
  if (itemImageUrl.value) URL.revokeObjectURL(itemImageUrl.value)
  itemImageUrl.value = ''
  const itemId = currentItem.value?.id
  const imageId = currentItem.value?.imageId
  if (!itemId || !imageId) return
  try {
    const blob = await repository.getImage(imageId)
    if (route.value.name !== 'item-detail' || currentItem.value?.id !== itemId) return
    if (blob) itemImageUrl.value = URL.createObjectURL(blob)
  } catch { itemImageUrl.value = '' }
}
function clearHomeImageUrls(): void {
  for (const url of homeImageUrls.value.values()) URL.revokeObjectURL(url)
  homeImageUrls.value = new Map()
}
async function loadHomeImagePreviews(): Promise<void> {
  const run = ++homePreviewRun
  clearHomeImageUrls()
  failedHomeImages.value = new Set()
  if (route.value.name !== 'home' || !data.value) return
  const imageItems = data.value.items.filter((item) => item.imageId)
  const urls = new Map<string, string>()
  const failed = new Set<string>()
  await Promise.all(imageItems.map(async (item) => {
    try {
      const blob = item.imageId ? await repository.getImage(item.imageId) : undefined
      if (blob) urls.set(item.id, URL.createObjectURL(blob))
      else failed.add(item.id)
    } catch { failed.add(item.id) }
  }))
  if (run !== homePreviewRun || route.value.name !== 'home') {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    return
  }
  homeImageUrls.value = urls
  failedHomeImages.value = failed
}
function failHomeImage(itemId: string, event: Event): void {
  const renderedUrl = (event.currentTarget as HTMLImageElement).getAttribute('src')
  const url = homeImageUrls.value.get(itemId)
  if (!url || renderedUrl !== url) return
  URL.revokeObjectURL(url)
  const urls = new Map(homeImageUrls.value)
  urls.delete(itemId)
  homeImageUrls.value = urls
  failedHomeImages.value = new Set([...failedHomeImages.value, itemId])
}
async function createItemFromHome(list: AppData['lists'][number]): Promise<void> {
  if (snapshotMutationPending.value) return
  navigate(`/lists/${encodeURIComponent(list.id)}`)
  await nextTick()
  editItem()
}
watch([currentItem, data, route], loadDetailImage)
watch([data, route], loadHomeImagePreviews)
onUnmounted(() => {
  if (itemImageUrl.value) URL.revokeObjectURL(itemImageUrl.value)
  homePreviewRun += 1
  clearHomeImageUrls()
})

async function loadSavedData(): Promise<void> {
  isLoading.value = true; loadError.value = ''
  try { data.value = await repository.load() }
  catch (error) { loadError.value = error instanceof StorageError ? error.message : 'Saved data could not be loaded.' }
  finally { isLoading.value = false }
}
watch(deleting, async (id) => {
  await nextTick()
  if (id && deleteDialog.value && !deleteDialog.value.open) {
    deleteDialog.value.showModal()
    deleteDialog.value.querySelector<HTMLButtonElement>('[data-dialog-cancel]')?.focus()
  } else if (!id) {
    if (deleteDialog.value?.open) deleteDialog.value.close()
    if (!focusAfterDelete) deleteTrigger.value?.focus()
    deleteTrigger.value = null
  }
})
function cancelDelete(): void { if (!snapshotMutationPending.value) deleting.value = null }
function openDelete(id: string, event: MouseEvent): void {
  if (snapshotMutationPending.value) return
  deleteTrigger.value = event.currentTarget as HTMLButtonElement
  deleting.value = id
}
function followRoute(event: MouseEvent, path: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault(); navigate(path)
}
async function createList(): Promise<void> {
  if (snapshotMutationPending.value || !data.value || !title.value.trim() || !beginSnapshotMutation()) return
  saving.value = true
  try {
    const id = createId()
    const list = { id, title: title.value.trim(), mode: mode.value, sortOrder: data.value.lists.length, icon: icon.value.trim() || null }
    const next: AppData = { ...data.value, lists: [...data.value.lists, list], statuses: mode.value === 'status' ? [...data.value.statuses, ...['Done', 'In progress', 'Up next'].map((name, order) => ({ id: createId(), listId: id, title: name, order }))] : data.value.statuses }
    await repository.save(next); data.value = next; title.value = ''; icon.value = ''; creating.value = false
  }
  catch (error) { loadError.value = error instanceof StorageError ? error.message : 'List could not be saved.' }
  finally { saving.value = false; endSnapshotMutation() }
}
async function renameList(id: string, value: string): Promise<void> {
  if (snapshotMutationPending.value || !data.value || !value.trim() || !beginSnapshotMutation()) return
  try {
    const next = { ...data.value, lists: data.value.lists.map((list) => list.id === id ? { ...list, title: value.trim() } : list) }
    await repository.save(next); data.value = next
  } catch (error) { loadError.value = error instanceof StorageError ? error.message : 'List could not be renamed.' }
  finally { endSnapshotMutation() }
}
async function deleteList(id: string): Promise<void> {
  if (snapshotMutationPending.value || !data.value || !beginSnapshotMutation()) return
  try {
    await repository.deleteList(id)
    focusAfterDelete = true
    deleting.value = null
    await loadSavedData()
    await nextTick()
    listHeading.value?.focus()
  } catch (error) { loadError.value = error instanceof StorageError ? error.message : 'List could not be deleted.' }
  finally { focusAfterDelete = false; endSnapshotMutation() }
}
const activeStatuses = computed(() => activeList.value && data.value ? data.value.statuses.filter((status) => status.listId === activeList.value!.id).sort((a, b) => a.order - b.order) : [])
async function addStage(): Promise<void> {
  if (snapshotMutationPending.value || !activeList.value || !data.value || !stageTitle.value.trim()) return
  if (!beginSnapshotMutation()) return
  stageError.value = ''
  try {
    await repository.addStatus({ id: createId(), listId: activeList.value.id, title: stageTitle.value.trim(), order: activeStatuses.value.length })
    data.value = await repository.load(); stageTitle.value = ''
  } catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage could not be added.' }
  finally { endSnapshotMutation() }
}
async function renameStage(id: string, title: string): Promise<void> {
  if (snapshotMutationPending.value || !title.trim() || !beginSnapshotMutation()) return
  stageError.value = ''
  try { await repository.renameStatus(id, title.trim()); data.value = await repository.load() }
  catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage could not be renamed.' }
  finally { endSnapshotMutation() }
}
async function moveStage(index: number, offset: number): Promise<void> {
  if (snapshotMutationPending.value) return
  const status = activeStatuses.value[index]
  if (!status) return
  if (!beginSnapshotMutation()) return
  stageError.value = ''
  try { await repository.reorderStatus(status.id, index + offset); data.value = await repository.load() }
  catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage order could not be saved.' }
  finally { endSnapshotMutation() }
}
function requestRemoveStage(id: string): void {
  if (snapshotMutationPending.value) return
  stageRemoval.value = id
  const hasItems = data.value?.items.some((item) => item.statusId === id) ?? false
  stageDestination.value = hasItems ? null : activeStatuses.value.find((status) => status.id !== id)?.id ?? null
}
const stageRemovalHasItems = computed(() => stageRemoval.value !== null && (data.value?.items.some((item) => item.statusId === stageRemoval.value) ?? false))
async function removeStage(): Promise<void> {
  if (snapshotMutationPending.value || !stageRemoval.value || !beginSnapshotMutation()) return
  stageError.value = ''
  try {
    await repository.deleteStatus(stageRemoval.value, stageDestination.value)
    data.value = await repository.load(); stageRemoval.value = null
  } catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage could not be removed.' }
  finally { endSnapshotMutation() }
}
onMounted(loadSavedData)
</script>

<template>
  <div class="app-shell">
    <header class="app-header"><a class="brand" href="/" @click="followRoute($event, '/')">NextUp</a><p class="storage-note">Saved on this device</p></header>
    <main id="main-content" class="page-content">
      <section v-if="isLoading" class="message-card" aria-live="polite"><p>Opening your saved lists…</p></section>
      <section v-else-if="loadError" class="message-card error-card" role="alert"><h1>Your saved data could not be opened</h1><p>{{ loadError }}</p><button type="button" @click="loadSavedData">Try again</button></section>
      <template v-else>
        <section v-if="route.name === 'home'" class="lists-page">
          <div class="page-heading"><div><p class="eyebrow">Your workspace</p><h1 ref="listHeading" tabindex="-1">Your lists</h1><p class="quiet-count">{{ lists.length }} {{ lists.length === 1 ? 'list' : 'lists' }} saved on this device</p></div><button class="primary-button" :disabled="snapshotMutationPending" @click="creating = !creating">{{ creating ? 'Close' : '＋ New list' }}</button></div>
          <form v-if="creating" class="list-form" @submit.prevent="createList">
            <h2>Create a list</h2>
            <label>List name<input v-model="title" required maxlength="100" :disabled="snapshotMutationPending" autofocus placeholder="For example, Weekend plans"></label>
            <label>Mode<select v-model="mode" :disabled="snapshotMutationPending"><option value="status">Manual</option><option value="date">Date</option></select></label>
            <p class="form-hint">{{ mode === 'status' ? 'Manual lists start with Done, In progress, and Up next stages. You can customize stages after creation.' : 'Date lists organize items by their dates and do not use statuses.' }} Mode cannot be changed after creation.</p>
            <label>Icon <span class="optional">(optional)</span><input v-model="icon" maxlength="8" :disabled="snapshotMutationPending" placeholder="e.g. 📚" aria-label="Optional list icon"></label>
            <button class="primary-button" :disabled="saving || snapshotMutationPending || !title.trim()">Create list</button>
          </form>
          <div v-if="lists.length" class="list-grid"><article v-for="list in lists" :key="list.id" class="list-card">
            <a class="list-open" :href="`/lists/${encodeURIComponent(list.id)}`" @click="followRoute($event, `/lists/${encodeURIComponent(list.id)}`)"><span class="list-icon" aria-hidden="true">{{ list.icon || (list.mode === 'date' ? '◷' : '☷') }}</span><span><strong>{{ list.title }}</strong><small>{{ list.mode === 'date' ? 'Date list' : 'Manual list' }}</small></span></a>
            <div class="list-actions"><label class="sr-only" :for="`rename-${list.id}`">Rename {{ list.title }}</label><input :id="`rename-${list.id}`" :value="list.title" :disabled="snapshotMutationPending" :aria-label="`Rename ${list.title}`" @change="renameList(list.id, ($event.target as HTMLInputElement).value)"><button class="text-button danger-text" :disabled="snapshotMutationPending" :aria-label="`Delete ${list.title}`" @click="openDelete(list.id, $event)">Delete</button></div>
            <dialog v-if="deleting === list.id" ref="deleteDialog" class="confirm-box" :aria-labelledby="`delete-title-${list.id}`" @cancel.prevent="cancelDelete"><h2 :id="`delete-title-${list.id}`">Delete “{{ list.title }}”?</h2><p>This permanently deletes this list, its {{ data!.items.filter((item) => item.listId === list.id).length }} items, their images when not shared with another list, and its statuses.</p><div><button type="button" class="text-button" data-dialog-cancel :disabled="snapshotMutationPending" @click="cancelDelete">Cancel</button><button type="button" class="text-button danger-text" :disabled="snapshotMutationPending" @click="deleteList(list.id)">Delete list</button></div></dialog>
          </article></div>
          <section v-for="list in lists" :key="`rail-${list.id}`" class="home-list-rail" :aria-labelledby="`home-list-${list.id}`">
            <div class="home-rail-heading">
              <h2 class="home-list-heading" :id="`home-list-${list.id}`"><a class="home-list-title" :href="`/lists/${encodeURIComponent(list.id)}`" @click="followRoute($event, `/lists/${encodeURIComponent(list.id)}`)">
                <span class="list-icon" aria-hidden="true">{{ list.icon || (list.mode === 'date' ? '◷' : '☷') }}</span>
                <span><strong>{{ list.title }}</strong><small>{{ list.mode === 'date' ? 'Date list' : 'Manual list' }}</small></span>
              </a></h2>
              <button type="button" class="text-button home-create-item" :disabled="snapshotMutationPending" @click="createItemFromHome(list)">＋ Item</button>
            </div>
            <div v-if="homeItemsForList(list).length" :ref="(element) => registerHomeRail(list, element as Element | null)" class="home-item-rail" role="region" tabindex="0" :aria-label="`${list.title} items`" @scroll.passive="rememberHomeRailPosition(list.id, $event)" @keydown="scrollHomeRailWithKeyboard" @wheel="scrollHomeRailWithWheel">
              <article v-for="entry in homeItemsForList(list)" :key="entry.item.id" class="home-item-card" :data-item-id="entry.item.id">
                <a class="home-item-link" :href="detailPath(entry.item)" :aria-label="`${entry.item.title}, ${list.mode === 'date' ? homeItemDate(entry.item) : entry.statusTitle || 'No stage'}`" @click="followRoute($event, detailPath(entry.item))">
                  <img v-if="entry.item.imageId && homeImageUrls.has(entry.item.id)" class="home-item-image" :src="homeImageUrls.get(entry.item.id)" :alt="`Image attached to ${entry.item.title}`" @error.prevent="failHomeImage(entry.item.id, $event)">
                  <span v-else class="home-item-image home-item-fallback" aria-hidden="true">{{ entry.item.imageId && failedHomeImages.has(entry.item.id) ? 'Image unavailable' : entry.item.imageId ? 'Loading image…' : 'No image' }}</span>
                  <span class="home-item-copy"><strong>{{ entry.item.title }}</strong><small v-if="list.mode === 'date'">{{ homeItemDate(entry.item) }}</small><small v-else>{{ entry.statusTitle || 'No stage' }}</small></span>
                </a>
              </article>
            </div>
            <div v-else class="home-rail-empty"><p>No items yet.</p><button type="button" class="text-button" :disabled="snapshotMutationPending" @click="createItemFromHome(list)">Add the first item</button></div>
          </section>
          <section v-if="!creating && lists.length === 0" class="message-card empty-state"><span class="empty-mark" aria-hidden="true">＋</span><h2>Start with a list</h2><p>Create a manual list for flexible stages or a date list for things tied to a day.</p><button class="primary-button" :disabled="snapshotMutationPending" @click="creating = true">Create your first list</button></section>
        </section>
        <section v-else-if="route.name === 'list-detail'" class="lists-page">
          <a class="back-link" href="/" @click="followRoute($event, '/')">← All lists</a>
          <template v-if="activeList"><div class="page-heading"><div><p class="eyebrow">{{ activeList.mode === 'date' ? 'Date list' : 'Manual list' }}</p><h1>{{ activeList.icon }} {{ activeList.title }}</h1></div><button class="primary-button" :disabled="snapshotMutationPending" @click="editItem()">＋ New item</button></div>
            <section v-if="activeList.mode === 'status'" class="stage-editor" aria-labelledby="stage-heading">
              <h2 id="stage-heading">Stages</h2>
              <p class="form-hint">Customize the stages for this manual list. Items keep their list order when stages change.</p>
              <ol class="stage-list"><li v-for="(status, index) in activeStatuses" :key="status.id">
                <label :for="`stage-${status.id}`">Stage {{ index + 1 }}</label>
                <input :id="`stage-${status.id}`" :value="status.title" maxlength="100" :disabled="snapshotMutationPending" :aria-label="`Rename stage ${status.title}`" @change="renameStage(status.id, ($event.target as HTMLInputElement).value)">
                <button type="button" class="text-button" :disabled="snapshotMutationPending || index === 0" :aria-label="`Move ${status.title} up`" @click="moveStage(index, -1)">↑</button>
                <button type="button" class="text-button" :disabled="snapshotMutationPending || index === activeStatuses.length - 1" :aria-label="`Move ${status.title} down`" @click="moveStage(index, 1)">↓</button>
                <button type="button" class="text-button danger-text" :disabled="snapshotMutationPending || activeStatuses.length <= 1" :aria-label="`Remove ${status.title}`" @click="requestRemoveStage(status.id)">Remove</button>
              </li></ol>
              <form class="stage-add" @submit.prevent="addStage"><label for="new-stage">Add a stage</label><input id="new-stage" v-model="stageTitle" maxlength="100" :disabled="snapshotMutationPending" placeholder="Stage name"><button class="text-button" :disabled="snapshotMutationPending || !stageTitle.trim()">Add stage</button></form>
              <p v-if="stageError" class="error-text" role="alert">{{ stageError }}</p>
              <div v-if="stageRemoval" class="stage-remove-prompt" role="group" aria-label="Remove stage">
                <p v-if="stageRemovalHasItems">Move items from “{{ activeStatuses.find((status) => status.id === stageRemoval)?.title }}” to another stage before removing it.</p>
                <p v-else>Remove “{{ activeStatuses.find((status) => status.id === stageRemoval)?.title }}”?</p>
                <label v-if="stageRemovalHasItems">Move items to<select v-model="stageDestination" :disabled="snapshotMutationPending"><option disabled :value="null">Choose a destination</option><option v-for="status in activeStatuses.filter((entry) => entry.id !== stageRemoval)" :key="status.id" :value="status.id">{{ status.title }}</option></select></label>
                <div class="form-actions"><button type="button" class="text-button" :disabled="snapshotMutationPending" @click="stageRemoval = null">Cancel</button><button type="button" class="text-button danger-text" :disabled="snapshotMutationPending || (stageRemovalHasItems && !stageDestination)" @click="removeStage">Remove stage</button></div>
              </div>
            </section>
            <p v-if="itemError && !itemFormOpen" class="error-text" role="alert">{{ itemError }}</p>
            <form v-if="itemFormOpen" class="list-form" @submit.prevent="saveItem">
              <h2>{{ editingItemId ? 'Edit item' : 'New item' }}</h2><label>Title<input v-model="itemTitle" required maxlength="200" autofocus></label>
              <label>Notes<textarea v-model="itemNotes" rows="4"></textarea></label>
              <label>External link <span class="optional">(optional)</span><input v-model="itemLink" type="url" placeholder="https://example.com"></label>
              <label>Date <select v-model="itemDateKind"><option value="none">No date</option><option value="date-only">Date only</option><option value="local-date-time">Date and time</option></select></label>
              <label v-if="itemDateKind !== 'none'">{{ itemDateKind === 'date-only' ? 'Date' : 'Local date and time' }}<input v-model="itemDateValue" :type="itemDateKind === 'date-only' ? 'date' : 'datetime-local'" required></label>
              <label v-if="activeList.mode === 'status'">Status<select v-model="itemStatusId"><option :value="null">No stage</option><option v-for="status in data!.statuses.filter((entry) => entry.listId === activeList!.id).sort((a, b) => a.order - b.order)" :key="status.id" :value="status.id">{{ status.title }}</option></select></label>
              <label>Image <span class="optional">(optional, PNG/JPEG/GIF/WebP, up to 5 MB)</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="selectItemImage"></label>
              <p v-if="itemImageId && !itemImage" class="form-hint">An image is attached. Select a new image to replace it, or clear it below.</p><button v-if="itemImageId" type="button" class="text-button danger-text" @click="itemImageId = null; itemImage = null">Remove image</button>
              <p v-if="itemError" class="error-text" role="alert">{{ itemError }}</p><div class="form-actions"><button type="button" class="text-button" @click="clearItemForm">Cancel</button><button class="primary-button" :disabled="saving || snapshotMutationPending || !itemTitle.trim()">Save item</button></div>
            </form>
            <template v-if="activeList.mode === 'status'">
              <section v-for="stage in manualStages" :key="stage.id ?? 'unassigned-stage'" class="manual-stage" :aria-labelledby="`manual-stage-${stage.id ?? 'unassigned'}`">
                <h3 :id="`manual-stage-${stage.id ?? 'unassigned'}`">{{ stage.title }}</h3>
                <div v-if="stage.items.length" class="list-grid"><article v-for="(item, index) in stage.items" :key="item.id" class="list-card"><a class="item-open" :href="detailPath(item)" @click="followRoute($event, detailPath(item))"><strong>{{ item.title }}</strong><small v-if="item.date">{{ dateLabel(item) }}</small></a><div class="list-actions"><button class="text-button" :disabled="snapshotMutationPending || index === 0" :aria-label="`Move ${item.title} earlier in ${stage.title}`" @click="moveManualItem(item, -1)">↑</button><button class="text-button" :disabled="snapshotMutationPending || index === stage.items.length - 1" :aria-label="`Move ${item.title} later in ${stage.title}`" @click="moveManualItem(item, 1)">↓</button><button class="text-button" :disabled="snapshotMutationPending" @click="editItem(item)">Edit</button><button class="text-button danger-text" :disabled="snapshotMutationPending" @click="removeItem(item)">Delete</button></div></article></div>
                <p v-else class="quiet-count">No items in this stage.</p>
              </section>
            </template>
            <div v-else-if="activeItems.length" class="list-grid"><article v-for="item in activeItems" :key="item.id" class="list-card"><a class="item-open" :href="detailPath(item)" @click="followRoute($event, detailPath(item))"><strong>{{ item.title }}</strong><small v-if="item.date || activeList.mode === 'date'">{{ dateLabel(item) }}</small></a><div class="list-actions"><template v-if="!item.date"><button class="text-button" :disabled="snapshotMutationPending || undatedItems[0]?.id === item.id" :aria-label="`Move ${item.title} earlier among undated items`" @click="moveUndatedItem(item, -1)">↑</button><button class="text-button" :disabled="snapshotMutationPending || undatedItems[undatedItems.length - 1]?.id === item.id" :aria-label="`Move ${item.title} later among undated items`" @click="moveUndatedItem(item, 1)">↓</button></template><button class="text-button" :disabled="snapshotMutationPending" @click="editItem(item)">Edit</button><button class="text-button danger-text" :disabled="snapshotMutationPending" @click="removeItem(item)">Delete</button></div></article></div>
            <p v-else-if="!editingItemId" class="quiet-count">No items yet. Add one to get started.</p>
          </template><p v-else class="message-card">This list could not be found.</p>
        </section>
        <section v-else-if="route.name === 'item-detail'" class="message-card">
          <a class="back-link" :href="`/lists/${encodeURIComponent(route.listId)}`" @click="followRoute($event, `/lists/${encodeURIComponent(route.listId)}`)">← Back to list</a>
          <template v-if="currentItem"><p class="eyebrow">{{ activeList?.title ?? 'Item' }}</p><h1>{{ currentItem.title }}</h1><p v-if="currentItem.statusId" class="item-meta">{{ statusForItem(currentItem) }}</p><p v-if="currentItem.date || activeList?.mode === 'date'" class="item-meta">{{ dateLabel(currentItem) }}</p><p v-if="currentItem.notes" class="item-notes">{{ currentItem.notes }}</p><p v-if="currentItem.externalUrl"><a :href="currentItem.externalUrl" target="_blank" rel="noopener noreferrer">Open external link</a></p><img v-if="currentItem.imageId && itemImageUrl" class="item-image" :src="itemImageUrl" :alt="`Image attached to ${currentItem.title}`"><p v-else-if="currentItem.imageId" class="form-hint" role="status">Image preview is unavailable, but the attachment remains saved.</p><div class="form-actions"><button class="primary-button" @click="editItem(currentItem); navigate(`/lists/${encodeURIComponent(currentItem.listId)}`)">Edit item</button><button class="text-button danger-text" @click="removeItem(currentItem)">Delete item</button></div></template><p v-else>This item could not be found.</p>
        </section>
        <section v-else class="message-card"><h1>Page not found</h1><a href="/" @click="followRoute($event, '/')">Go to home</a></section>
      </template>
    </main>
  </div>
</template>
