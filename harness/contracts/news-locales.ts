// news.make.fun's languages: the 28 locales an edition is read in, how a reader's browser languages pick one, and the
// locale prefix of the news host's paths. A leaf like contracts/news.ts: no Node APIs, no DOM and no import from server/
// (the web app, the server and the bare pages' boot script all read it).
//
//   NEWS_LOCALES               one row per locale, in the decided order (English first, the source language): its BCP 47
//                              tag, URL path segment, hreflang codes, endonym, English name, script, direction, flag,
//                              og:locale, the Intl locale the catalogs format with, whether it is built, and its
//                              translation style note
//   NewsLocale, NewsLocaleTag  a row, and the union of the tags
//   NEWS_LOCALE_TAGS, NEWS_BUILT_LOCALES, newsLocale, isNewsLocaleTag
//                              every tag, the rows that are built (served and translated), a row by tag, a known tag
//   NEWS_DEFAULT_LOCALE        'en': the bare URLs, x-default, and every match that finds nothing
//   NEWS_LOCALE_STORAGE_KEY    the reader's own pick in localStorage (the picker writes it, the boot script reads it)
//   NEWS_LOCALE_ALIASES        language ranges that do not truncate to their locale (zh-TW -> zh-Hant, in -> id), and
//                              those that must match nothing (pa-Arab, pa-PK: Shahmukhi readers, never Gurmukhi)
//   NewsLocaleBootTable, newsLocaleBootTable, NEWS_LOCALE_BOOT_TABLE
//                              the small JSON-able table the boot script inlines: [tag, path] pairs and alias pairs
//   matchNewsLocale            navigator.languages (or any preference list) -> the locale tag (RFC 4647 lookup)
//   localeOfPath, localizedPath, isLocalePath, newsLocaleOfSegment
//                              '/es/2026-11-19' <-> es and '/2026-11-19'
//   ANY OTHER LANGUAGE (on demand: server/news/i18n.ts, server/news/feeds.ts, server/routes/news.ts)
//   isTranslatedNewsLocale     a tag an edition may be stored translated into: canonical BCP 47 of news_translation's
//                              shape (a language, an optional script, an optional region), never 'en' or 'und'
//   newsLanguageName           a tag's language in English ('he' -> 'Hebrew'), null when Intl names none (qaa, xx, und)
//   onDemandNewsTag            any other language a reader may ask for (canonical; null for an invalid tag, English, or one
//                              that reads as a NEWS_LOCALES locale: es-MX is es, zh-TW is zh-Hant), as its written
//                              language: the region dropped, the script kept only where it is not the language's own
//                              (he-IL is he, sr-Latn-RS sr-Latn), so a language's region variants are one translation
//   resolveNewsLang            a ?lang= value -> English, a served locale, a locale not served here, an on-demand tag, or
//                              nothing valid; newsLangPrefixOf, newsPathIn: an on-demand tag's prefix is its lowercased tag
//                              ('/he/2026-11-19.md', '/sr-latn/feed.xml'), onDemandTagOfSegment reads it back
//   NEWS_ON_DEMAND_PER_UTC_DAY, NEWS_ON_DEMAND_PER_EDITION, NEWS_ON_DEMAND_RETRY_AFTER_S
//                              the caps on new on-demand translations and the 202's Retry-After
//
// hreflang codes are the ones Google documents: an ISO 639-1 language, optionally a region (ISO 3166-1 alpha-2) or the
// Hans / Hant script. Never a UN M.49 region such as es-419, which Google ignores. The flag is one rule: the country
// with the most readers of the tag's written form (so hi, ta, te, mr and pa share India's; the endonym always prints).

export interface NewsLocale {
  /** The BCP 47 tag: 'zh-Hans', 'pt', 'es'. Stored in news_translation.locale, given as ?lang= to the API (any other tag is translated on demand). */
  readonly tag: string;
  /** The URL path segment, the tag lowercased ('zh-hans'); '' for English, which is unprefixed. */
  readonly path: string;
  /** The hreflang codes the locale's pages are listed under (Google-valid only; see the header). */
  readonly hreflang: readonly string[];
  /** The language's name in itself, as the picker prints it (with lang = tag). */
  readonly endonym: string;
  /** The language's name in English. */
  readonly name: string;
  /** The ISO 15924 script the locale is written in. */
  readonly script: string;
  readonly dir: 'ltr' | 'rtl';
  /** The flag's ISO 3166-1 alpha-2 country, by the header's rule. Decoration only (aria-hidden). */
  readonly flag: string;
  /** og:locale, language_TERRITORY with the flag's country. */
  readonly ogLocale: string;
  /**
   * The Intl locale the catalog generator (scripts/news-i18n.ts) formats dates, numbers and plurals with. Western digits
   * everywhere (-u-nu-latn where CLDR's default is another digit set), as the translations keep the source's digits, and
   * the Gregorian calendar (-u-ca-gregory where it is not the default), as every page is a Gregorian UTC day.
   */
  readonly cldr: string;
  /** Whether the locale is served and translated. Step 14's quality gate turns one off, its reason in offReason. */
  readonly built: boolean;
  /** Why a locale is not built (required when built is false). */
  readonly offReason?: string;
  /** One line for the translator: the variety, register and typography this locale is written in. */
  readonly style: string;
}

