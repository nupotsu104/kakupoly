// 独自形式 .kpoly（JSON）の保存・読み込みと、端末内（IndexedDB）への自動保存
import type { Doc, Texture } from '../core/types';
import { DEFAULT_PALETTE } from '../core/doc';

const b64 = {
  enc(u8: Uint8Array): string {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(s: string): Uint8Array {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};

export function serialize(doc: Doc): string {
  return JSON.stringify({
    ...doc,
    format: 'kakupoly',
    textures: doc.textures.map((t) => ({ ...t, data: b64.enc(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)) })),
  });
}

export function deserialize(text: string): Doc {
  const j = JSON.parse(text);
  if (j.format !== 'kakupoly' || j.version !== 1) throw new Error('KakuPoly のファイルではありません');
  const textures: Texture[] = (j.textures ?? []).map((t: Texture & { data: string }) => {
    const data = new Uint8ClampedArray(b64.dec(t.data).buffer);
    if (data.length !== t.w * t.h * 4) throw new Error(`テクスチャ ${t.name} のデータが壊れています`);
    return { ...t, data };
  });
  const doc: Doc = {
    version: 1,
    name: String(j.name ?? '無題'),
    objects: j.objects ?? [],
    textures,
    bones: j.bones ?? [],
    clips: j.clips ?? [],
    palette: Array.isArray(j.palette) && j.palette.length ? j.palette : [...DEFAULT_PALETTE],
    nextId: Number(j.nextId) || 1,
  };
  for (const o of doc.objects) {
    while (o.skin.length < o.verts.length) o.skin.push([]);
    o.visible ??= true;
    o.doubleSided ??= false;
  }
  return doc;
}

// ---------- IndexedDB ----------
const DB_NAME = 'kakupoly';
const STORE = 'projects';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface StoredProject {
  id: string;
  name: string;
  updated: number;
  thumb?: string;
  data: string;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    t.oncomplete = () => db.close();
  });
}

export const storage = {
  put: (p: StoredProject) => tx('readwrite', (s) => s.put(p)),
  get: (id: string) => tx<StoredProject | undefined>('readonly', (s) => s.get(id)),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
  async list(): Promise<Omit<StoredProject, 'data'>[]> {
    const all = await tx<StoredProject[]>('readonly', (s) => s.getAll());
    return all.map(({ data: _d, ...rest }) => rest).sort((a, b) => b.updated - a.updated);
  },
};

/** ブラウザに「消さないで」と頼む（ホーム画面のWebアプリ / ネイティブ包みでは通りやすい） */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
