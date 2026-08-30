/**
 * Connection settings for the relay link.
 *
 * Mirrors `phone2-app/src/config.ts`. Defaults come from EXPO_PUBLIC_*
 * variables, which Expo inlines at bundle time; anything typed into the in-app
 * settings panel is persisted with expo-secure-store and wins, so one build can
 * be pointed at a different relay without a native rebuild.
 */

import * as SecureStore from 'expo-secure-store';

export interface Settings {
  /** Full wss:// URL including the path, e.g. wss://car.your-guide.co/car-ws */
  relayUrl: string;
  /** Shared secret the relay checks in the hello message. */
  token: string;
  /** Room to join. Must match the operator app's room. */
  room: string;
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: process.env.EXPO_PUBLIC_RELAY_URL ?? 'wss://car.your-guide.co/car-ws',
  token: process.env.EXPO_PUBLIC_RELAY_TOKEN ?? '',
  room: process.env.EXPO_PUBLIC_RELAY_ROOM ?? 'default',
};

/**
 * Tunables. These interact with the ESP32's 500 ms watchdog, so do not change
 * them casually — see docs/05-phone1-car-app.md §3 for the three-layer table.
 */
export const TUNING = {
  /**
   * How often the current output is rewritten to the ESP32, whether or not it
   * changed. This is the value the local UI has always used; the ESP32 zeroes
   * every output 500 ms after the last valid packet, so this must stay far
   * below that even after a few dropped writes.
   */
  usbKeepaliveMs: 150,

  /**
   * The network watchdog. If no control frame has arrived from the operator in
   * this long, zero the outputs locally instead of continuing to rewrite the
   * last command forever.
   *
   * The operator sends at least every 120 ms (its own keepalive), so 400 ms is
   * roughly three missed frames — long enough not to stutter on a hiccup, short
   * enough to beat the ESP32's 500 ms as the *second* line of defence rather
   * than the first.
   */
  networkWatchdogMs: 400,

  /** How often the watchdog condition is evaluated. */
  watchdogTickMs: 50,

  /** Reconnect backoff for the relay socket. */
  reconnectMinMs: 500,
  reconnectMaxMs: 8000,
} as const;

const KEYS: Record<keyof Settings, string> = {
  relayUrl: 'relayUrl',
  token: 'relayToken',
  room: 'relayRoom',
};

export async function loadSettings(): Promise<Settings> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as (keyof Settings)[]).map(async (key) => {
      try {
        return [key, await SecureStore.getItemAsync(KEYS[key])] as const;
      } catch {
        // A wiped keystore or a first launch on a restored backup: fall back to
        // the build-time defaults rather than failing to start.
        return [key, null] as const;
      }
    }),
  );

  const stored = Object.fromEntries(
    entries.filter(([, value]) => value !== null && value !== ''),
  ) as Partial<Settings>;

  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await Promise.all(
    (Object.keys(KEYS) as (keyof Settings)[]).map((key) =>
      SecureStore.setItemAsync(KEYS[key], settings[key]).catch(() => undefined),
    ),
  );
}

/** @returns an error string, or null when the settings are usable. */
export function validateSettings(settings: Settings): string | null {
  const url = settings.relayUrl.trim();
  if (url === '') return 'أدخل عنوان خادم الربط.';
  if (!/^wss?:\/\//i.test(url)) return 'العنوان يجب أن يبدأ بـ wss:// (أو ws:// للتجربة المحلية).';
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return 'العنوان يحتاج المسار أيضاً، مثل wss://host/car-ws';
    }
  } catch {
    return 'هذا ليس عنواناً صالحاً.';
  }
  return null;
}