export const NEWS_LOCALES = [
  {
    tag: 'en',
    path: '',
    hreflang: ['en'],
    endonym: 'English',
    name: 'English',
    script: 'Latn',
    dir: 'ltr',
    flag: 'US',
    ogLocale: 'en_US',
    // en-GB writes the day as contracts/news.ts dayTitle does ('Thursday 19 November 2026'); numbers group alike.
    cldr: 'en-GB',
    built: true,
    style: 'The source language: the edition as written, never translated.',
  },
  {
    tag: 'zh-Hans',
    path: 'zh-hans',
    hreflang: ['zh-Hans'],
    endonym: '简体中文',
    name: 'Chinese (Simplified)',
    script: 'Hans',
    dir: 'ltr',
    flag: 'CN',
    ogLocale: 'zh_CN',
    cldr: 'zh-Hans-CN',
    built: true,
    style: 'Mainland Simplified Chinese press style (Xinhua register), full-width punctuation and “” quotes, mainland vocabulary.',
  },
  {
    tag: 'zh-Hant',
    path: 'zh-hant',
    hreflang: ['zh-Hant'],
    endonym: '繁體中文',
    name: 'Chinese (Traditional)',
    script: 'Hant',
    dir: 'ltr',
    flag: 'TW',
    ogLocale: 'zh_TW',
    cldr: 'zh-Hant-TW',
    built: true,
    style: 'Taiwan Traditional Chinese press style (Central News Agency register), Taiwan vocabulary, full-width punctuation and 「」 quotes.',
  },
  {
    tag: 'es',
    path: 'es',
    hreflang: ['es'],
    endonym: 'Español',
    name: 'Spanish',
    script: 'Latn',
    dir: 'ltr',
    flag: 'MX',
    ogLocale: 'es_MX',
    cldr: 'es-419',
    built: true,
    style: 'Neutral Latin-American Spanish as the regional wire services write it: ustedes, no vosotros, no country slang.',
  },
  {
    tag: 'pt',
    path: 'pt',
    hreflang: ['pt'],
    endonym: 'Português',
    name: 'Portuguese',
    script: 'Latn',
    dir: 'ltr',
    flag: 'BR',
    ogLocale: 'pt_BR',
    cldr: 'pt-BR',
    built: true,
    style: 'Brazilian Portuguese press style (Folha, G1): Brazilian spelling, vocabulary and você.',
  },
  {
    tag: 'hi',
    path: 'hi',
    hreflang: ['hi'],
    endonym: 'हिन्दी',
    name: 'Hindi',
    script: 'Deva',
    dir: 'ltr',
    flag: 'IN',
    ogLocale: 'hi_IN',
    cldr: 'hi',
    built: true,
    style: 'Standard Hindi in Devanagari, the register of the Hindi dailies; English loanwords only where that press uses them.',
  },
  {
    tag: 'ar',
    path: 'ar',
    hreflang: ['ar'],
    endonym: 'العربية',
    name: 'Arabic',
    script: 'Arab',
    dir: 'rtl',
    flag: 'EG',
    ogLocale: 'ar_EG',
    cldr: 'ar-u-nu-latn',
    built: true,
    style: 'Modern Standard Arabic in the pan-Arab news register (Al Jazeera, BBC Arabic), no dialect, Western digits.',
  },
  {
    tag: 'fr',
    path: 'fr',
    hreflang: ['fr'],
    endonym: 'Français',
    name: 'French',
    script: 'Latn',
    dir: 'ltr',
    flag: 'FR',
    ogLocale: 'fr_FR',
    cldr: 'fr',
    built: true,
    style: 'Standard French press style (Le Monde, AFP), French typography: « » quotes, a no-break space before ; : ! ?',
  },
  {
    tag: 'ru',
    path: 'ru',
    hreflang: ['ru'],
    endonym: 'Русский',
    name: 'Russian',
    script: 'Cyrl',
    dir: 'ltr',
    flag: 'RU',
    ogLocale: 'ru_RU',
    cldr: 'ru',
    built: true,
    style: 'Standard Russian news-agency style (TASS, Interfax register), « » quotes, established Russian forms of names.',
  },
  {
    tag: 'de',
    path: 'de',
    hreflang: ['de'],
    endonym: 'Deutsch',
    name: 'German',
    script: 'Latn',
    dir: 'ltr',
    flag: 'DE',
    ogLocale: 'de_DE',
    cldr: 'de',
    built: true,
    style: 'Standard German press style (dpa, Tagesschau), „ “ quotes, current spelling.',
  },
  {
    tag: 'ja',
    path: 'ja',
    hreflang: ['ja'],
    endonym: '日本語',
    name: 'Japanese',
    script: 'Jpan',
    dir: 'ltr',
    flag: 'JP',
    ogLocale: 'ja_JP',
    cldr: 'ja',
    built: true,
    style: 'Newspaper Japanese in the plain form (だ・である調, NHK and Kyodo register), full-width punctuation, 「」 quotes, foreign names in katakana.',
  },
  {
    tag: 'id',
    path: 'id',
    hreflang: ['id'],
    endonym: 'Bahasa Indonesia',
    name: 'Indonesian',
    script: 'Latn',
    dir: 'ltr',
    flag: 'ID',
    ogLocale: 'id_ID',
    cldr: 'id',
    built: true,
    style: 'Standard Indonesian (bahasa baku) in the Kompas and Antara register.',
  },
  {
    tag: 'bn',
    path: 'bn',
    hreflang: ['bn'],
    endonym: 'বাংলা',
    name: 'Bengali',
    script: 'Beng',
    dir: 'ltr',
    flag: 'BD',
    ogLocale: 'bn_BD',
    cldr: 'bn-u-nu-latn',
    built: true,
    style: 'Standard colloquial Bengali (cholito bhasha) of the Bangladesh press (Prothom Alo register), Western digits as given.',
  },
  {
    tag: 'ur',
    path: 'ur',
    hreflang: ['ur'],
    endonym: 'اردو',
    name: 'Urdu',
    script: 'Arab',
    dir: 'rtl',
    flag: 'PK',
    ogLocale: 'ur_PK',
    cldr: 'ur',
    built: true,
    style: 'Standard Urdu of the Pakistani press (Jang, BBC Urdu register) in Perso-Arabic script, Western digits.',
  },
  {
    tag: 'it',
    path: 'it',
    hreflang: ['it'],
    endonym: 'Italiano',
    name: 'Italian',
    script: 'Latn',
    dir: 'ltr',
    flag: 'IT',
    ogLocale: 'it_IT',
    cldr: 'it',
    built: true,
    style: 'Standard Italian press style (ANSA, Corriere register).',
  },
  {
    tag: 'tr',
    path: 'tr',
    hreflang: ['tr'],
    endonym: 'Türkçe',
    name: 'Turkish',
    script: 'Latn',
    dir: 'ltr',
    flag: 'TR',
    ogLocale: 'tr_TR',
    cldr: 'tr',
    built: true,
    style: 'Standard Turkish press style (Anadolu Ajansı register), TDK spelling.',
  },
  {
    tag: 'vi',
    path: 'vi',
    hreflang: ['vi'],
    endonym: 'Tiếng Việt',
    name: 'Vietnamese',
    script: 'Latn',
    dir: 'ltr',
    flag: 'VN',
    ogLocale: 'vi_VN',
    cldr: 'vi',
    built: true,
    style: 'Standard Vietnamese press style (VnExpress, VNA register) with every diacritic.',
  },
  {
    tag: 'fa',
    path: 'fa',
    hreflang: ['fa'],
    endonym: 'فارسی',
    name: 'Persian',
    script: 'Arab',
    dir: 'rtl',
    flag: 'IR',
    ogLocale: 'fa_IR',
    cldr: 'fa-u-ca-gregory-nu-latn',
    built: true,
    style: 'Iranian Persian press style (BBC Persian register), the zero-width non-joiner (nim-fasele) where standard, Western digits.',
  },
  {
    tag: 'ko',
    path: 'ko',
    hreflang: ['ko'],
    endonym: '한국어',
    name: 'Korean',
    script: 'Kore',
    dir: 'ltr',
    flag: 'KR',
    ogLocale: 'ko_KR',
    cldr: 'ko',
    built: true,
    style: 'South Korean news style (Yonhap register): the plain -다 form, Hangul only, standard word spacing.',
  },
  {
    tag: 'th',
    path: 'th',
    hreflang: ['th'],
    endonym: 'ไทย',
    name: 'Thai',
    script: 'Thai',
    dir: 'ltr',
    flag: 'TH',
    ogLocale: 'th_TH',
    cldr: 'th-u-ca-gregory',
    built: true,
    style: 'Standard Thai press register (Thai PBS), no spaces between words, a space between clauses, Western digits.',
  },
  {
    tag: 'sw',
    path: 'sw',
    hreflang: ['sw'],
    endonym: 'Kiswahili',
    name: 'Swahili',
    script: 'Latn',
    dir: 'ltr',
    flag: 'TZ',
    ogLocale: 'sw_TZ',
    cldr: 'sw',
    built: true,
    style: 'Standard Swahili (Kiswahili sanifu) as the Tanzanian and Kenyan press write it (BBC Swahili register).',
  },
  {
    tag: 'ha',
    path: 'ha',
    hreflang: ['ha'],
    endonym: 'Hausa',
    name: 'Hausa',
    script: 'Latn',
    dir: 'ltr',
    flag: 'NG',
    ogLocale: 'ha_NG',
    cldr: 'ha',
    built: true,
    style: 'Standard (Kano) Hausa in Boko Latin script with the hooked letters ɓ, ɗ, ƙ and ʼy (BBC Hausa register).',
  },
  {
    tag: 'ta',
    path: 'ta',
    hreflang: ['ta'],
    endonym: 'தமிழ்',
    name: 'Tamil',
    script: 'Taml',
    dir: 'ltr',
    flag: 'IN',
    ogLocale: 'ta_IN',
    cldr: 'ta',
    built: true,
    style: 'Standard written Tamil of the Indian Tamil press (Dinamani register).',
  },
  {
    tag: 'te',
    path: 'te',
    hreflang: ['te'],
    endonym: 'తెలుగు',
    name: 'Telugu',
    script: 'Telu',
    dir: 'ltr',
    flag: 'IN',
    ogLocale: 'te_IN',
    cldr: 'te',
    built: true,
    style: 'Standard modern Telugu of the Telugu dailies (Eenadu register).',
  },
  {
    tag: 'mr',
    path: 'mr',
    hreflang: ['mr'],
    endonym: 'मराठी',
    name: 'Marathi',
    script: 'Deva',
    dir: 'ltr',
    flag: 'IN',
    ogLocale: 'mr_IN',
    cldr: 'mr-u-nu-latn',
    built: true,
    style: 'Standard Marathi in Devanagari, the register of the Marathi dailies (Loksatta), Western digits as given.',
  },
  {
    tag: 'pa',
    path: 'pa',
    hreflang: ['pa'],
    endonym: 'ਪੰਜਾਬੀ',
    name: 'Punjabi',
    script: 'Guru',
    dir: 'ltr',
    flag: 'IN',
    ogLocale: 'pa_IN',
    cldr: 'pa',
    built: true,
    style: 'Standard Punjabi of the Indian press in Gurmukhi script, never Shahmukhi.',
  },
  {
    tag: 'nl',
    path: 'nl',
    hreflang: ['nl'],
    endonym: 'Nederlands',
    name: 'Dutch',
    script: 'Latn',
    dir: 'ltr',
    flag: 'NL',
    ogLocale: 'nl_NL',
    cldr: 'nl',
    built: true,
    style: 'Standard Dutch press style of the Netherlands (NOS, ANP register).',
  },
  {
    tag: 'pl',
    path: 'pl',
    hreflang: ['pl'],
    endonym: 'Polski',
    name: 'Polish',
    script: 'Latn',
    dir: 'ltr',
    flag: 'PL',
    ogLocale: 'pl_PL',
    cldr: 'pl',
    built: true,
    style: 'Standard Polish press style (PAP register), „ ” quotes.',
  },
] as const satisfies readonly NewsLocale[];

