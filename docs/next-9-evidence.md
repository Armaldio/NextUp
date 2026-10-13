# NEXT-9 acceptance evidence

Captured locally with Chromium 154.0.8037.97. The screenshots use seeded browser data and a capture-only Arial/Helvetica/Liberation Sans font override; the application font styles are unchanged by that override.

## Checks

| Command | Result |
| --- | --- |
| `pnpm test` | Passed: 52 tests, 0 failures. |
| `pnpm build` | Passed: Vue type check and Vite production build. |
| `pnpm run test:e2e` | Passed in local Chromium; both manual and date flows, interaction/accessibility checks, persistence checks, responsive checks, and empty/error state checks completed. |
| Lint | Not configured: `package.json` has no lint script or configured linter. |

The browser runner is dependency-free and uses Node's built-in WebSocket/CDP support. Run `pnpm run test:e2e` with local dependencies installed and system Chromium available. It starts a local Vite server and a temporary isolated Chromium profile; it does not use a remote browser or publish the app.

## Acceptance matrix

| Acceptance area | Evidence and result |
| --- | --- |
| Manual list lifecycle | Passed: created a manual list with an image-backed item and two other items; renamed and reordered stages; reordered items within a stage; reloaded and verified stage/item order, statuses, image Blob persistence, rendered image dimensions, and alt text. |
| Date list lifecycle | Passed: created dated, local date-time, and undated entries; changed a date; reloaded and verified chronological dated order and the explicit **Undated** section. Only undated entries expose reorder controls, and their order persisted. |
| Keyboard and semantics | Passed: keyboard tab/focus order, visible focus treatment, accessible control names, and keyboard Enter reorder alternative were exercised. Reorder actions have labeled buttons. |
| Touch targets | Passed: measured relevant stage controls, item reorder controls, and date controls at 44×44 CSS pixels minimum. |
| Reduced motion | Passed: reduced-motion card transitions measured `0s`; the home rail keyboard action moved immediately (`scrollLeft` 0 → 194) rather than animating. |
| Responsive layout and routes | Passed: reviewed 390px phone and 1280px desktop screenshots; the home rail overflows horizontally (584px content in a 390px viewport) and accepts a touch swipe. The manual route uses a single stage flow without Kanban columns. Item detail and back-to-list navigation were exercised. |
| Empty and error states | Passed: verified the empty home state and the recoverable malformed stored-snapshot error with a working **Try again** action. |

No unresolved findings from this acceptance run. The two implementation findings were recorded in Plane before correction: undersized touch targets and reduced-motion keyboard scrolling. Both now pass the checks above. NEXT-9 remains **In Progress** for coordinator review and integration.

## Screenshots

| View | Phone | Desktop |
| --- | --- | --- |
| Home with seeded manual/date rails and image preview | [nextup-home.png](screenshots/nextup-home.png) | [nextup-home-desktop.png](screenshots/nextup-home-desktop.png) |
| Manual list with stages and reordered items | [nextup-list.png](screenshots/nextup-list.png) | [nextup-list-desktop.png](screenshots/nextup-list-desktop.png) |
| Date list with dated and undated sections | [nextup-date-list-phone.png](screenshots/nextup-date-list-phone.png) | [nextup-date-list.png](screenshots/nextup-date-list.png) |
| Item detail | [nextup-item.png](screenshots/nextup-item.png) | Captured at the phone-sized detail viewport. |
