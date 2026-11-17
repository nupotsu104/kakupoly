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
// projects: 一覧用の情報（名前・日時・サムネイル）。blobs: 作品の中身。
// 一覧を出すだけで全作品の中身（大きな作品は1つ10MB前後）を読まないよう、版2で分けた。
// 版1の保存（projects に中身も入っている）もそのまま読める。
const DB_NAME = 'kakupoly';
const STORE = 'projects';
const BLOBS = 'blobs';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface StoredProject {
  id: string;
  name: string;
  updated: number;
  thumb?: string;
  /** 中身。新しい保存は gzip 圧縮した .kpoly（ArrayBuffer）、古い保存は .kpoly の文字列のまま */
  data?: string | ArrayBuffer;
  /** 保存した大きさ（バイト） */
  size?: number;
}

/** 作品を、端末内に保存する形（gzip 圧縮した .kpoly）にする。大きな作品で 1/4 ほどになる */
export async function packDoc(doc: Doc): Promise<ArrayBuffer> {
  const stream = new Blob([serialize(doc)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** 端末内に保存した形から作品に戻す（古い文字列の保存にも対応） */
export async function unpackDoc(data: string | ArrayBuffer): Promise<Doc> {
  if (typeof data === 'string') return deserialize(data);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return deserialize(await new Response(stream).text());
}

/** 端末内の保存領域の使用量と上限（分からなければ null） */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && e.quota ? { usage: e.usage ?? 0, quota: e.quota } : null;
  } catch {
    return null;
  }
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('保存が中断されました'));
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const storage = {
  /** 中身と一覧用の情報を1つの処理で保存（どちらかだけ書かれることがないように） */
  async put(p: StoredProject): Promise<void> {
    const db = await openDB();
    try {
      const t = db.transaction([STORE, BLOBS], 'readwrite');
      const { data, ...meta } = p;
      t.objectStore(BLOBS).put(data, p.id);
      t.objectStore(STORE).put(meta);
      await done(t);
    } finally {
      db.close();
    }
  },
  async get(id: string): Promise<StoredProject | undefined> {
    const db = await openDB();
    try {
      const t = db.transaction([STORE, BLOBS], 'readonly');
      const meta = await req(t.objectStore(STORE).get(id) as IDBRequest<StoredProject | undefined>);
      if (!meta) return undefined;
      if (meta.data !== undefined) return meta; // 版1の保存
      const data = await req(t.objectStore(BLOBS).get(id) as IDBRequest<string | ArrayBuffer | undefined>);
      return data === undefined ? undefined : { ...meta, data };
    } finally {
      db.close();
    }
  },
  async remove(id: string): Promise<void> {
    const db = await openDB();
    try {
      const t = db.transaction([STORE, BLOBS], 'readwrite');
      t.objectStore(STORE).delete(id);
      t.objectStore(BLOBS).delete(id);
      await done(t);
    } finally {
      db.close();
    }
  },
  /** 一覧（中身は読まない。版1の保存だけは中身ごと読まれるが、次に保存した時に版2の形へ移る） */
  async list(): Promise<Omit<StoredProject, 'data'>[]> {
    const db = await openDB();
    try {
      const out: Omit<StoredProject, 'data'>[] = [];
      const t = db.transaction(STORE, 'readonly');
      await new Promise<void>((resolve, reject) => {
        const c = t.objectStore(STORE).openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return resolve();
          const { data: _d, ...meta } = cur.value as StoredProject;
          out.push(meta);
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      return out.sort((a, b) => b.updated - a.updated);
    } finally {
      db.close();
    }
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
