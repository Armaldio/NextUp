import { onMounted, onUnmounted, ref } from 'vue'

export type AppRoute =
  | { name: 'home' }
  | { name: 'list-detail'; listId: string }
  | { name: 'item-detail'; listId: string; itemId: string }
  | { name: 'not-found' }

export function parseRoute(pathname: string): AppRoute {
  const segments = pathname.split('/').filter(Boolean).map(decodeSegment)
  if (segments.some((segment) => segment === null)) return { name: 'not-found' }
  const parts = segments as string[]
  if (parts.length === 0) return { name: 'home' }
  if (parts[0] === 'lists' && parts.length === 2) return { name: 'list-detail', listId: parts[1] }
  if (parts[0] === 'lists' && parts.length === 4 && parts[2] === 'items') {
    return { name: 'item-detail', listId: parts[1], itemId: parts[3] }
  }
  return { name: 'not-found' }
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function useAppRoute() {
  const route = ref(parseRoute(window.location.pathname))
  const update = () => { route.value = parseRoute(window.location.pathname) }

  onMounted(() => window.addEventListener('popstate', update))
  onUnmounted(() => window.removeEventListener('popstate', update))

  function navigate(path: string): void {
    window.history.pushState({}, '', path)
    update()
  }

  return { route, navigate }
}
