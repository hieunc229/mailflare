# Interface languages

Mailflare defaults to English and ships 34 interface languages. Visitors switch language from the homepage or sign-in page, and signed-in users can set it under **Settings → Account → General**, next to their time zone.

## Current coverage

| Region | Languages (code) |
| --- | --- |
| Europe | English (`en`), Español (`es`), Français (`fr`), Deutsch (`de`), Italiano (`it`), Nederlands (`nl`), Polski (`pl`), Українська (`uk`), Русский (`ru`), Türkçe (`tr`), Português (Brasil) (`pt-BR`), Português (Portugal) (`pt-PT`) |
| South Asia | हिन्दी (`hi`), বাংলা (`bn`), मराठी (`mr`), తెలుగు (`te`), தமிழ் (`ta`), ગુજરાતી (`gu`), ಕನ್ನಡ (`kn`), മലയാളം (`ml`), ਪੰਜਾਬੀ (`pa`), සිංහල (`si`), اردو (`ur`, right-to-left) |
| Middle East | العربية (`ar`, right-to-left), فارسی (`fa`, right-to-left) |
| East and Southeast Asia | 中文（简体）(`zh-CN`), 日本語 (`ja`), 한국어 (`ko`), Bahasa Indonesia (`id`), Bahasa Melayu (`ms`), Tiếng Việt (`vi`), ไทย (`th`) |
| Africa | Kiswahili (`sw`), Hausa (`ha`) |

Every catalog covers the whole interface. Email content, custom folder and mailbox names stay user content, and selecting a language does not change routes, system-folder identifiers or date/time formatting. Catalogs for languages added most recently were translated without native-speaker review, so wording may need polish; corrections are welcome as pull requests.

## Preference and rendering

The selection applies immediately and is saved in the host-only `mailflare-locale` cookie for one year (`Path=/`, `SameSite=Lax`, `Secure` on HTTPS). It is a browser preference shared across accounts on the same installation. If cookies are blocked, the current selection works until the page is reloaded.

The root layout reads the cookie with `await cookies()`, validates it against the locale registry, and uses the same value for `<html lang>` and the client language provider. This makes pages use request-time rendering, including otherwise static pages. A missing or unsupported cookie selects English. Client navigation preserves the provider state; reloading or opening a new tab restores the cookie selection. This version does not synchronize changes into tabs that are already open.

## Adding translations

Catalogs are flat JSON objects. English (`src/lib/i18n/en.json`) is bundled and defines `TranslationKey` and `Messages`; registered catalogs must contain all English keys with string values (plural variants may add categories). Add new English keys and update registered translations together. `translate()` retains a per-key English fallback.

To add another language:

1. Copy `src/lib/i18n/en.json` to `public/locales/<code>.json`, for example `public/locales/es.json`, and translate its values without changing the keys.
2. Register it in `src/lib/i18n/locales.ts` with its BCP 47 locale code and native display name:

   ```ts
   // Inside locales:
   es: { label: "Español" },
   ```

That is the only registration point. The `Locale` type, supported-locale validation, cookie handling, server-rendered HTML and selector options all derive from it. No provider, layout, selector or utility changes are needed. English remains the default. For a right-to-left language add `dir: "rtl"` to the entry; the layout and provider then set `<html dir>`. English ships in the main bundle; every other catalog is a static asset loaded on demand (the browser fetches `/locales/<code>.json`, server rendering reads it through the `ASSETS` binding), so catalogs do not count toward the Worker's 3 MiB Free-plan size limit. Locale-specific date formatting is not part of this system.

Client components use `useLanguage().t(key, vars?)`; server code uses `createTranslator(locale)` from `src/lib/i18n/utils.ts`, which returns the same function. Strings interpolate `{name}` placeholders from `vars`. For plurals, add `key.one`, `key.other` (and any other CLDR categories the language needs, such as `few` for Polish, Ukrainian and Arabic) to the catalog, then call `t("key", { count })`; the variant is picked with `Intl.PluralRules`, falling back to the bare key. The dialog close button uses the translated `navigation.close` automatically.

 Keep routes, storage keys, permission checks, API values and user content independent of translated display text. Extend coverage gradually rather than replacing strings throughout the app in one change.

Run `node --test tests/i18n.test.mjs` for catalog parity, fallback, cookie attributes, selector labels, server rendering and root-layout locale agreement. An isolated test registers an extra language and verifies that resolution, translations, cookie persistence, selector options and SSR pick it up without changing any consumers. Also run lint, `npx tsc --noEmit` and the applicable build when changing the integration.
