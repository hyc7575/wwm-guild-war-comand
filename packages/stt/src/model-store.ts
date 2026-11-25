import { totalBytes, type ModelFile, type ModelSpec } from './models';

/** 모델 바이트 저장소. Cache Storage가 기본이고 없으면 OPFS를 쓴다 */
export interface BlobStore {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, data: ArrayBuffer): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  readonly map = new Map<string, ArrayBuffer>();
  async get(key: string) {
    return this.map.get(key);
  }
  async put(key: string, data: ArrayBuffer) {
    this.map.set(key, data);
  }
  async has(key: string) {
    return this.map.has(key);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export class CacheStorageBlobStore implements BlobStore {
  constructor(private cacheName = 'winds-stt-models-v1') {}
  private open() {
    return caches.open(this.cacheName);
  }
  async get(key: string) {
    const r = await (await this.open()).match(key);
    return r ? r.arrayBuffer() : undefined;
  }
  async put(key: string, data: ArrayBuffer) {
    await (
      await this.open()
    ).put(key, new Response(data, { headers: { 'content-type': 'application/octet-stream' } }));
  }
  async has(key: string) {
    return (await (await this.open()).match(key)) !== undefined;
  }
  async delete(key: string) {
    await (await this.open()).delete(key);
  }
}

const opfsName = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_').slice(-200);

export class OpfsBlobStore implements BlobStore {
  constructor(private dirName = 'winds-stt-models-v1') {}
  private async dir() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(this.dirName, { create: true });
  }
  async get(key: string) {
    try {
      const fh = await (await this.dir()).getFileHandle(opfsName(key));
      return await (await fh.getFile()).arrayBuffer();
    } catch {
      return undefined;
    }
  }
  async put(key: string, data: ArrayBuffer) {
    const fh = await (await this.dir()).getFileHandle(opfsName(key), { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  async has(key: string) {
    try {
      await (await this.dir()).getFileHandle(opfsName(key));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    try {
      await (await this.dir()).removeEntry(opfsName(key));
    } catch {
      /* 없으면 무시 */
    }
  }
}

export function defaultBlobStore(): BlobStore {
  if (typeof caches !== 'undefined') return new CacheStorageBlobStore();
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function')
    return new OpfsBlobStore();
  return new MemoryBlobStore();
}

export interface ModelProgress {
  file: string;
  /** 모델 전체 기준 받은 바이트 */
  loaded: number;
  total: number;
  fileLoaded: number;
  fileTotal: number;
  fromCache: boolean;
}

export class ModelIntegrityError extends Error {
  constructor(
    public file: string,
    detail: string,
  ) {
    super(`모델 파일 검증 실패: ${file} (${detail})`);
  }
}

export interface ModelStoreOptions {
  store?: BlobStore;
  fetch?: typeof fetch;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 모델 다운로드(진행률) + SHA-256 검증 + 영속 캐시. 키는 고정 리비전 URL이다 */
export class ModelStore {
  private store: BlobStore;
  private fetchFn: typeof fetch;

  constructor(opts: ModelStoreOptions = {}) {
    this.store = opts.store ?? defaultBlobStore();
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
  }

  private url(spec: ModelSpec, f: ModelFile) {
    return `${spec.baseUrl}/${f.name}`;
  }

  /** 모든 파일이 캐시에 있다(내용 검증은 load에서 한다) */
  async isCached(spec: ModelSpec): Promise<boolean> {
    for (const f of spec.files) if (!(await this.store.has(this.url(spec, f)))) return false;
    return true;
  }

  async clear(spec?: ModelSpec): Promise<void> {
    if (!spec) {
      if (this.store instanceof CacheStorageBlobStore && typeof caches !== 'undefined') {
        await caches.delete('winds-stt-models-v1');
        return;
      }
      throw new Error('clear(spec) 필요: 이 저장소는 전체 삭제를 지원하지 않는다');
    }
    for (const f of spec.files) await this.store.delete(this.url(spec, f));
  }

  /** 캐시에 있으면 검증해 쓰고, 없거나 깨졌으면 다운로드한다. 파일명 → 바이트 */
  async load(
    spec: ModelSpec,
    onProgress?: (p: ModelProgress) => void,
  ): Promise<Record<string, ArrayBuffer>> {
    const total = totalBytes(spec);
    let done = 0;
    const out: Record<string, ArrayBuffer> = {};
    for (const f of spec.files) {
      const key = this.url(spec, f);
      let data = await this.store.get(key);
      let fromCache = false;
      if (data) {
        try {
          await this.verify(f, data);
          fromCache = true;
        } catch {
          await this.store.delete(key); // 깨진 캐시는 버리고 다시 받는다
          data = undefined;
        }
      }
      if (data) {
        done += f.size;
        onProgress?.({
          file: f.name,
          loaded: done,
          total,
          fileLoaded: f.size,
          fileTotal: f.size,
          fromCache,
        });
      } else {
        const base = done;
        data = await this.download(key, f, (fl) =>
          onProgress?.({
            file: f.name,
            loaded: base + fl,
            total,
            fileLoaded: fl,
            fileTotal: f.size,
            fromCache: false,
          }),
        );
        await this.verify(f, data); // 해시가 다르면 저장하지 않는다
        await this.store.put(key, data);
        done += f.size;
      }
      out[f.name] = data;
    }
    return out;
  }

  private async verify(f: ModelFile, data: ArrayBuffer) {
    if (data.byteLength !== f.size)
      throw new ModelIntegrityError(f.name, `크기 ${data.byteLength} != ${f.size}`);
    if (f.sha256) {
      const h = await sha256Hex(data);
      if (h !== f.sha256) throw new ModelIntegrityError(f.name, `sha256 ${h} != ${f.sha256}`);
    }
  }

  private async download(
    url: string,
    f: ModelFile,
    onBytes: (n: number) => void,
  ): Promise<ArrayBuffer> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`모델 다운로드 실패: ${f.name} HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length')) || f.size;
    if (!res.body) {
      const buf = await res.arrayBuffer();
      onBytes(buf.byteLength);
      return buf;
    }
    // 크기를 알고 있으니 한 번만 할당해 채운다(70MB 파일을 청크 배열 + 합치기로 두 배 쓰지 않는다)
    let buf = new Uint8Array(Math.max(declared, f.size));
    let n = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > buf.length) {
        const bigger = new Uint8Array(Math.max(buf.length * 2, n + value.length));
        bigger.set(buf.subarray(0, n));
        buf = bigger;
      }
      buf.set(value, n);
      n += value.length;
      onBytes(n);
    }
    // 정확한 길이의 새 ArrayBuffer로 돌려준다(크기 검증과 전송에 필요)
    return n === buf.buffer.byteLength ? buf.buffer : buf.buffer.slice(0, n);
  }
}