export type NewsLocaleTag = (typeof NEWS_LOCALES)[number]['tag'];

export const NEWS_DEFAULT_LOCALE = 'en' satisfies NewsLocaleTag;

/** localStorage key of the reader's own pick: a NEWS_LOCALES tag ('en' for English). */
export const NEWS_LOCALE_STORAGE_KEY = 'makefun:news-locale:v1';

export const NEWS_LOCALE_TAGS: readonly NewsLocaleTag[] = NEWS_LOCALES.map((l) => l.tag);

/** The rows that are built: served under their path, translated, matched to readers. */
export const NEWS_BUILT_LOCALES: readonly NewsLocale[] = (NEWS_LOCALES as readonly NewsLocale[]).filter((l) => l.built);

const BY_TAG: ReadonlyMap<string, NewsLocale> = new Map(NEWS_LOCALES.map((l) => [l.tag, l]));
const BY_PATH: ReadonlyMap<string, NewsLocale> = new Map(
  (NEWS_LOCALES as readonly NewsLocale[]).filter((l) => l.path !== '').map((l) => [l.path, l]),
);

/** The row of a tag (exact, as NEWS_LOCALES writes it), or undefined. */
export function newsLocale(tag: string): NewsLocale | undefined {
  return BY_TAG.get(tag);
}

