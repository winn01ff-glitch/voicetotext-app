// Cache âm thanh đã ghi/upload trong trình duyệt.
//
// Yêu cầu: audio phải sống sót qua reload trang, và chỉ bị xóa khi người dùng
// đóng trình duyệt (kết thúc phiên). Blob URL không đáp ứng được vì nó chết ngay
// khi trang tạo ra nó bị unload. Vì vậy ta lưu chính bytes audio (Blob) vào
// IndexedDB — nơi chứa được dữ liệu nhị phân lớn và tồn tại qua reload.
//
// Để đạt đúng vòng đời "mất khi đóng trình duyệt", ta piggyback lên sessionStorage:
// sessionStorage tự bị xóa khi đóng tab/trình duyệt. Lần mở đầu tiên của một phiên
// mới sẽ không thấy cờ -> purge toàn bộ cache còn sót từ phiên trước, rồi đặt cờ.
// Reload trong cùng phiên vẫn thấy cờ -> không purge -> cache được giữ lại.

const DB_NAME = "voice_to_text";
const DB_VERSION = 1;
const STORE = "audio_cache";
const SESSION_FLAG = "audio_cache_session";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function clearAll(): Promise<void> {
  const db = await openDb();
  try {
    await runTx(db, "readwrite", (store) => store.clear());
  } finally {
    db.close();
  }
}

// Đảm bảo cache của phiên trình duyệt trước đã được dọn trước khi dùng cache mới.
// Chỉ purge một lần cho mỗi phiên (lần đầu tiên không thấy cờ sessionStorage).
async function ensureSessionFresh(): Promise<void> {
  if (typeof window === "undefined") return;
  if (sessionStorage.getItem(SESSION_FLAG)) return;
  try {
    await clearAll();
  } catch (err) {
    console.warn("[audio-cache] Không thể dọn cache phiên cũ:", err);
  } finally {
    // Đặt cờ kể cả khi purge lỗi để tránh purge lặp lại gây xóa nhầm dữ liệu vừa ghi.
    sessionStorage.setItem(SESSION_FLAG, "1");
  }
}

// Lưu Blob audio cho một cuộc họp. Ghi đè nếu đã tồn tại.
export async function putAudio(meetingId: string, blob: Blob): Promise<void> {
  if (typeof window === "undefined" || !meetingId || !blob) return;
  await ensureSessionFresh();
  const db = await openDb();
  try {
    await runTx(db, "readwrite", (store) => store.put(blob, meetingId));
  } finally {
    db.close();
  }
}

// Lấy Blob audio đã cache (hoặc null nếu không có / đã bị purge).
export async function getAudioBlob(meetingId: string): Promise<Blob | null> {
  if (typeof window === "undefined" || !meetingId) return null;
  await ensureSessionFresh();
  const db = await openDb();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(meetingId);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// Lấy một object URL mới trỏ tới audio đã cache. Trả về null nếu không có cache.
// Người gọi có trách nhiệm URL.revokeObjectURL(url) khi không dùng nữa.
export async function getAudioUrl(meetingId: string): Promise<string | null> {
  const blob = await getAudioBlob(meetingId);
  return blob ? URL.createObjectURL(blob) : null;
}

// Xóa audio đã cache của một cuộc họp (dùng khi xóa cuộc họp).
export async function deleteAudio(meetingId: string): Promise<void> {
  if (typeof window === "undefined" || !meetingId) return;
  const db = await openDb();
  try {
    await runTx(db, "readwrite", (store) => store.delete(meetingId));
  } catch (err) {
    console.warn("[audio-cache] Không thể xóa cache audio:", err);
  } finally {
    db.close();
  }
}
