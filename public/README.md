# Incident explorer frontend

Serve this directory from the local app's same origin. `index.html` loads `app.js`, `state.js`, `triage.js`, and `styles.css`; requests use the settled `/api/incidents`, `/api/incidents/:id`, `/api/overview`, and `/api/export.csv` endpoints. No dataset or server is embedded in the frontend.

Search is submitted with Search or Enter. Facet, date, sorting, and page-size changes apply immediately and return to page one. Dates and displayed timestamps use UTC. The result summary and daily counts describe the full matching result. While updating, the previous completed rows and summaries remain explicitly marked, and page controls are disabled. CSV exports the current applied selections and sort, across all pages; tags follow the API's JSON-array CSV representation.

Copy or bookmark the browser address to share the applied query, including sorting, page size and later pages. Reload and fresh tabs restore the results view. Back and Forward restore controls (discarding unsent drafts), rows and whole-result summaries; pending requests retain the previous snapshot as stale. Details and export activity do not create history entries. Invalid address values fall back to defaults; invalid dates clear and reversed date ranges clear both bounds. Unknown parameters are removed.

Named views persist the applied search, facets, dates, sorting, and page size in browser localStorage. Opening a view applies its selections together and returns to page one. Storage failures are visible and exploration remains available.

The native details dialog supports keyboard dismissal, exposes every incident field as text, and restores focus to the incident on return. Results, detail sessions, and exports have separate ownership tokens. Each completion, error, and cleanup is gated; changed selections invalidate details and export downloads. Cancellation helps save work but tokens provide correctness. Download object URLs are released.

The service overview is first on a fresh phone landing; section links focus overview, results, triage or controls. It compares all matching incidents, independently of pagination and sort: total incidents, unresolved (open or in progress), critical + high, and average opening-to-resolution hours for resolved incidents only. No resolved incidents means Unavailable. Services order by unresolved count descending, then service name. Requested and represented selections remain visible while loading or after failure; Retry uses current filters. An empty selection has a visible explanation. Narrow cards wrap values, triage notes/actions fit the screen, and the results table scrolls horizontally to retain every column.

Add from complete details, then reopen from Personal triage without losing the search. Added order is preserved, repeated adds are disabled, and Remove clears membership and note together. Notes are plain text and save on each input. Reload restores triage from `incident-explorer.triage.v1`, independently of saved views and addresses. Nothing is sent to the backend or changes incidents. Storage belongs to this browser and origin; clearing it loses triage, and changing port or browser creates a separate list. Malformed data is discarded with an explanation. Storage errors retain usable visit state but may prevent persistence. There is no synchronization or backup, no enforced note-length limit, and browser quota applies.

For local startup from the checkout, use Node.js 24:

```sh
npm run seed
npm run start
```

Open http://127.0.0.1:3000; stop with Ctrl+C (SIGTERM also works). On POSIX shells, `PORT=3001 npm run start` selects another loopback port.

Run the existing verification commands in order from the checkout:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

Discoverable tests under `tests/frontend/` exercise the actual DOM-free state module with direct events. These establish component behavior, including overlapping intents and retries; they do not establish real HTTP or browser integration. The integration suites run real sandbox-enabled Chromium against the existing backend and compare with an independent canonical-data oracle. See the root README for preparation, browser qualification and startup instructions.

Component review: `state.js` separates the requested intent from the last displayed snapshot and publishes rows and whole-result summaries atomically. Pending or stale queries lock pagination, and synchronous page transitions are clamped before dispatch. The UI retains the native modal and return target while detail ownership changes; it renders dataset values through text nodes. Independent operation tokens gate success, failure, and cleanup, and export gates download side effects after reading the response. This review establishes frontend structure and state behavior only.

Integrated ownership review: `state.js` owns every overview snapshot, error and pending flag. Filter/search/date changes invalidate its token; sort, direction, page and size keep the same filter identity. `app.js` aborts obsolete network work, but token and pending checks in success/failure transitions establish correctness even when cancellation arrives late. Finally events check tokens before clearing loading. Failed current requests retain the old snapshot with its original selection; retries create a new token. `renderOverview` derives labels and cards from those guarded values. Result page clamping does not change the overview filter identity.

The shared announcement has writers in render, triage rendering, note input, section navigation and focus handlers. All call the same context-aware `announcement` function: active details take precedence, then the active overview/triage/results context. Thus an unrelated result/export completion cannot replace an active overview error or detail message. Triage input updates in-memory entries before attempting storage; failed writes preserve those entries. Removal serializes the filtered entries, excluding the removed note. Text nodes and textarea values preserve literal text. Details use independent tokens; close/reselection invalidates old success, error and cleanup. Return targets prefer connected triage buttons, fall back to the triage section after rerender/removal, and preserve the current result snapshot.

Actual component tests in `tests/frontend/state.test.js` exercise overview replacement, obsolete success/failure/finish, retry, recall/navigation, presentation invariance and announcement precedence. `tests/frontend/triage.test.js` covers order, deduplication, literal edits, removal, malformed values and unavailable accessor/read/write recovery. These are component evidence, not browser HTTP proof. The discoverable `tests/integration/overview-triage.test.mjs` supplies real combined browser journeys without response interception, including an aborted overlapping request followed by genuine service failure/restart. It checks fresh phone access and detail focus return, persisted literal notes and removal, malformed storage, and native quota exhaustion. Accessor/read denial and device-specific browser storage policies remain unexercised in the browser; source and component coverage establish those paths only. All new owned resources have finite waits and finally cleanup; runtime artifacts stay under ignored `.runtime/`.