export function isNewsLocaleTag(tag: string): tag is NewsLocaleTag {
  return BY_TAG.has(tag);
}

/**
 * Language ranges (lowercase) the RFC 4647 truncation alone gets wrong, CLDR's likely-script reading of them: zh-TW is
 * written in Traditional, not in zh's Simplified; in is Indonesian's withdrawn code (old Java and Android); pa-Arab and
 * pa-PK read Shahmukhi, which the Gurmukhi pa page is not, so they match nothing and the next preference is tried.
 * Every other range truncates to its locale (es-MX -> es, pt-PT -> pt, zh-Hant-HK -> zh-Hant, zh-Hans-SG -> zh-Hans).
 */
export const NEWS_LOCALE_ALIASES: readonly (readonly [range: string, tag: NewsLocaleTag | null])[] = [
  ['zh', 'zh-Hans'],
  ['zh-cn', 'zh-Hans'],
  ['zh-sg', 'zh-Hans'],
  ['zh-tw', 'zh-Hant'],
  ['zh-hk', 'zh-Hant'],
  ['zh-mo', 'zh-Hant'],
  ['in', 'id'],
  ['pa-arab', null],
  ['pa-pk', null],
];

/**
 * The table the bare pages' boot script inlines (JSON-able, a few hundred bytes), and the only input matchNewsLocale
 * reads, so the script and the server match alike:
 *   locales  [tag, path] for each locale a reader may be sent to, English ('') included
 *   aliases  [lowercase range, tag or null]: a range that resolves to that tag, or (null) to nothing
 * The boot script's lookup: lowercase the preference, then for it and each truncation (drop the last subtag, and a
 * single-character subtag left before it) take the first that is an alias (null: give up on this preference) or a
 * locale's lowercased tag. The first preference that resolves wins; with none, 'en'.
 */
