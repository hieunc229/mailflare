# Interface languages

Default English; 34 interface languages. Visitors switch on the homepage or sign-in page; signed-in users under **Settings → Account → General**, next to time zone.

## Current coverage

| Region | Languages (code) |
| --- | --- |
| Europe | English (`en`), Español (`es`), Français (`fr`), Deutsch (`de`), Italiano (`it`), Nederlands (`nl`), Polski (`pl`), Українська (`uk`), Русский (`ru`), Türkçe (`tr`), Português (Brasil) (`pt-BR`), Português (Portugal) (`pt-PT`) |
| South Asia | हिन्दी (`hi`), বাংলা (`bn`), मराठी (`mr`), తెలుగు (`te`), தமிழ் (`ta`), ગુજરાતી (`gu`), ಕನ್ನಡ (`kn`), മലയാളം (`ml`), ਪੰਜਾਬੀ (`pa`), සිංහල (`si`), اردو (`ur`, right-to-left) |
| Middle East | العربية (`ar`, right-to-left), فارسی (`fa`, right-to-left) |
| East and Southeast Asia | 中文（简体）(`zh-CN`), 日本語 (`ja`), 한국어 (`ko`), Bahasa Indonesia (`id`), Bahasa Melayu (`ms`), Tiếng Việt (`vi`), ไทย (`th`) |
| Africa | Kiswahili (`sw`), Hausa (`ha`) |

Every catalog covers the whole interface. Email content and custom folder and mailbox names stay user content. Language choice does not change routes, system-folder identifiers or date/time formatting. The most recently added catalogs have no native-speaker review; corrections welcome as pull requests.

## Preference and rendering

The selection applies immediately and is saved in the host-only `mailflare-locale` cookie for one year (`Path=/`, `SameSite=Lax`, `Secure` on HTTPS), a browser preference shared across accounts of this installation in the same browser. With cookies blocked, it lasts until reload.

The root layout reads the cookie with `await cookies()`, validates it against the locale registry, and uses the value for `<html lang>` and the client language provider. This forces request-time rendering, including otherwise static pages. A missing or unsupported cookie selects English. Client navigation preserves the provider state; reload or a new tab restores the cookie selection. Changes are not synchronized into already-open tabs.

## Adding translations

Catalogs are flat JSON objects. English (`src/lib/i18n/en.json`) is bundled and defines `TranslationKey` and `Messages`; registered catalogs must contain all English keys with string values (plural variants may add categories). Add new English keys and update registered translations together. `translate()` retains a per-key English fallback.

To add another language:

1. Copy `src/lib/i18n/en.json` to `public/locales/<code>.json`, for example `public/locales/es.json`, and translate its values without changing the keys.
2. Register it in `src/lib/i18n/locales.ts` with its BCP 47 locale code and native display name:

   ```ts
   // Inside locales:
   es: { label: "Español" },
   ```

That is the only registration point: no provider, layout, selector or utility changes are needed. The `Locale` type, validation, cookie handling, server-rendered HTML and selector options derive from it. For a right-to-left language add `dir: "rtl"` to the entry; the layout and provider then set `<html dir>`. English remains the default and ships in the main bundle; every other catalog is a static asset loaded on demand (the browser fetches `/locales/<code>.json`, server rendering reads it through the `ASSETS` binding), so they do not count toward the Worker's 3 MiB Free-plan size limit. Locale-specific date formatting is not part of this system.

Client components use `useLanguage().t(key, vars?)`; server code uses `createTranslator(locale)` from `src/lib/i18n/utils.ts`, which returns the same function. Strings interpolate `{name}` placeholders from `vars`. For plurals, add `key.one`, `key.other` (and any other CLDR categories the language needs, such as `few` for Polish, Ukrainian and Arabic) to the catalog, then call `t("key", { count })`; the variant is picked with `Intl.PluralRules`, falling back to the bare key. The dialog close button uses the translated `navigation.close` automatically.

Keep routes, storage keys, permission checks, API values and user content independent of translated display text.  Extend coverage gradually rather than replacing strings throughout the app in one change.
Run `node --test tests/i18n.test.mjs` for catalog parity, fallback, cookie attributes, selector labels, server rendering and root-layout locale agreement. An isolated test registers an extra language and verifies resolution, translations, cookie persistence, selector options and SSR pick it up without changing any consumers. Also run lint, `npx tsc --noEmit` and the applicable build when changing the integration.
