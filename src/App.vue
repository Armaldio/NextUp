<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { IndexedDbDriver, LocalDataRepository, StorageError } from './domain/storage.ts'
import type { AppData } from './domain/model.ts'
import { useAppRoute } from './router.ts'

const repository = new LocalDataRepository(new IndexedDbDriver())
const { route, navigate } = useAppRoute()
const data = ref<AppData | null>(null)
const loadError = ref('')
const isLoading = ref(true)

async function loadSavedData(): Promise<void> {
  isLoading.value = true
  loadError.value = ''
  try {
    data.value = await repository.load()
  } catch (error) {
    loadError.value = error instanceof StorageError ? error.message : 'Saved data could not be loaded.'
  } finally {
    isLoading.value = false
  }
}

function followRoute(event: MouseEvent, path: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(path)
}

onMounted(loadSavedData)
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <a class="brand" href="/" @click="followRoute($event, '/')">NextUp</a>
      <p class="storage-note">Saved on this device</p>
    </header>

    <main id="main-content" class="page-content">
      <section v-if="isLoading" class="message-card" aria-live="polite">
        <p>Opening your saved lists…</p>
      </section>

      <section v-else-if="loadError" class="message-card error-card" role="alert">
        <h1>Your saved data could not be opened</h1>
        <p>{{ loadError }}</p>
        <p>Your local data has not been cleared. Check browser storage access and try again.</p>
        <button type="button" @click="loadSavedData">Try again</button>
      </section>

      <template v-else>
        <section v-if="route.name === 'home'" class="message-card">
          <p class="eyebrow">Your workspace</p>
          <h1>Lists will live here</h1>
          <p>This local app shell is ready for your lists.</p>
          <p class="quiet-count">{{ data?.lists.length ?? 0 }} lists saved on this device</p>
        </section>

        <section v-else-if="route.name === 'list-detail'" class="message-card">
          <a class="back-link" href="/" @click="followRoute($event, '/')">← All lists</a>
          <p class="eyebrow">List</p>
          <h1>List detail</h1>
          <p>List <code>{{ route.listId }}</code> is ready for its detail view.</p>
        </section>

        <section v-else-if="route.name === 'item-detail'" class="message-card">
          <a class="back-link" :href="`/lists/${encodeURIComponent(route.listId)}`" @click="followRoute($event, `/lists/${encodeURIComponent(route.listId)}`)">← Back to list</a>
          <p class="eyebrow">Item</p>
          <h1>Item detail</h1>
          <p>Item <code>{{ route.itemId }}</code> in list <code>{{ route.listId }}</code> is ready for its detail view.</p>
        </section>

        <section v-else class="message-card">
          <h1>Page not found</h1>
          <a href="/" @click="followRoute($event, '/')">Go to home</a>
        </section>
      </template>
    </main>
  </div>
</template>