export interface NewsLocaleBootTable {
  readonly locales: readonly (readonly [tag: string, path: string])[];
  readonly aliases: readonly (readonly [range: string, tag: string | null])[];
}

/**
 * The boot table over a set of tags (default: every built locale). English is always in it. An alias whose locale is
 * not in the set, and the tag of a locale not in it, resolve to nothing (a zh-TW or zh-Hant reader is not sent to
 * Simplified when Traditional is off). Throws on a tag that is not a NEWS_LOCALES tag.
 */
export function newsLocaleBootTable(tags?: readonly string[]): NewsLocaleBootTable {
  if (tags) {
    for (const tag of tags) if (!BY_TAG.has(tag)) throw new RangeError(`not a news locale: ${JSON.stringify(tag)}`);
  }
  const wanted = new Set<string>(tags ?? NEWS_BUILT_LOCALES.map((l) => l.tag));
  wanted.add(NEWS_DEFAULT_LOCALE);
  const rows = (NEWS_LOCALES as readonly NewsLocale[]).filter((l) => wanted.has(l.tag));
  const left = (NEWS_LOCALES as readonly NewsLocale[]).filter((l) => !wanted.has(l.tag));
  return {
    locales: rows.map((l) => [l.tag, l.path] as const),
    aliases: [
      ...NEWS_LOCALE_ALIASES.map(([range, tag]) => [range, tag !== null && wanted.has(tag) ? tag : null] as const),
      // A locale left out matches nothing, so its readers never truncate to a sibling (zh-Hant to zh's Simplified).
      ...left.map((l) => [l.tag.toLowerCase(), null] as const),
    ],
  };
}

/** The boot table of the built locales. */
export const NEWS_LOCALE_BOOT_TABLE: NewsLocaleBootTable = newsLocaleBootTable();

/** A preference as a lowercase range: trimmed, '_' as '-', any ';q=' weight dropped; '' for nothing usable or '*'. */
function rangeOf(preference: string): string {
  const range = preference.split(';')[0]!.trim().toLowerCase().replace(/_/g, '-');
  return range === '*' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(range) ? '' : range;
}

/**
 * The locale for a reader's languages, most preferred first (navigator.languages; Accept-Language entries are taken
 * too). Each preference in turn is looked up (RFC 4647 section 3.4) against the table's aliases and locale tags; the
 * first that resolves to any locale in the table wins, English included (['en-US', 'es'] -> 'en'); with none, 'en'.
 */
