# i18n Support for Frontend and Node Services

## Goal

Add internationalization (i18n) support to magplay, focusing first on the frontend client (search, explore, title, torrent, player, shared chrome/dialogs), with AI-assisted translation workflows, type-safe catalogs, modern message formatting, and clear architectural boundaries for future backend/API localisation.

## Progress

- [ ] Define message catalog format with ICU plurals, template variables, developer descriptions, and code references
- [ ] Select lightweight client-side i18n runtime supporting ICU/MF2-style plurals, parameters, and native `Intl` APIs
- [ ] Extract UI strings from static HTML files and client JS modules into English source catalog (`locales/en.json`)
- [ ] Implement translation loading and locale negotiation (`navigator.languages`, URL/localStorage preference)
- [ ] Integrate i18n runtime into client bundle build (`esbuild`) with zero unnecessary client overhead (strip metadata for dist)
- [ ] Provide CLI tooling / scripts for AI translation extraction, generation, code reference syncing, and CI validation
- [ ] Update documentation (`docs/user-interface.md` and `docs/architecture.md`)

## Key Decisions & Architecture

### 1. Catalog Format, Template Variables, and Numeric Divisibility
- **Format:** Structured key-value JSON with ICU MessageFormat syntax.
- **Variables and Interpolation:** Named parameters using standard `{variable}` placeholders (e.g. `{query}`, `{time}`).
- **Plural Categories and Divisibility:** Handled via standard ICU plural syntax (`{count, plural, ...}`).
  - Leverages browser-native `Intl.PluralRules` to evaluate plural categories (`zero`, `one`, `two`, `few`, `many`, `other`) and exact matches (`=0`, `=1`).
  - Supports complex divisibility rules across languages (e.g. Latvian zero/one/other, Slavic one/few/many/other, Arabic 6 forms) without custom math.
  - `#` inside plural templates automatically substitutes the formatted number (via `Intl.NumberFormat`).

### 2. Context Preservation & Code References for AI and Humans
AI translation models require context to determine grammatical gender, tone, parts of speech, and character boundaries. Source catalogs maintain rich metadata in `locales/en.json`:
- **`message`:** The authoritative English string with ICU variables/plurals.
- **`description`:** Developer explanation of UI placement, context, and meaning.
- **`origin`:** Array of source code references (`file:line` or `file`) where the string is used.
- **`maxLength` (optional):** Maximum visual length constraint to prevent UI breaking on compact controls.

Example catalog entry:
```json
{
  "search.results_count": {
    "message": "{count, plural, =0 {Nothing found.} one {1 result} other {# results}}",
    "description": "Status text showing total torrent search results",
    "origin": [
      "apps/client/src/search.js:38"
    ],
    "maxLength": 30
  },
  "player.restart_at": {
    "message": "Starting at {time}…",
    "description": "Overlay feedback when user seeks to an unconverted position",
    "origin": [
      "apps/client/src/player.js:142"
    ]
  }
}
```

### 3. In-Code Comments and Automated Extraction
To keep code references and context fresh without manual bookkeeping:
- Developers can write translator comments directly above string calls:
  ```javascript
  // i18n: Shown in player overlay when ffmpeg is transcoding from a new seek point
  t('player.restart_at', { time: clock(cur.offset) })
  ```
- The extractor tool (`npm run i18n:extract`) scans `apps/client/src/**/*.js` and `public/*.html`:
  - Captures the key, message, and preceding `// i18n:` comment into `description`.
  - Automatically updates the `origin` array (`file:line`).
  - Identifies dead or orphaned keys with zero references.

### 4. Zero Production Overhead (Dist Minification)
Metadata (`description`, `origin`, `maxLength`) is strictly preserved in version control for development and AI workflows. During the build step:
- `esbuild` or the release step compiles distribution bundles into `dist/client/locales/{lang}.json`.
- Metadata is stripped, outputting compact key-value maps:
  ```json
  {
    "search.results_count": "{count, plural, =0 {Nothing found.} one {1 result} other {# results}}",
    "player.restart_at": "Starting at {time}…"
  }
  ```
- This ensures maximum context during translation with zero payload penalty on low-power NAS devices and mobile browsers.

### 5. Runtime & Bundle Footprint
- `magplay` client uses vanilla JS + esbuild with no bulky UI framework (React/Vue).
- A lightweight client translator module (< 2KB gzip) in `apps/client/src/lib/i18n.js`:
  - Uses `Intl.PluralRules` and `Intl.NumberFormat` natively.
  - Dynamically loads only the active locale JSON or falls back gracefully to embedded English.
  - Modern formatting helpers (`timeAgo`, `formatBytes`, `formatSpeed`, `formatClock`) in `apps/client/src/lib/ui.ts` transition to `Intl.RelativeTimeFormat` and `Intl.NumberFormat`.

### 6. Static HTML vs Dynamic JS
- Elements in `public/*.html` use declarative attributes:
  - Text content: `<button data-i18n="search.button">Search</button>`
  - Attributes: `<input data-i18n-attr="placeholder:search.placeholder;aria-label:search.label">`
- On page load, `initI18n()` translates marked elements and updates `<html lang="...">` and `dir="ltr|rtl"`.

### 7. AI Translation Workflow & CI Validation
- Script `npm run i18n:translate -- --target=lv,es,de`:
  - Compares target catalogs against `locales/en.json` to find missing or updated entries.
  - Feeds batches containing `key`, `message`, `description`, `origin`, and `maxLength` to LLMs.
  - Translators/AI can consult the referenced source file/lines for surrounding DOM and UI hierarchy.
- **CI Validation:**
  - Asserts that all ICU placeholders `{var}` present in the English source exist in translations.
  - Uses `new Intl.PluralRules(targetLocale).resolvedOptions().pluralCategories` to verify that all required plural branches (`zero`, `one`, `few`, `many`, `other`) are defined.
  - Verifies strings conform to `maxLength` limits.
