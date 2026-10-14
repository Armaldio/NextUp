import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { deflateSync } from 'node:zlib'

const root = process.cwd()
const screenshotDir = resolve(root, 'docs/screenshots')
const profileDir = await mkdtemp(join(tmpdir(), 'nextup-next-9-chrome-'))
const imagePath = join(profileDir, 'e2e-cover.png')
const errors = []
const CDP_COMMAND_TIMEOUT_MS = 10_000
const CDP_EVENT_TIMEOUT_MS = 15_000
const UI_WAIT_TIMEOUT_MS = 12_000
let vite
let chrome
let client
let commandId = 0
let transportFailure
const pending = new Map()
const eventWaiters = new Map()

function check(condition, message) {
  if (!condition) errors.push(message)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function waitFor(url, label, child) {
  const deadline = Date.now() + CDP_COMMAND_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child?.spawnFailure) throw new Error(`${label} failed to start`, { cause: child.spawnFailure })
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch { /* Vite is still starting. */ }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`${label} did not start at ${url}`)
}

async function navigate(url) {
  const loaded = waitForEvent('Page.loadEventFired')
  const navigation = send('Page.navigate', { url })
  const [result] = await Promise.all([navigation, loaded])
  if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
}

async function reloadPage() {
  const loaded = waitForEvent('Page.loadEventFired')
  await Promise.all([send('Page.reload'), loaded])
}

function failTransport(error) {
  if (transportFailure) return
  transportFailure = error instanceof Error ? error : new Error(String(error))
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(transportFailure)
    pending.delete(id)
  }
  for (const [method, entry] of eventWaiters) {
    clearTimeout(entry.timer)
    entry.reject(transportFailure)
    eventWaiters.delete(method)
  }
}

