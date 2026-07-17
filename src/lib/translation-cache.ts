const DB_NAME = "voice_to_text_translation_cache";
const DB_VERSION = 1;
const STORE = "raw_translations";

export interface RawTranslationCacheEntry {
  sourceFingerprint: string;
  targetLanguage: string;
  translations: string[];
  expiresAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getRawTranslationCache(meetingId: string): Promise<RawTranslationCacheEntry | null> {
  if (typeof window === "undefined" || !meetingId) return null;
  const db = await openDb();
  try {
    const entry = await new Promise<RawTranslationCacheEntry | null>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(meetingId);
      request.onsuccess = () => resolve((request.result as RawTranslationCacheEntry) || null);
      request.onerror = () => reject(request.error);
    });
    if (entry && entry.expiresAt <= Date.now()) {
      await new Promise<void>((resolve, reject) => {
        const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(meetingId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      return null;
    }
    return entry;
  } finally {
    db.close();
  }
}

export async function putRawTranslationCache(
  meetingId: string,
  entry: RawTranslationCacheEntry
): Promise<void> {
  if (typeof window === "undefined" || !meetingId) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(entry, meetingId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