export function matchNewsLocale(preferences: readonly string[], table: NewsLocaleBootTable = NEWS_LOCALE_BOOT_TABLE): string {
  const aliases = new Map<string, string | null>(table.aliases);
  const tags = new Map<string, string>(table.locales.map(([tag]) => [tag.toLowerCase(), tag]));
  for (const preference of preferences) {
    const subtags = rangeOf(preference).split('-');
    resolve: while (subtags.length > 0 && subtags[0] !== '') {
      const range = subtags.join('-');
      if (aliases.has(range)) {
        const tag = aliases.get(range)!;
        if (tag !== null && tags.has(tag.toLowerCase())) return tags.get(tag.toLowerCase())!;
        break resolve;
      }
      const tag = tags.get(range);
      if (tag !== undefined) return tag;
      subtags.pop();
      if (subtags.length > 1 && subtags[subtags.length - 1]!.length === 1) subtags.pop();
    }
  }
  return NEWS_DEFAULT_LOCALE;
}

/** The locale whose path is this segment exactly (lowercase, as NEWS_LOCALES writes it), or undefined. Built or not. */
export function newsLocaleOfSegment(segment: string): NewsLocale | undefined {
  return BY_PATH.get(segment);
}

/**
 * A news-host pathname's locale and the path under it: '/es/2026-11-19' -> { locale: 'es', rest: '/2026-11-19' },
 * '/es' and '/es/' -> rest '/', '/2026-11-19' -> { locale: 'en', rest: '/2026-11-19' }. The prefix is matched exactly
 * (lowercase), against every row, built or not; '/en/...' is no prefix (English is unprefixed; the server 301s it).
 */
export function localeOfPath(pathname: string): { locale: string; rest: string } {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const row = m ? BY_PATH.get(m[1]!) : undefined;
  if (!m || !row) return { locale: NEWS_DEFAULT_LOCALE, rest: pathname };
  return { locale: row.tag, rest: m[2] ?? '/' };
}

/** Whether a pathname sits under a locale prefix ('/es/…', '/zh-hans'); English paths never do. */
export function isLocalePath(pathname: string): boolean {
  return localeOfPath(pathname).locale !== NEWS_DEFAULT_LOCALE;
}

/**
 * A news-host path in a locale: ('es', '/2026-11-19') -> '/es/2026-11-19', ('es', '/') -> '/es/', ('en', '/x') -> '/x'.
 * A query or hash rides along ('/?region=asia#story-3'), and a path already under a locale prefix moves to this one,
 * so the picker can hand it the current location. Throws on a tag that is not a NEWS_LOCALES tag.
 */
export function localizedPath(locale: string, path: string): string {
  const row = BY_TAG.get(locale);
  if (!row) throw new RangeError(`not a news locale: ${JSON.stringify(locale)}`);
  const cut = path.search(/[?#]/);
  const pathname = cut < 0 ? path : path.slice(0, cut);
  const tail = cut < 0 ? '' : path.slice(cut);
  const rest = localeOfPath(pathname.startsWith('/') ? pathname : `/${pathname}`).rest;
  return row.path === '' ? `${rest}${tail}` : `/${row.path}${rest}${tail}`;
}

// ---------------------------------------------------------------- any other language, on demand

/** New on-demand (day, tag) translations started site-wide per UTC day, at most (counted from news_translation rows). */
export const NEWS_ON_DEMAND_PER_UTC_DAY = 12;
/** On-demand tags (beyond NEWS_LOCALES) one edition day may be translated into, at most. */
export const NEWS_ON_DEMAND_PER_EDITION = 6;
/** The 202's Retry-After while a day is translated into an on-demand tag: an estimate, about a translation's time. */
export const NEWS_ON_DEMAND_RETRY_AFTER_S = 90;

/** A tag's shape as news_translation_locale_shape holds it: a language, an optional script, an optional region. */
const TRANSLATED_SHAPE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/**
 * Whether an edition may be stored translated into `tag`: a canonical BCP 47 tag (as Intl.getCanonicalLocales writes it:
 * 'zh-Hans', never 'zh-hans'; 'he', never 'iw') of news_translation's shape, naming a language (never 'und') other than
 * the source's ('en'). A NEWS_LOCALES tag, or any other (an on-demand one).
 */
export function isTranslatedNewsLocale(tag: string): boolean {
  if (!TRANSLATED_SHAPE.test(tag) || tag === NEWS_DEFAULT_LOCALE || tag === 'und') return false;
  try {
    return Intl.getCanonicalLocales(tag)[0] === tag;
  } catch {
    return false;
  }
}

/** Language codes that name no language to translate into: no linguistic content, several, uncoded, undetermined. */
const NO_LANGUAGE = new Set(['zxx', 'mul', 'mis', 'und']);
/** Private-use and special subtags (BCP 47): languages qaa-qtz, scripts Qaaa-Qabx and Z*, regions AA, QM-QZ, XA-XZ, ZZ. */
const PRIVATE_LANGUAGE = /^q[a-t][a-z]$/;
const SPECIAL_SCRIPT = /^(Qa[a-b][a-z]|Z[a-z]{3})$/;
const PRIVATE_REGION = /^(AA|Q[M-Z]|X[A-Z]|ZZ)$/;

let languageNames: Intl.DisplayNames | null | undefined;

/**
 * `tag`'s language in English, as Intl names it ('he' -> 'Hebrew', 'sr-Latn' -> 'Serbian (Latin)'); null when Intl
 * names none (qaa, xx, und), when its language alone has no name, or for a tag Intl refuses.
 */
export function newsLanguageName(tag: string): string | null {
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    } catch {
      languageNames = null;
    }
  }
  if (languageNames === null) return null;
  try {
    const language = tag.split('-')[0]!;
    const own = languageNames.of(language);
    if (own === undefined || own.toLowerCase() === language.toLowerCase()) return null;
    const name = languageNames.of(tag);
    return name === undefined || name.toLowerCase() === tag.toLowerCase() ? null : name;
  } catch {
    return null;
  }
}