function send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  if (transportFailure) return Promise.reject(transportFailure)
  if (!client || client.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Cannot send CDP ${method}: WebSocket is not open`))
  }
  const id = ++commandId
  return new Promise((resolveCommand, rejectCommand) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectCommand(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer })
    try {
      client.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      rejectCommand(error)
    }
  })
}

function waitForEvent(method, timeoutMs = CDP_EVENT_TIMEOUT_MS) {
  if (transportFailure) return Promise.reject(transportFailure)
  if (eventWaiters.has(method)) return Promise.reject(new Error(`Already waiting for CDP event ${method}`))
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      eventWaiters.delete(method)
      rejectEvent(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    eventWaiters.set(method, { resolve: resolveEvent, reject: rejectEvent, timer })
  })
}

function waitForSocketOpen(socket, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolveOpen, rejectOpen) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('error', onError)
    }
    const onOpen = () => { cleanup(); resolveOpen() }
    const onClose = () => { cleanup(); rejectOpen(new Error('Chromium CDP WebSocket closed before opening')) }
    const onError = () => { cleanup(); rejectOpen(new Error('Chromium CDP WebSocket failed before opening')) }
    const timer = setTimeout(() => {
      cleanup()
      rejectOpen(new Error(`Chromium CDP WebSocket did not open within ${timeoutMs}ms`))
    }, timeoutMs)
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('close', onClose, { once: true })
    socket.addEventListener('error', onError, { once: true })
  })
}

async function assertAxControls(expected, label) {
  const { nodes } = await send('Accessibility.getFullAXTree')
  const controls = nodes
    .filter((node) => !node.ignored)
    .map((node) => ({ role: node.role?.value ?? '', name: node.name?.value ?? '' }))
  for (const { role, name } of expected) {
    assert(controls.some((control) => control.role === role && control.name === name),
      `${label} AX tree is missing ${role} named ${JSON.stringify(name)}; found: ${JSON.stringify(controls.filter((entry) => entry.role === role))}`)
  }
  console.log(`AX tree ${label}:`, JSON.stringify(expected))
}

async function evaluate(expression, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed')
  return result.result?.value
}

async function waitUntil(expression, label) {
  const deadline = Date.now() + UI_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (await evaluate(expression, Math.min(CDP_COMMAND_TIMEOUT_MS, remaining))) return
    await delay(Math.min(100, Math.max(0, deadline - Date.now())))
  }
  const diagnostic = label === 'manual item reorder'
    ? await evaluate(`([...document.querySelectorAll('.manual-stage')].map((stage) => ({ stage: stage.querySelector('h3').textContent, items: [...stage.querySelectorAll('.manual-item-card .item-open strong')].map((e) => e.textContent), disabled: [...stage.querySelectorAll('.manual-item-card button')].map((e) => ({ label: e.getAttribute('aria-label'), disabled: e.disabled })) })))`, Math.max(1, deadline - Date.now())).catch(() => undefined)
    : label === 'keyboard item reorder alternative'
      ? await evaluate(`({ active: document.activeElement.getAttribute('aria-label'), items: [...document.querySelectorAll('.manual-stage')].map((stage) => ({ stage: stage.querySelector('h3').textContent, items: [...stage.querySelectorAll('.manual-item-card .item-open strong')].map((e) => e.textContent) })) })`, Math.max(1, deadline - Date.now())).catch(() => undefined)
    : undefined
  throw new Error(`Timed out waiting for ${label}${diagnostic ? `: ${JSON.stringify(diagnostic)}` : ''}`)
}

async function click(selector) {
  const rect = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; let r = e.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) { e.scrollIntoView({ block: 'center', inline: 'nearest' }); r = e.getBoundingClientRect(); } return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: e.disabled }; })()`)
  assert(rect, `Could not find clickable element: ${selector}`)
  assert(!rect.disabled, `Element is disabled: ${selector} (${JSON.stringify(rect)})`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

async function clickText(text, scope = 'body') {
  const selector = await evaluate(`(() => { document.querySelectorAll('[data-e2e-target="true"]').forEach((e) => e.removeAttribute('data-e2e-target')); const root = document.querySelector(${JSON.stringify(scope)}); const e = [...root.querySelectorAll('button,a')].find((n) => n.textContent.trim() === ${JSON.stringify(text)}); if (!e) return null; e.setAttribute('data-e2e-target', 'true'); return '[data-e2e-target="true"]'; })()`)
  assert(selector, `Could not find button or link named: ${text}`)
  await click(selector)
}

async function clickItemAction(itemTitle, action) {
  const selector = await evaluate(`(() => { document.querySelectorAll('[data-e2e-target="true"]').forEach((e) => e.removeAttribute('data-e2e-target')); const card = [...document.querySelectorAll('.date-item-section article')].find((entry) => entry.querySelector('.item-open strong')?.textContent === ${JSON.stringify(itemTitle)}); const button = [...(card?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent.trim() === ${JSON.stringify(action)}); if (!button) return null; button.setAttribute('data-e2e-target', 'true'); return '[data-e2e-target="true"]'; })()`)
  assert(selector, `Could not find ${action} action for ${itemTitle}`)
  await click(selector)
}

async function fill(selector, value) {
  await click(selector)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  await send('Input.insertText', { text: value })
}

async function choose(selector, label) {
  const selection = await evaluate(`(() => { const selects = [...document.querySelectorAll(${JSON.stringify(selector)})]; const index = selects.findIndex((select) => [...select.options].some((entry) => entry.textContent.trim() === ${JSON.stringify(label)})); if (index < 0) return null; const option = [...selects[index].options].find((entry) => entry.textContent.trim() === ${JSON.stringify(label)}); return { index, value: option.value }; })()`)
  assert(selection, `Option not found: ${label} in ${selector}`)
  await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})][${selection.index}]; e.value = ${JSON.stringify(selection.value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`)
}

async function upload(selector, path) {
  const doc = await send('DOM.getDocument', { depth: -1 })
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  assert(found.nodeId, `File input not found: ${selector}`)
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path] })
}

async function press(key, code, windowsVirtualKeyCode) {
  if (key === 'Enter') {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
    await send('Input.dispatchKeyEvent', { type: 'char', key, code, text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
    return
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
}

async function saveScreenshot(name, width, height) {
  await mkdir(screenshotDir, { recursive: true })
  const pageHeight = await evaluate('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight)')
  const clip = { x: 0, y: 0, width, height: Math.min(pageHeight, 2200), scale: 1 }
  await evaluate(`(() => { const style = document.createElement('style'); style.dataset.e2eCaptureFont = 'true'; style.textContent = '* { font-family: Arial, Helvetica, "Liberation Sans", sans-serif !important; }'; document.head.append(style); })()`)
  try {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
    await writeFile(join(screenshotDir, name), Buffer.from(result.data, 'base64'))
  } finally {
    await evaluate(`document.querySelector('style[data-e2e-capture-font]')?.remove()`)
  }
  console.log(`screenshot: docs/screenshots/${name} (${width}x${clip.height})`)
}

async function viewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, ...(mobile ? { maxTouchPoints: 1 } : {}) })
  await delay(150)
}

async function createList(name, mode) {
  await clickText('＋ New list')
  await fill('input[placeholder="For example, Weekend plans"]', name)
  await choose('form.list-form select', mode === 'date' ? 'Date' : 'Manual')
  await clickText('Create list', 'form.list-form')
  await waitUntil(`[...document.querySelectorAll('.list-card .list-open strong')].some((entry) => entry.textContent === ${JSON.stringify(name)})`, `${name} created`)
  const selector = await evaluate(`(() => { document.querySelectorAll('[data-e2e-target="true"]').forEach((e) => e.removeAttribute('data-e2e-target')); const link = [...document.querySelectorAll('.list-card .list-open')].find((entry) => entry.querySelector('strong')?.textContent === ${JSON.stringify(name)}); if (!link) return null; link.setAttribute('data-e2e-target', 'true'); return '[data-e2e-target="true"]'; })()`)
  assert(selector, `Could not open list: ${name}`)
  await click(selector)
  await waitUntil(`document.querySelector('h1')?.textContent.includes(${JSON.stringify(name)})`, `${name} detail page`)
}

async function addItem({ title, status, date, image = false }) {
  await clickText('＋ New item')
  await fill('form.list-form input[required][maxlength="200"]', title)
  if (status) await choose('form.list-form select', status)
  if (date) {
    await choose('form.list-form select', date.kind === 'date-only' ? 'Date only' : 'Date and time')
    await evaluate(`(() => { const input = document.querySelector('form.list-form input[type="${date.kind === 'date-only' ? 'date' : 'datetime-local'}"]'); input.value = ${JSON.stringify(date.value)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  }
  if (image) await upload('form.list-form input[type="file"]', imagePath)
  await clickText('Save item', 'form.list-form')
  await waitUntil(`!document.querySelector('form.list-form')`, `${title} save`)
}

async function setTextAndChange(selector, value) {
  await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  if (selector.includes('Rename stage')) await waitUntil(`!document.querySelector('.stage-list input:disabled')`, `saving stage rename to ${value}`)
}

async function start() {
  const vitePort = await freePort()
  const chromePort = await freePort()
  const appUrl = `http://127.0.0.1:${vitePort}`
  vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.on('error', (error) => { vite.spawnFailure = error })
  vite.stderr.on('data', (chunk) => process.stderr.write(chunk))
  await waitFor(appUrl, 'Vite', vite)

  chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${chromePort}`,
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.on('error', (error) => { chrome.spawnFailure = error })
  chrome.stderr.on('data', () => {})
  await waitFor(`http://127.0.0.1:${chromePort}/json/version`, 'local Chromium', chrome)
  const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  assert(page?.webSocketDebuggerUrl, 'Could not find a Chromium page target')
  client = new WebSocket(page.webSocketDebuggerUrl)
  client.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      const waiter = eventWaiters.get(message.method)
      if (waiter) {
        clearTimeout(waiter.timer)
        eventWaiters.delete(message.method)
        waiter.resolve(message.params)
      }
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  client.addEventListener('close', () => failTransport(new Error('Chromium CDP WebSocket closed')))
  client.addEventListener('error', () => failTransport(new Error('Chromium CDP WebSocket error')))
  await waitForSocketOpen(client)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Accessibility.enable')
  await navigate(appUrl)
  await waitUntil(`document.querySelector('h1')?.textContent.includes('Your lists')`, 'home screen')
  assert(await evaluate(`!!document.querySelector('.empty-state')`), 'Empty home state is not shown when no lists exist')

  const png = makePng()
  await writeFile(imagePath, png)
  await viewport(390, 844, true)
  await saveScreenshot('nextup-home.png', 390, 844)

  await createList('Manual QA', 'manual')
  const originalStages = await evaluate('[...document.querySelectorAll(".stage-list input")].map((e) => e.value)')
  assert(JSON.stringify(originalStages) === JSON.stringify(['Done', 'In progress', 'Up next']), 'Manual list did not start with its three default stages')
  await addItem({ title: 'Moonrise', status: 'Up next', image: true })
  await addItem({ title: 'Riverside', status: 'Up next' })
  await addItem({ title: 'North Star', status: 'Up next' })
  await setTextAndChange('input[aria-label="Rename stage In progress"]', 'Doing')
  await setTextAndChange('input[aria-label="Rename stage Up next"]', 'Soon')
  await click('button[aria-label="Move Doing down"]')
  await waitUntil(`JSON.stringify([...document.querySelectorAll('.stage-list input')].map((e) => e.value)) === '["Done","Soon","Doing"]'`, 'manual stage reorder')
  const manualItemOrders = await evaluate('[...document.querySelectorAll(".manual-stage")].map((stage) => ({ stage: stage.querySelector("h3").textContent, items: [...stage.querySelectorAll(".manual-item-card .item-open strong")].map((e) => e.textContent) }))')
  assert(JSON.stringify(manualItemOrders.find((stage) => stage.stage === 'Soon')?.items) === JSON.stringify(['Moonrise', 'Riverside', 'North Star']), 'Manual items were not added in the expected stage/order')
  await click('button[aria-label="Move Riverside later in Soon"]')
  await waitUntil(`(() => { const stage = [...document.querySelectorAll('.manual-stage')].find((entry) => entry.querySelector('h3').textContent === 'Soon'); return JSON.stringify(stage ? [...stage.querySelectorAll('.manual-item-card .item-open strong')].map((e) => e.textContent) : []) === '["Moonrise","North Star","Riverside"]'; })()`, 'manual item reorder')
  await click('button[aria-label="Move Doing up"]')
  await waitUntil(`JSON.stringify([...document.querySelectorAll('.stage-list input')].map((e) => e.value)) === '["Done","Doing","Soon"]'`, 'manual stage reorder back')
  const stageOrder = await evaluate('[...document.querySelectorAll(".stage-list input")].map((e) => e.value)')
  assert(JSON.stringify(stageOrder) === JSON.stringify(['Done', 'Doing', 'Soon']), 'Manual stages could not be reordered')
  await saveScreenshot('nextup-list.png', 390, 844)
  await reloadPage()
  await waitUntil(`document.querySelectorAll('.manual-item-card').length === 3`, 'manual list after reload')
  const manualAfterReload = await evaluate(`({ stages: [...document.querySelectorAll('.stage-list input')].map((e) => e.value), items: [...document.querySelectorAll('.manual-stage')].map((s) => ({ stage: s.querySelector('h3').textContent, items: [...s.querySelectorAll('.manual-item-card .item-open strong')].map((e) => e.textContent) })) })`)
  assert(JSON.stringify(manualAfterReload.stages) === JSON.stringify(['Done', 'Doing', 'Soon']), 'Manual stage order did not persist across reload')
  assert(JSON.stringify(manualAfterReload.items.find((stage) => stage.stage === 'Soon')?.items) === JSON.stringify(['Moonrise', 'North Star', 'Riverside']), 'Manual item order did not persist across reload')
  await clickText('Moonrise')
  await waitUntil(`document.querySelector('.item-image')?.naturalWidth > 0`, 'persisted image detail')
  const imageAfterReload = await evaluate(`({ width: document.querySelector('.item-image')?.naturalWidth, alt: document.querySelector('.item-image')?.alt })`)
  assert(imageAfterReload.width > 0 && imageAfterReload.alt === 'Image attached to Moonrise', 'Image did not persist with accessible alternative text')
  await saveScreenshot('nextup-item.png', 390, 844)
  await clickText('← Back to list')
  await waitUntil(`document.querySelector('.stage-editor')`, 'manual list route')

  const touchMetrics = await evaluate(`([...document.querySelectorAll('.stage-list input, .stage-list button, .stage-add input, .stage-add button, .manual-item-card button')].filter((e) => !e.disabled).map((e) => ({ label: e.getAttribute('aria-label') || e.labels?.[0]?.textContent.trim() || e.textContent.trim(), width: Math.round(e.getBoundingClientRect().width), height: Math.round(e.getBoundingClientRect().height) })))`)
  for (const target of touchMetrics.filter((entry) => entry.width < 44 || entry.height < 44)) check(false, `Touch target below 44px: ${target.label} (${target.width}x${target.height})`)
  const keyboardOrder = []
  await evaluate('document.activeElement.blur()')
  for (let index = 0; index < 14; index += 1) {
    await press('Tab', 'Tab', 9)
    keyboardOrder.push(await evaluate(`({ tag: document.activeElement.tagName, name: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim().slice(0, 30), outline: getComputedStyle(document.activeElement).outlineStyle, outlineWidth: getComputedStyle(document.activeElement).outlineWidth })`))
  }
  assert(keyboardOrder.some((entry) => entry.name.includes('New item')), 'Keyboard tab order skipped the New item action')
  assert(keyboardOrder.some((entry) => entry.outline === 'solid' && entry.outlineWidth !== '0px'), 'Visible keyboard focus was not shown')
  assert(await evaluate(`!!document.querySelector('button[aria-label="Move North Star later in Soon"]')`), 'Accessible keyboard reorder control is missing')
  let keyboardReorderFocused = false
  for (let index = 0; index < 40; index += 1) {
    if (await evaluate(`document.activeElement.getAttribute('aria-label') === 'Move North Star later in Soon'`)) { keyboardReorderFocused = true; break }
    await press('Tab', 'Tab', 9)
  }
  assert(keyboardReorderFocused, 'Keyboard tab order did not reach the item reorder alternative')
  await assertAxControls([
    { role: 'button', name: '＋ New item' },
    { role: 'textbox', name: 'Rename stage Doing' },
    { role: 'button', name: 'Move North Star later in Soon' },
    { role: 'link', name: 'Moonrise' },
  ], 'manual list')
  await press('Enter', 'Enter', 13)
  await waitUntil(`(() => { const stage = [...document.querySelectorAll('.manual-stage')].find((entry) => entry.querySelector('h3').textContent === 'Soon'); return JSON.stringify(stage ? [...stage.querySelectorAll('.manual-item-card .item-open strong')].map((e) => e.textContent) : []) === '["Moonrise","Riverside","North Star"]'; })()`, 'keyboard item reorder alternative')

  await saveScreenshot('nextup-list.png', 390, 844)
  await viewport(1280, 900, false)
  const manualColumns = await evaluate(`([...document.querySelectorAll('.manual-stage .list-grid')].map((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length))`)
  assert(manualColumns.every((columns) => columns <= 1), 'Manual list route rendered unwanted Kanban columns')
  await saveScreenshot('nextup-list-desktop.png', 1280, 900)

  await viewport(390, 844, true)
  await navigate(appUrl)
  await waitUntil(`document.querySelector('.home-list-rail')`, 'home route after desktop resize')
  const railMetrics = await evaluate(`([...document.querySelectorAll('.home-item-rail')].map((rail) => ({ name: rail.getAttribute('aria-label'), scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth, touchAction: getComputedStyle(rail).touchAction })))`)
  assert(railMetrics.some((rail) => rail.scrollWidth > rail.clientWidth && rail.touchAction.includes('pan-x')), 'Home item rail is not horizontally scrollable')
  assert(!(await evaluate(`document.querySelector('.manual-stage')`)), 'Home route incorrectly retained manual Kanban stages')
  const swipePoint = await evaluate(`(() => { const rail = document.querySelector('.home-item-rail'); rail.scrollLeft = 0; const r = rail.getBoundingClientRect(); return { x: Math.min(r.right - 20, innerWidth - 20), y: r.top + r.height / 2, before: rail.scrollLeft }; })()`)
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: swipePoint.x, y: swipePoint.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipePoint.x - 120, y: swipePoint.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await waitUntil(`document.querySelector('.home-item-rail')?.scrollLeft > 0`, 'horizontal rail touch swipe')
  await saveScreenshot('nextup-home.png', 390, 844)
  await viewport(1280, 900, false)
  await saveScreenshot('nextup-home-desktop.png', 1280, 900)

  await createList('Date QA', 'date')
  await addItem({ title: 'Later date', date: { kind: 'date-only', value: '2027-06-15' } })
  await addItem({ title: 'Undated one' })
  await addItem({ title: 'Earlier date', date: { kind: 'date-only', value: '2027-02-10' } })
  await addItem({ title: 'Undated two' })
  await addItem({ title: 'Timed entry', date: { kind: 'local-date-time', value: '2027-02-10T08:30' } })
  const dateBefore = await evaluate(`[...document.querySelectorAll('.date-item-section')].map((section) => ({ name: section.querySelector('h3').textContent, items: [...section.querySelectorAll('.item-open strong')].map((e) => e.textContent) }))`)
  assert(JSON.stringify(dateBefore.find((section) => section.name === 'Dated')?.items) === JSON.stringify(['Earlier date', 'Timed entry', 'Later date']), 'Dated items were not chronological')
  assert(JSON.stringify(dateBefore.find((section) => section.name === 'Undated')?.items) === JSON.stringify(['Undated one', 'Undated two']), 'Undated items were not in their own section')
  const reorderCounts = await evaluate(`([...document.querySelectorAll('.date-item-section')].map((section) => ({ section: section.querySelector('h3').textContent, items: [...section.querySelectorAll('article')].map((card) => ({ title: card.querySelector('.item-open strong').textContent, reorder: [...card.querySelectorAll('button[aria-label*="among undated"]')].length })) })))`)
  console.log('date reorder controls:', JSON.stringify(reorderCounts))
  assert(reorderCounts.find((section) => section.section === 'Dated')?.items.every((entry) => entry.reorder === 0), 'A dated item unexpectedly has manual reorder controls')
  assert(reorderCounts.find((section) => section.section === 'Undated')?.items.every((entry) => entry.reorder === 2), 'Undated items do not have both reorder controls')
  await assertAxControls([
    { role: 'button', name: '＋ New item' },
    { role: 'button', name: 'Move Undated two earlier among undated items' },
    { role: 'link', name: 'Undated one No date' },
  ], 'date list')
  const dateTouchMetrics = await evaluate(`([...document.querySelectorAll('.date-item-section button')].filter((e) => !e.disabled).map((e) => ({ label: e.getAttribute('aria-label') || e.textContent.trim(), width: Math.round(e.getBoundingClientRect().width), height: Math.round(e.getBoundingClientRect().height) })))`)
  for (const target of dateTouchMetrics.filter((entry) => entry.width < 44 || entry.height < 44)) check(false, `Date-list touch target below 44px: ${target.label} (${target.width}x${target.height})`)
  await click('button[aria-label="Move Undated two earlier among undated items"]')
  await waitUntil(`JSON.stringify([...document.querySelectorAll('.date-item-section')[1].querySelectorAll('.item-open strong')].map((e) => e.textContent)) === '["Undated two","Undated one"]'`, 'undated item reorder')
  await clickItemAction('Later date', 'Edit')
  await assertAxControls([
    { role: 'textbox', name: 'Title' },
    { role: 'combobox', name: 'Date' },
    { role: 'button', name: 'Save item' },
  ], 'date item edit form')
  await choose('form.list-form select', 'Date only')
  await evaluate(`(() => { const input = document.querySelector('form.list-form input[type="date"]'); input.value = '2027-01-01'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await clickText('Save item', 'form.list-form')
  await waitUntil(`!document.querySelector('form.list-form')`, 'date change save')
  const changedDates = await evaluate(`[...document.querySelectorAll('.date-item-section')[0].querySelectorAll('.item-open strong')].map((e) => e.textContent)`)
  console.log('dated order after change:', JSON.stringify(changedDates))
  assert(JSON.stringify(changedDates) === JSON.stringify(['Later date', 'Earlier date', 'Timed entry']), 'Changing an item date did not update chronological order')
  await saveScreenshot('nextup-date-list.png', 1280, 900)
  await reloadPage()
  await waitUntil(`document.querySelectorAll('.date-item-section article').length === 5`, 'date list after reload')
  const dateAfterReload = await evaluate(`[...document.querySelectorAll('.date-item-section')].map((section) => ({ name: section.querySelector('h3').textContent, items: [...section.querySelectorAll('.item-open strong')].map((e) => e.textContent) }))`)
  assert(JSON.stringify(dateAfterReload.find((section) => section.name === 'Dated')?.items) === JSON.stringify(['Later date', 'Earlier date', 'Timed entry']), 'Changed dated order did not persist after reload')
  assert(JSON.stringify(dateAfterReload.find((section) => section.name === 'Undated')?.items) === JSON.stringify(['Undated two', 'Undated one']), 'Undated order/section did not persist after reload')
  await viewport(390, 844, true)
  await saveScreenshot('nextup-date-list-phone.png', 390, 844)

  await navigate(appUrl)
  await waitUntil(`document.querySelectorAll('.home-list-rail').length === 2`, 'home route with both lists')
  await saveScreenshot('nextup-home.png', 390, 844)
  await viewport(1280, 900, false)
  await saveScreenshot('nextup-home-desktop.png', 1280, 900)

  await viewport(390, 844, true)
  const manualLink = await evaluate(`(() => { const link = [...document.querySelectorAll('.home-list-title')].find((entry) => entry.textContent.includes('Manual QA')); if (!link) return null; link.setAttribute('data-e2e-target', 'true'); return '[data-e2e-target="true"]'; })()`)
  assert(manualLink, 'Manual list route link is missing from home')
  await click(manualLink)
  await waitUntil(`document.querySelector('.manual-item-card')`, 'manual route from home')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const transition = await evaluate(`getComputedStyle(document.querySelector('.manual-item-card')).transitionDuration`)
  check(transition.split(',').every((value) => Number.parseFloat(value) === 0), `Reduced motion leaves transitions enabled: ${transition}`)
  await navigate(appUrl)
  await waitUntil(`document.querySelector('.home-item-rail')`, 'home route for reduced-motion rail check')
  await evaluate(`(() => { const rail = document.querySelector('.home-item-rail'); rail.scrollLeft = 0; rail.focus(); })()`)
  await press('ArrowRight', 'ArrowRight', 39)
  const reducedMotionRailOffset = await evaluate(`document.querySelector('.home-item-rail').scrollLeft`)
  check(reducedMotionRailOffset > 100, `Reduced-motion keyboard rail scroll was not immediate: ${reducedMotionRailOffset}px`)

  const errorStateSetup = await evaluate(`new Promise((resolve, reject) => { const request = indexedDB.open('nextup-local-data', 2); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put({ schemaVersion: 999 }, 'current'); tx.oncomplete = () => { db.close(); resolve(true); }; tx.onerror = () => reject(tx.error); }; })`)
  assert(errorStateSetup, 'Could not prepare a local corrupted-data error-state check')
  await reloadPage()
  await waitUntil(`!!document.querySelector('.error-card[role="alert"]')`, 'saved-data error state')
  assert(await evaluate(`document.querySelector('.error-card button')?.textContent.trim() === 'Try again'`), 'Saved-data error state lacks its retry action')

  console.log(JSON.stringify({ result: errors.length ? 'failed' : 'passed', touchMetrics, keyboardOrder, railMetrics, imageAfterReload, dateAfterReload, reducedMotionTransition: transition, reducedMotionRailOffset, findings: errors }, null, 2))
  if (errors.length) process.exitCode = 1
}

function makePng() {
  // A small locally generated 320x240 PNG; no downloaded test assets are needed.
  const width = 320
  const height = 240
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4
      raw[offset] = x < width / 2 ? 49 : 117
      raw[offset + 1] = y < height / 2 ? 126 : 173
      raw[offset + 2] = 91
      raw[offset + 3] = 255
    }
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = crc32(Buffer.concat([name, data]))
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc)
    return Buffer.concat([length, name, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ -1) >>> 0
}

async function stopChild(child, label) {
  if (!child || child.pid === undefined || child.spawnFailure || child.exitCode !== null || child.signalCode !== null) return
  const waitForExit = () => new Promise((resolveExit) => child.once('exit', resolveExit))
  let exited = waitForExit()
  try { child.kill('SIGTERM') } catch { /* A just-exited process may reject the signal. */ }
  await Promise.race([exited, delay(2_000)])
  if (child.exitCode === null && child.signalCode === null) {
    exited = waitForExit()
    try { child.kill('SIGKILL') } catch { /* Continue to the bounded exit wait. */ }
    await Promise.race([exited, delay(2_000)])
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error(`${label} did not exit after SIGTERM and SIGKILL`)
}

async function cleanup() {
  failTransport(new Error('E2E runner shutting down'))
  try { client?.close() } catch { /* Continue stopping child processes and removing the profile. */ }
  const cleanupErrors = []
  for (const [child, label] of [[chrome, 'Chromium'], [vite, 'Vite']]) {
    try { await stopChild(child, label) } catch (error) { cleanupErrors.push(error) }
  }
  try { await rm(profileDir, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'One or more E2E cleanup steps failed')
}

let failure
try { await start() } catch (error) { failure = error } finally {
  try { await cleanup() } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'E2E run and cleanup failed') : error
  }
}
if (failure) throw failure
