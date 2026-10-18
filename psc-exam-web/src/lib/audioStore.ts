/** 本次会话的录音暂存（Blob + objectURL），不落盘、不上传其他位置 */

export interface StoredAudio {
  url: string;
  blob: Blob;
  durationSec: number;
}

const store = new Map<string, StoredAudio>();

const keyOf = (examId: string, section: string): string => `${examId}::${section}`;

export function putAudio(examId: string, section: string, blob: Blob, durationSec: number): void {
  const k = keyOf(examId, section);
  const prev = store.get(k);
  if (prev) URL.revokeObjectURL(prev.url);
  store.set(k, { url: URL.createObjectURL(blob), blob, durationSec });
}

export function getAudio(examId: string, section: string): StoredAudio | undefined {
  return store.get(keyOf(examId, section));
}

export function clearExamAudio(examId: string): void {
  for (const [k, v] of store) {
    if (k.startsWith(`${examId}::`)) {
      URL.revokeObjectURL(v.url);
      store.delete(k);
    }
  }
}
