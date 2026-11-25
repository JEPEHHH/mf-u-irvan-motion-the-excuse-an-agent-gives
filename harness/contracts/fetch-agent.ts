// The User-Agent every outbound GET of ours to a third-party host sends: a normal browser's. Some hosts close a
// connection that sends no User-Agent at all: on 2026-11-13 a real launch's pump.fun metadata at pomf2.lain.la
// faulted four times with undici's default (no UA -> UND_ERR_SOCKET "other side closed" in about 100 ms), where a
// browser's or curl's answered 200. One constant for every fetch of the class (pump.fun's metadata and image reads,
// GeckoTerminal's OHLCV, Raydium's and Orca's pool APIs, xStocks' asset list, Nasdaq Trader's symbol directory,
// OpenAI's connectors list), so a collector or server module needs no other module's graph for one string.
//
// A leaf: no imports at all.

/**
 * A normal browser's User-Agent: what every outbound GET of ours to a third-party host sends. A host may refuse,
 * throttle or close a request that sends none (undici's default), and one did (see the header).
 */
export const BROWSER_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