/** Every NEWS_LOCALES row's boot table, built or not: what a tag that reads as one of them resolves to (resolveNewsLang). */
const EVERY_LOCALE_TABLE: NewsLocaleBootTable = newsLocaleBootTable(NEWS_LOCALE_TAGS);

/** A raw tag in its canonical form ('IW' -> 'he', 'zh_tw' -> 'zh-TW'), null when it is no BCP 47 tag. */
function canonicalTag(raw: string): string | null {
  const t = raw.trim().replace(/_/g, '-');
  if (t === '' || !/^[A-Za-z0-9-]+$/.test(t)) return null;
  try {
    return Intl.getCanonicalLocales(t)[0] ?? null;
  } catch {
    return null;
  }
}

/** The NEWS_LOCALES tag a canonical tag reads as (RFC 4647 lookup over every row and the aliases), or null for none. */
function newsLocaleReadAs(tag: string): string | null {
  const m = matchNewsLocale([tag], EVERY_LOCALE_TABLE);
  return m === NEWS_DEFAULT_LOCALE ? null : m;
}

/** Whether a canonical tag is one the site may translate into on demand: valid, named, and no private or special code. */
function onDemandShape(tag: string): boolean {
  if (!isTranslatedNewsLocale(tag)) return false;
  const [language, ...rest] = tag.split('-');
  if (NO_LANGUAGE.has(language!) || PRIVATE_LANGUAGE.test(language!)) return false;
  for (const sub of rest) if (SPECIAL_SCRIPT.test(sub) || PRIVATE_REGION.test(sub)) return false;
  return newsLanguageName(tag) !== null;
}

/**
 * The written language a canonical tag names: its language subtag, and its script only where that is not the
 * language's own likeliest (Intl.Locale maximize), the region dropped: he-IL, he-001 and he-419 are 'he'; sr and sr-Cyrl
 * are 'sr', sr-Latn and sr-ME (written in Latin) 'sr-Latn'; uz-Cyrl stays, uz-AF is 'uz-Arab'; pa-PK is 'pa-Arab'. The
 * tag itself when Intl reads none.
 */
function writtenLanguageOf(tag: string): string {
  try {
    const max = new Intl.Locale(tag).maximize();
    const own = new Intl.Locale(max.language).maximize().script;
    const written = max.script !== undefined && max.script !== own ? `${max.language}-${max.script}` : max.language;
    return Intl.getCanonicalLocales(written)[0] ?? tag;
  } catch {
    return tag;
  }
}

/**
 * A canonical tag that reads as no NEWS_LOCALES locale and is no English one, as an on-demand tag: null when it is no
 * shape the site translates into (onDemandShape), else its written language (writtenLanguageOf) when that is one too and
 * still reads as no NEWS_LOCALES locale, else the tag. One row per written language, so region variants never spend the
 * on-demand caps apart.
 */
function onDemandOfCanonical(tag: string): string | null {
  if (!onDemandShape(tag)) return null;
  const written = writtenLanguageOf(tag);
  return written !== tag && newsLocaleReadAs(written) === null && onDemandShape(written) ? written : tag;
}

