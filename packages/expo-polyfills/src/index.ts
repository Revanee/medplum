import { ClientStorage, IClientStorage, MemoryStorage, OperationOutcomeError } from '@medplum/core';
import { decode, encode } from 'base-64';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import expoWebCrypto from 'expo-standard-web-crypto';
import { Platform } from 'react-native';
import { setupURLPolyfill } from 'react-native-url-polyfill';
import { TextDecoder, TextEncoder } from 'text-encoding';

let polyfilled = false;
let originalCryptoIsSet = false;
let originalCrypto: Crypto | undefined;

export type ExtendedExpoCrypto = typeof expoWebCrypto & {
  subtle: {
    digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;
  };
};

export type PolyfillEnabledConfig = {
  crypto?: boolean;
  location?: boolean;
  sessionStorage?: boolean;
  textEncoder?: boolean;
  btoa?: boolean;
};

export function cleanupMedplumWebAPIs(): void {
  if (Platform.OS === 'web' || !polyfilled) {
    return;
  }
  if (window.crypto) {
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      enumerable: true,
      value: originalCrypto,
    });
    Object.defineProperty(expoWebCrypto, 'subtle', {
      configurable: true,
      enumerable: false,
      value: undefined,
    });
    originalCrypto = undefined;
    originalCryptoIsSet = false;
  }
  if (window.location) {
    Object.defineProperty(window, 'location', { configurable: true, enumerable: true, value: undefined });
  }
  if (window.sessionStorage) {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });
  }
  if (window.TextEncoder) {
    Object.defineProperty(window, 'TextEncoder', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });
  }
  if (window.TextDecoder) {
    Object.defineProperty(window, 'TextDecoder', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });
  }
  // @ts-expect-error Typescript thinks `btoa` is always defined
  if (window.btoa) {
    Object.defineProperty(window, 'btoa', { configurable: true, enumerable: true, value: undefined });
  }
  // @ts-expect-error Typescript thinks `atob` is always defined
  if (window.atob) {
    Object.defineProperty(window, 'atob', { configurable: true, enumerable: true, value: undefined });
  }

  polyfilled = false;
}

export function polyfillMedplumWebAPIs(config?: PolyfillEnabledConfig): void {
  if (Platform.OS === 'web' || polyfilled) {
    return;
  }
  if (
    config?.crypto !== false &&
    (typeof window.crypto?.subtle?.digest === 'undefined' || typeof window.crypto.getRandomValues === 'undefined')
  ) {
    // eslint-disable-next-line no-inner-declarations
    async function polyfilledDigest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
      return digest(algorithm as CryptoDigestAlgorithm, data);
    }

    // We can't do a check for `originalCrypto === undefined` because the original value for `window.crypto` could be undefined itself
    // Resulting in an ambiguity and setting `originalCrypto = window.crypto` potentially after `window.crypto` has already been polyfilled
    if (!originalCryptoIsSet) {
      originalCrypto = window.crypto;
      originalCryptoIsSet = true;
    }

    // @ts-expect-error Subtle not polyfilled by default with ExpoWebCrypto
    if (expoWebCrypto.subtle === undefined) {
      const subtlePolyfill = { digest: polyfilledDigest };
      Object.defineProperty(expoWebCrypto, 'subtle', {
        configurable: true,
        get: () => subtlePolyfill,
      });
    }

    Object.defineProperty(window, 'crypto', {
      configurable: true,
      enumerable: true,
      get: () => expoWebCrypto,
    });
  }

  if (config?.location !== false && typeof window.location === 'undefined') {
    setupURLPolyfill();
    const locationUrl = new URL('/', 'http://localhost') as URL & { assign: () => void };
    locationUrl.assign = () => {};
    Object.defineProperty(window, 'location', {
      value: locationUrl,
      configurable: true,
    });
  }

  let _sessionStorage: Storage;
  if (config?.sessionStorage !== false && typeof window.sessionStorage === 'undefined') {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      enumerable: true,
      get: () => (_sessionStorage ??= new MemoryStorage()),
    });
  }

  if (config?.textEncoder !== false && typeof window.TextEncoder === 'undefined') {
    Object.defineProperty(window, 'TextEncoder', {
      configurable: true,
      enumerable: true,
      get: () => TextEncoder,
    });
  }

  if (config?.textEncoder !== false && typeof window.TextDecoder === 'undefined') {
    Object.defineProperty(window, 'TextDecoder', {
      configurable: true,
      enumerable: true,
      get: () => TextDecoder,
    });
  }

  if (config?.btoa !== false && typeof window.btoa === 'undefined') {
    Object.defineProperty(window, 'btoa', {
      configurable: true,
      enumerable: true,
      get: () => encode,
    });
  }

  if (config?.btoa !== false && typeof window.atob === 'undefined') {
    Object.defineProperty(window, 'atob', {
      configurable: true,
      enumerable: true,
      get: () => decode,
    });
  }

  polyfilled = true;
}

