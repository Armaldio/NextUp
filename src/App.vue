<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IndexedDbDriver, LocalDataRepository, StorageError } from './domain/storage.ts'
import type { AppData, Item, ItemDate, ListMode } from './domain/model.ts'
import { createId } from './domain/id.ts'
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
const activeItems = computed(() => data.value?.items.filter((item) => item.listId === activeList.value?.id).sort((a, b) => a.position - b.position) ?? [])
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
const recentImageUrls = ref(new Map<string, string>())
const failedRecentImages = ref(new Set<string>())
let recentPreviewRun = 0
const itemError = ref('')
const stageTitle = ref('')
const stageError = ref('')
const stageRemoval = ref<string | null>(null)
const stageDestination = ref<string | null>(null)
const itemFormOpen = ref(false)
const editingItemId = ref<string | null>(null)
const maxImageBytes = 5 * 1024 * 1024
const statusForItem = (item: Item) => data.value?.statuses.find((status) => status.id === item.statusId)?.title ?? ''
function detailPath(item: Item): string { return `/lists/${encodeURIComponent(item.listId)}/items/${encodeURIComponent(item.id)}` }
function clearItemForm(): void { itemFormOpen.value = false; editingItemId.value = null; itemTitle.value = ''; itemNotes.value = ''; itemLink.value = ''; itemStatusId.value = null; itemDateKind.value = 'none'; itemDateValue.value = ''; itemImageId.value = null; itemImage.value = null; itemError.value = '' }
function editItem(item?: Item): void {
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
  if (!activeList.value || !data.value || !itemTitle.value.trim()) return
  itemError.value = ''; saving.value = true
  const list = activeList.value
  const date: ItemDate | undefined = itemDateKind.value === 'none' ? undefined : { kind: itemDateKind.value, value: itemDateValue.value }
  const item: Item = { id: editingItemId.value ?? createId(), listId: list.id, title: itemTitle.value.trim(), notes: itemNotes.value, imageId: itemImageId.value, externalUrl: itemLink.value.trim() || null, ...(date ? { date } : {}), statusId: list.mode === 'status' ? itemStatusId.value : null, position: editingItemId.value ? data.value.items.find((entry) => entry.id === editingItemId.value)?.position ?? 0 : Math.max(-1, ...activeItems.value.map((entry) => entry.position)) + 1 }
  try { await repository.saveItem(item, itemImage.value ?? undefined); data.value = await repository.load(); clearItemForm() }
  catch (error) { itemError.value = error instanceof Error ? error.message : 'Item could not be saved.' }
  finally { saving.value = false }
}
async function removeItem(item: Item): Promise<void> {
  if (!window.confirm(`Delete “${item.title}”? This also removes its image if no other item uses it.`)) return
  try { await repository.deleteItem(item.id); data.value = await repository.load(); if (route.value.name === 'item-detail') navigate(`/lists/${encodeURIComponent(item.listId)}`) }
  catch (error) { itemError.value = error instanceof Error ? error.message : 'Item could not be deleted.' }
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
function clearRecentImageUrls(): void {
  for (const url of recentImageUrls.value.values()) URL.revokeObjectURL(url)
  recentImageUrls.value = new Map()
}
async function loadRecentImagePreviews(): Promise<void> {
  const run = ++recentPreviewRun
  clearRecentImageUrls()
  failedRecentImages.value = new Set()
  if (route.value.name !== 'home' || !data.value) return
  const recentItems = data.value.items.slice(-5).reverse().filter((item) => item.imageId)
  const urls = new Map<string, string>()
  const failed = new Set<string>()
  await Promise.all(recentItems.map(async (item) => {
    try {
      const blob = item.imageId ? await repository.getImage(item.imageId) : undefined
      if (blob) urls.set(item.id, URL.createObjectURL(blob))
      else failed.add(item.id)
    } catch { failed.add(item.id) }
  }))
  if (run !== recentPreviewRun || route.value.name !== 'home') {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    return
  }
  recentImageUrls.value = urls
  failedRecentImages.value = failed
}
function failRecentImage(itemId: string, event: Event): void {
  const renderedUrl = (event.currentTarget as HTMLImageElement).getAttribute('src')
  const url = recentImageUrls.value.get(itemId)
  if (!url || renderedUrl !== url) return
  URL.revokeObjectURL(url)
  const urls = new Map(recentImageUrls.value)
  urls.delete(itemId)
  recentImageUrls.value = urls
  failedRecentImages.value = new Set([...failedRecentImages.value, itemId])
}
watch([currentItem, data, route], loadDetailImage)
watch([data, route], loadRecentImagePreviews)
onUnmounted(() => {
  if (itemImageUrl.value) URL.revokeObjectURL(itemImageUrl.value)
  recentPreviewRun += 1
  clearRecentImageUrls()
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
function cancelDelete(): void { deleting.value = null }
function openDelete(id: string, event: MouseEvent): void {
  deleteTrigger.value = event.currentTarget as HTMLButtonElement
  deleting.value = id
}
function followRoute(event: MouseEvent, path: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault(); navigate(path)
}
async function createList(): Promise<void> {
  if (!data.value || !title.value.trim()) return
  saving.value = true
  try {
    const id = createId()
    const list = { id, title: title.value.trim(), mode: mode.value, sortOrder: data.value.lists.length, icon: icon.value.trim() || null }
    const next: AppData = { ...data.value, lists: [...data.value.lists, list], statuses: mode.value === 'status' ? [...data.value.statuses, ...['Done', 'In progress', 'Up next'].map((name, order) => ({ id: createId(), listId: id, title: name, order }))] : data.value.statuses }
    await repository.save(next); data.value = next; title.value = ''; icon.value = ''; creating.value = false
  }
  catch (error) { loadError.value = error instanceof StorageError ? error.message : 'List could not be saved.' }
  finally { saving.value = false }
}
async function renameList(id: string, value: string): Promise<void> {
  if (!data.value || !value.trim()) return
  const next = { ...data.value, lists: data.value.lists.map((list) => list.id === id ? { ...list, title: value.trim() } : list) }
  try { await repository.save(next); data.value = next } catch (error) { loadError.value = error instanceof StorageError ? error.message : 'List could not be renamed.' }
}
async function deleteList(id: string): Promise<void> {
  if (!data.value) return
  try {
    await repository.deleteList(id)
    focusAfterDelete = true
    deleting.value = null
    await loadSavedData()
    await nextTick()
    listHeading.value?.focus()
  } catch (error) { loadError.value = error instanceof StorageError ? error.message : 'List could not be deleted.' }
  finally { focusAfterDelete = false }
}
const activeStatuses = computed(() => activeList.value && data.value ? data.value.statuses.filter((status) => status.listId === activeList.value!.id).sort((a, b) => a.order - b.order) : [])
async function addStage(): Promise<void> {
  if (!activeList.value || !data.value || !stageTitle.value.trim()) return
  stageError.value = ''
  try {
    await repository.addStatus({ id: createId(), listId: activeList.value.id, title: stageTitle.value.trim(), order: activeStatuses.value.length })
    data.value = await repository.load(); stageTitle.value = ''
  } catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage could not be added.' }
}
async function renameStage(id: string, title: string): Promise<void> {
  if (!title.trim()) return
  stageError.value = ''
  try { await repository.renameStatus(id, title.trim()); data.value = await repository.load() }
  catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage could not be renamed.' }
}
async function moveStage(index: number, offset: number): Promise<void> {
  const status = activeStatuses.value[index]
  if (!status) return
  stageError.value = ''
  try { await repository.reorderStatus(status.id, index + offset); data.value = await repository.load() }
  catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage order could not be saved.' }
}
function requestRemoveStage(id: string): void {
  stageRemoval.value = id
  const hasItems = data.value?.items.some((item) => item.statusId === id) ?? false
  stageDestination.value = hasItems ? null : activeStatuses.value.find((status) => status.id !== id)?.id ?? null
}
const stageRemovalHasItems = computed(() => stageRemoval.value !== null && (data.value?.items.some((item) => item.statusId === stageRemoval.value) ?? false))
async function removeStage(): Promise<void> {
  if (!stageRemoval.value) return
  stageError.value = ''
  try {
    await repository.deleteStatus(stageRemoval.value, stageDestination.value)
    data.value = await repository.load(); stageRemoval.value = null
  } catch (error) { stageError.value = error instanceof Error ? error.message : 'Stage could not be removed.' }
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
          <div class="page-heading"><div><p class="eyebrow">Your workspace</p><h1 ref="listHeading" tabindex="-1">Your lists</h1><p class="quiet-count">{{ lists.length }} {{ lists.length === 1 ? 'list' : 'lists' }} saved on this device</p></div><button class="primary-button" @click="creating = !creating">{{ creating ? 'Close' : '＋ New list' }}</button></div>
          <form v-if="creating" class="list-form" @submit.prevent="createList">
            <h2>Create a list</h2>
            <label>List name<input v-model="title" required maxlength="100" autofocus placeholder="For example, Weekend plans"></label>
            <label>Mode<select v-model="mode"><option value="status">Manual</option><option value="date">Date</option></select></label>
            <p class="form-hint">{{ mode === 'status' ? 'Manual lists start with Done, In progress, and Up next stages. You can customize stages after creation.' : 'Date lists organize items by their dates and do not use statuses.' }} Mode cannot be changed after creation.</p>
            <label>Icon <span class="optional">(optional)</span><input v-model="icon" maxlength="8" placeholder="e.g. 📚" aria-label="Optional list icon"></label>
            <button class="primary-button" :disabled="saving || !title.trim()">Create list</button>
          </form>
          <div v-if="lists.length" class="list-grid"><article v-for="list in lists" :key="list.id" class="list-card">
            <a class="list-open" :href="`/lists/${encodeURIComponent(list.id)}`" @click="followRoute($event, `/lists/${encodeURIComponent(list.id)}`)"><span class="list-icon" aria-hidden="true">{{ list.icon || (list.mode === 'date' ? '◷' : '☷') }}</span><span><strong>{{ list.title }}</strong><small>{{ list.mode === 'date' ? 'Date list' : 'Manual list' }}</small></span></a>
            <div class="list-actions"><label class="sr-only" :for="`rename-${list.id}`">Rename {{ list.title }}</label><input :id="`rename-${list.id}`" :value="list.title" :aria-label="`Rename ${list.title}`" @change="renameList(list.id, ($event.target as HTMLInputElement).value)"><button class="text-button danger-text" :aria-label="`Delete ${list.title}`" @click="openDelete(list.id, $event)">Delete</button></div>
            <dialog v-if="deleting === list.id" ref="deleteDialog" class="confirm-box" :aria-labelledby="`delete-title-${list.id}`" @cancel.prevent="cancelDelete"><h2 :id="`delete-title-${list.id}`">Delete “{{ list.title }}”?</h2><p>This permanently deletes this list, its {{ data!.items.filter((item) => item.listId === list.id).length }} items, their images when not shared with another list, and its statuses.</p><div><button type="button" class="text-button" data-dialog-cancel @click="cancelDelete">Cancel</button><button type="button" class="text-button danger-text" @click="deleteList(list.id)">Delete list</button></div></dialog>
          </article></div>
          <section v-if="data!.items.length" class="home-items"><h2>Recent items</h2><a v-for="item in data!.items.slice(-5).reverse()" :key="item.id" class="recent-item" :href="detailPath(item)" @click="followRoute($event, detailPath(item))"><img v-if="item.imageId && recentImageUrls.has(item.id)" class="recent-item-image" :src="recentImageUrls.get(item.id)" :alt="`Image attached to ${item.title}`" @error.prevent="failRecentImage(item.id, $event)"><span v-else class="recent-item-fallback" aria-hidden="true">{{ item.imageId && failedRecentImages.has(item.id) ? 'Image unavailable' : item.imageId ? 'Loading image…' : 'No image' }}</span><span class="recent-item-text"><strong>{{ item.title }}</strong><small>{{ data!.lists.find((list) => list.id === item.listId)?.title }}</small></span></a></section>
          <section v-if="!creating && lists.length === 0" class="message-card empty-state"><span class="empty-mark" aria-hidden="true">＋</span><h2>Start with a list</h2><p>Create a manual list for flexible stages or a date list for things tied to a day.</p><button class="primary-button" @click="creating = true">Create your first list</button></section>
        </section>
        <section v-else-if="route.name === 'list-detail'" class="lists-page">
          <a class="back-link" href="/" @click="followRoute($event, '/')">← All lists</a>
          <template v-if="activeList"><div class="page-heading"><div><p class="eyebrow">{{ activeList.mode === 'date' ? 'Date list' : 'Manual list' }}</p><h1>{{ activeList.icon }} {{ activeList.title }}</h1></div><button class="primary-button" @click="editItem()">＋ New item</button></div>
            <section v-if="activeList.mode === 'status'" class="stage-editor" aria-labelledby="stage-heading">
              <h2 id="stage-heading">Stages</h2>
              <p class="form-hint">Customize the stages for this manual list. Items keep their list order when stages change.</p>
              <ol class="stage-list"><li v-for="(status, index) in activeStatuses" :key="status.id">
                <label :for="`stage-${status.id}`">Stage {{ index + 1 }}</label>
                <input :id="`stage-${status.id}`" :value="status.title" maxlength="100" :aria-label="`Rename stage ${status.title}`" @change="renameStage(status.id, ($event.target as HTMLInputElement).value)">
                <button type="button" class="text-button" :disabled="index === 0" :aria-label="`Move ${status.title} up`" @click="moveStage(index, -1)">↑</button>
                <button type="button" class="text-button" :disabled="index === activeStatuses.length - 1" :aria-label="`Move ${status.title} down`" @click="moveStage(index, 1)">↓</button>
                <button type="button" class="text-button danger-text" :disabled="activeStatuses.length <= 1" :aria-label="`Remove ${status.title}`" @click="requestRemoveStage(status.id)">Remove</button>
              </li></ol>
              <form class="stage-add" @submit.prevent="addStage"><label for="new-stage">Add a stage</label><input id="new-stage" v-model="stageTitle" maxlength="100" placeholder="Stage name"><button class="text-button" :disabled="!stageTitle.trim()">Add stage</button></form>
              <p v-if="stageError" class="error-text" role="alert">{{ stageError }}</p>
              <div v-if="stageRemoval" class="stage-remove-prompt" role="group" aria-label="Remove stage">
                <p v-if="stageRemovalHasItems">Move items from “{{ activeStatuses.find((status) => status.id === stageRemoval)?.title }}” to another stage before removing it.</p>
                <p v-else>Remove “{{ activeStatuses.find((status) => status.id === stageRemoval)?.title }}”?</p>
                <label v-if="stageRemovalHasItems">Move items to<select v-model="stageDestination"><option disabled :value="null">Choose a destination</option><option v-for="status in activeStatuses.filter((entry) => entry.id !== stageRemoval)" :key="status.id" :value="status.id">{{ status.title }}</option></select></label>
                <div class="form-actions"><button type="button" class="text-button" @click="stageRemoval = null">Cancel</button><button type="button" class="text-button danger-text" :disabled="stageRemovalHasItems && !stageDestination" @click="removeStage">Remove stage</button></div>
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
              <p v-if="itemError" class="error-text" role="alert">{{ itemError }}</p><div class="form-actions"><button type="button" class="text-button" @click="clearItemForm">Cancel</button><button class="primary-button" :disabled="saving || !itemTitle.trim()">Save item</button></div>
            </form>
            <div v-if="activeItems.length" class="list-grid"><article v-for="item in activeItems" :key="item.id" class="list-card"><a class="item-open" :href="detailPath(item)" @click="followRoute($event, detailPath(item))"><strong>{{ item.title }}</strong><small v-if="item.statusId">{{ statusForItem(item) }}</small><small v-if="item.date">{{ item.date.value }} <span>{{ item.date.kind === 'date-only' ? 'date only' : 'local time' }}</span></small></a><div class="list-actions"><button class="text-button" @click="editItem(item)">Edit</button><button class="text-button danger-text" @click="removeItem(item)">Delete</button></div></article></div>
            <p v-else-if="!editingItemId" class="quiet-count">No items yet. Add one to get started.</p>
          </template><p v-else class="message-card">This list could not be found.</p>
        </section>
        <section v-else-if="route.name === 'item-detail'" class="message-card">
          <a class="back-link" :href="`/lists/${encodeURIComponent(route.listId)}`" @click="followRoute($event, `/lists/${encodeURIComponent(route.listId)}`)">← Back to list</a>
          <template v-if="currentItem"><p class="eyebrow">{{ activeList?.title ?? 'Item' }}</p><h1>{{ currentItem.title }}</h1><p v-if="currentItem.statusId" class="item-meta">{{ statusForItem(currentItem) }}</p><p v-if="currentItem.date" class="item-meta">{{ currentItem.date.value }} · {{ currentItem.date.kind === 'date-only' ? 'Date only' : 'Local date and time' }}</p><p v-if="currentItem.notes" class="item-notes">{{ currentItem.notes }}</p><p v-if="currentItem.externalUrl"><a :href="currentItem.externalUrl" target="_blank" rel="noopener noreferrer">Open external link</a></p><img v-if="currentItem.imageId && itemImageUrl" class="item-image" :src="itemImageUrl" :alt="`Image attached to ${currentItem.title}`"><p v-else-if="currentItem.imageId" class="form-hint" role="status">Image preview is unavailable, but the attachment remains saved.</p><div class="form-actions"><button class="primary-button" @click="editItem(currentItem); navigate(`/lists/${encodeURIComponent(currentItem.listId)}`)">Edit item</button><button class="text-button danger-text" @click="removeItem(currentItem)">Delete item</button></div></template><p v-else>This item could not be found.</p>
        </section>
        <section v-else class="message-card"><h1>Page not found</h1><a href="/" @click="followRoute($event, '/')">Go to home</a></section>
      </template>
    </main>
  </div>
</template>