/**
 * Any other language a reader may ask for (`raw` in any case, '_' read as '-'): when it is valid BCP 47 of a language,
 * an optional script and an optional region, a language Intl names in English (newsLanguageName), no private-use or
 * special code (qaa, Zyyy, XA, und, zxx, mul), not English (en-*) and not one that reads as a NEWS_LOCALES locale (es-MX
 * is es, zh-TW is zh-Hant: the locale's own pages answer those), its written language in canonical form: the language,
 * plus its script where that is not the language's own ('he-IL' is 'he', 'sr-Latn-RS' 'sr-Latn', 'sr-Cyrl' 'sr'), so
 * every region variant of one language is one translation; null otherwise.
 */
export function onDemandNewsTag(raw: string): string | null {
  const tag = canonicalTag(raw);
  if (tag === null || tag.split('-')[0] === NEWS_DEFAULT_LOCALE || newsLocaleReadAs(tag) !== null) return null;
  return onDemandOfCanonical(tag);
}

/** What a ?lang= value names (resolveNewsLang). */
export type NewsLangResolution =
  /** English: 'en' or any en-* tag. */
  | { kind: 'en' }
  /** a locale this server serves (it, or a tag that reads as it: es-MX, zh-TW) */
  | { kind: 'built'; tag: string }
  /** a NEWS_LOCALES locale this server does not serve, or (on demand off) any other valid language */
  | { kind: 'unserved'; tag: string }
  /** any other language, translated on first request */
  | { kind: 'on-demand'; tag: string }
  /** no valid language tag (xx-yy-zz, und, qaa) */
  | { kind: 'invalid' };

/**
 * A ?lang= value (or a path's prefix) read against the locales this server serves (`served`, NEWS_LOCALES tags) and
 * whether it translates other languages on demand: 'en' and en-* are English; a served tag (matched without regard to
 * case) or a tag that reads as one (es-MX, zh-TW: RFC 4647 lookup with NEWS_LOCALE_ALIASES) is that locale; a tag that
 * reads as a NEWS_LOCALES locale not served is unserved; any other valid language (onDemandNewsTag) is on-demand when
 * `onDemand`, else unserved, as its written language ('he-IL' is 'he', 'sr-Latn-RS' 'sr-Latn'); anything else is invalid.
 */
export function resolveNewsLang(raw: string, served: readonly string[], onDemand: boolean): NewsLangResolution {
  const want = raw.trim().toLowerCase();
  if (want === NEWS_DEFAULT_LOCALE) return { kind: 'en' };
  const exact = served.find((t) => t.toLowerCase() === want);
  if (exact !== undefined) return { kind: 'built', tag: exact };
  const tag = canonicalTag(raw);
  if (tag === null) return { kind: 'invalid' };
  if (tag.split('-')[0] === NEWS_DEFAULT_LOCALE) return { kind: 'en' };
  const readAs = newsLocaleReadAs(tag);
  if (readAs !== null) return served.includes(readAs) ? { kind: 'built', tag: readAs } : { kind: 'unserved', tag: readAs };
  const written = onDemandOfCanonical(tag);
  if (written === null) return { kind: 'invalid' };
  return onDemand ? { kind: 'on-demand', tag: written } : { kind: 'unserved', tag: written };
}

/** The path segment of a locale's prefix: its NEWS_LOCALES row's path ('zh-hans'), else (an on-demand tag) the tag lowercased. */
export function newsLangPrefixOf(tag: string): string {
  return BY_TAG.get(tag)?.path ?? tag.toLowerCase();
}

/**
 * A news-host path in a language: localizedPath for a NEWS_LOCALES tag ('/es/2026-11-19'), English bare, and an
 * on-demand tag under its lowercased tag ('he', '/2026-11-19.md' -> '/he/2026-11-19.md'), a NEWS_LOCALES prefix the path
 * carried taken off first. A query or hash rides along.
 */
export function newsPathIn(tag: string, path: string): string {
  if (BY_TAG.has(tag)) return localizedPath(tag, path);
  const bare = localizedPath(NEWS_DEFAULT_LOCALE, path);
  return `/${tag.toLowerCase()}${bare.startsWith('/') ? bare : `/${bare}`}`;
}

/**
 * The on-demand tag a path segment names: the tag whose lowercased canonical form is exactly `segment` ('he', 'sr-latn'),
 * valid on demand (onDemandNewsTag); null for any other segment (a NEWS_LOCALES path, an alias such as 'iw', no tag).
 */
export function onDemandTagOfSegment(segment: string): string | null {
  if (segment !== segment.toLowerCase() || !/^[a-z]{2,3}(-[a-z0-9]{2,4}){0,2}$/.test(segment) || BY_PATH.has(segment)) return null;
  const tag = onDemandNewsTag(segment);
  return tag !== null && tag.toLowerCase() === segment ? tag : null;
}