class SyncSecureStorage implements Storage {
  private readonly storage: Map<string, string>;
  private readonly initPromise: Promise<void>;
  private initialized = false;

  constructor() {
    this.storage = new Map<string, string>();
    this.initPromise = new Promise((resolve) => {
      // Fetch ::keys::
      SecureStore.getItemAsync('___keys___')
        .then((keysStr) => {
          if (!keysStr) {
            // No keys currently, just resolve
            this.initialized = true;
            resolve();
            return;
          }
          // Parse keys
          const keys = JSON.parse(keysStr) as string[];
          const promises = keys.map((key) => {
            return new Promise<[string, string | null]>((resolve) => {
              SecureStore.getItemAsync(key)
                .then((val) => {
                  resolve([key, val]);
                })
                .catch(console.error);
            });
          });
          Promise.all(promises)
            .then((values) => {
              for (const [key, value] of values) {
                if (!value) {
                  continue;
                }
                this.storage.set(key, value);
              }
              this.initialized = true;
              resolve();
            })
            .catch(console.error);
        })
        .catch(console.error);
    });
  }

  getInitPromise(): Promise<void> {
    return this.initPromise;
  }

  assertInitialized(): void {
    if (!this.initialized) {
      throw new OperationOutcomeError({
        id: 'not-initialized',
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'exception',
            details: {
              text: 'Not initialized',
            },
            diagnostics: 'Storage not initialized',
          },
        ],
      });
    }
  }

  get length(): number {
    this.assertInitialized();
    return this.storage.size;
  }

  /**
   * Clears the storage and sets keys.
   */
  clear(): void {
    this.assertInitialized();
    // Start clearing out each key in background
    for (const key of this.storage.keys()) {
      this.removeItem(key, false);
    }
    // Clear map
    this.storage.clear();
    this.setKeys();
  }

  private setKeys(): void {
    SecureStore.setItemAsync('___keys___', JSON.stringify(Array.from(this.storage.keys()))).catch(console.error);
  }

  /**
   * Returns the current value associated with the given key, or null if the given key does not exist.
   * @param key - The specified storage key.
   * @returns The current value associated with the given key, or null if the given key does not exist.
   */
  getItem(key: string): string | null {
    this.assertInitialized();
    return this.storage.get(key) ?? null;
  }

  /**
   * Sets the value of the pair identified by key to value, creating a new key/value pair if none existed for key previously.
   * @param key - The storage key.
   * @param value - The new value.
   */
  setItem(key: string, value: string | null): void {
    this.assertInitialized();
    // Set key in background, or delete it if the value is null
    if (!value) {
      this.removeItem(key);
    } else {
      SecureStore.setItemAsync(key, value).catch(console.error);
      this.storage.set(key, value);
    }
    this.setKeys();
  }

  /**
   * Removes the key/value pair with the given key, if a key/value pair with the given key exists.
   * @param key - The storage key.
   * @param setKeys - Whether to call `this.setKeys()` after deleting the key. Defaults to `true`.
   */
  removeItem(key: string, setKeys = true): void {
    this.assertInitialized();
    SecureStore.deleteItemAsync(key).catch(console.error);
    this.storage.delete(key);
    if (setKeys) {
      this.setKeys();
    }
  }

  /**
   * This is a stub. Returns `null`.
   * @param _index - The numeric index. Ignored.
   * @returns `null`.
   */
  key(_index: number): string | null {
    this.assertInitialized();
    return null;
  }
}

export interface IExpoClientStorage extends IClientStorage {
  getInitPromise(): Promise<void>;
  length: number;
}

/**
 * Provides a wrapper around Expo's `SecureStore` package which provides a persistent and secure storage on mobile.
 *
 * This class is necessary for use with `MedplumClient` since `MedplumClient` expects `ClientStorage` to use a synchronous interface, and `SecureStore` uses an asynchronous one.
 *
 * On web, this class will instead wrap `localStorage` automatically, so there is no need to conditionally omit passing this to `MedplumClient` for React Native Web.
 */
export class ExpoClientStorage extends ClientStorage implements IExpoClientStorage {
  // We keep a private reference to the storage we pass in so we can use it within this subclass too...
  private secureStorage?: SyncSecureStorage;
  constructor() {
    // Metro should automatically prune these branches out at compile time
    if (Platform.OS === 'web') {
      super(globalThis.localStorage);
    } else {
      const storage = new SyncSecureStorage();
      super(storage);
      this.secureStorage = storage;
    }
  }
  getInitPromise(): Promise<void> {
    if (Platform.OS === 'web') {
      return Promise.resolve();
    }
    return (this.secureStorage as SyncSecureStorage).getInitPromise();
  }
  get length(): number {
    if (Platform.OS === 'web') {
      return globalThis.localStorage.length;
    }
    return (this.secureStorage as SyncSecureStorage).length;
  }
}
