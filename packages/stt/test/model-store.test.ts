import { describe, expect, it, vi } from 'vitest';
import { MemoryBlobStore, ModelStore, sha256Hex, type ModelProgress } from '../src/model-store';
import { MODELS, totalBytes, type ModelSpec } from '../src/models';

const enc = new TextEncoder();

async function makeSpec(
  files: Record<string, string>,
): Promise<{ spec: ModelSpec; bodies: Map<string, Uint8Array> }> {
  const bodies = new Map<string, Uint8Array>();
  const list: ModelSpec['files'] = [];
  const roles = ['encoder', 'decoder', 'joiner', 'tokens'] as const;
  let i = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = enc.encode(text);
    bodies.set(`https://x.test/m/${name}`, bytes);
    list.push({
      name,
      role: roles[i++]!,
      size: bytes.length,
      sha256: await sha256Hex(bytes.buffer as ArrayBuffer),
    });
  }
  return {
    spec: {
      id: 't',
      label: 't',
      license: 'x',
      baseUrl: 'https://x.test/m',
      modelingUnit: 'cjkchar',
      supportsHotwords: false,
      files: list,
    },
    bodies,
  };
}

/** 3바이트씩 끊어 내려주는 가짜 fetch */
function mockFetch(bodies: Map<string, Uint8Array>, opts: { corrupt?: string } = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    let body = bodies.get(u);
    if (!body) return new Response('nope', { status: 404 });
    if (opts.corrupt && u.endsWith(opts.corrupt)) {
      body = body.slice();
      body[0] = body[0]! ^ 0xff;
    }
    const b = body;
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= b.length) return c.close();
        c.enqueue(b.slice(off, off + 3));
        off += 3;
      },
    });
    return new Response(stream, { headers: { 'content-length': String(b.length) } });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('MODELS manifest', () => {
  it('72M 기본 모델은 합계 72,969,700 바이트이고 모든 파일에 sha256이 있다', () => {
    const m = MODELS['ko-72m'];
    expect(totalBytes(m)).toBe(72_969_700);
    expect(m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? ''))).toBe(true);
    expect(m.baseUrl).toContain('db24b58d22736349eaeb34cc181ad0f3debf9903');
  });
  it('k2-fsa 모델은 합계 132,455,211 바이트', () => {
    expect(totalBytes(MODELS['k2fsa-ko-2024'])).toBe(132_455_211);
  });
});

describe('ModelStore', () => {
  it('다운로드하며 진행률을 보고하고 해시를 확인한 뒤 캐시한다', async () => {
    const { spec, bodies } = await makeSpec({
      'e.onnx': 'encoder-bytes-0123456789',
      'd.onnx': 'dec',
      'j.onnx': 'join!',
      'tokens.txt': '가 0\n나 1\n',
    });
    const fetchMock = mockFetch(bodies);
    const mem = new MemoryBlobStore();
    const store = new ModelStore({ store: mem, fetch: fetchMock });
    expect(await store.isCached(spec)).toBe(false);
    const prog: ModelProgress[] = [];
    const out = await store.load(spec, (p) => prog.push(p));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new TextDecoder().decode(out['d.onnx']!)).toBe('dec');
    const total = totalBytes(spec);
    expect(prog.at(-1)!.loaded).toBe(total);
    expect(prog.at(-1)!.total).toBe(total);
    expect(prog.every((p, i) => i === 0 || p.loaded >= prog[i - 1]!.loaded)).toBe(true);
    expect(prog.some((p) => p.fileLoaded > 0 && p.fileLoaded < p.fileTotal)).toBe(true);
    expect(await store.isCached(spec)).toBe(true);
  });

  it('두 번째 로드는 네트워크 없이 캐시에서 읽는다', async () => {
    const { spec, bodies } = await makeSpec({
      'e.onnx': 'aaaa',
      'd.onnx': 'bbbb',
      'j.onnx': 'cccc',
      'tokens.txt': 'dddd',
    });
    const fetchMock = mockFetch(bodies);
    const store = new ModelStore({ store: new MemoryBlobStore(), fetch: fetchMock });
    await store.load(spec);
    fetchMock.mockClear();
    const prog: ModelProgress[] = [];
    await store.load(spec, (p) => prog.push(p));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prog.every((p) => p.fromCache)).toBe(true);
  });

  it('해시가 다르면 에러를 내고 캐시에 저장하지 않는다', async () => {
    const { spec, bodies } = await makeSpec({
      'e.onnx': 'aaaa',
      'd.onnx': 'bbbb',
      'j.onnx': 'cccc',
      'tokens.txt': 'dddd',
    });
    const mem = new MemoryBlobStore();
    const store = new ModelStore({ store: mem, fetch: mockFetch(bodies, { corrupt: 'd.onnx' }) });
    await expect(store.load(spec)).rejects.toThrow(/검증 실패: d\.onnx/);
    expect(mem.map.has('https://x.test/m/d.onnx')).toBe(false);
    expect(await store.isCached(spec)).toBe(false);
  });

  it('캐시가 깨졌으면 버리고 다시 받는다', async () => {
    const { spec, bodies } = await makeSpec({
      'e.onnx': 'aaaa',
      'd.onnx': 'bbbb',
      'j.onnx': 'cccc',
      'tokens.txt': 'dddd',
    });
    const mem = new MemoryBlobStore();
    const fetchMock = mockFetch(bodies);
    const store = new ModelStore({ store: mem, fetch: fetchMock });
    await store.load(spec);
    mem.map.set('https://x.test/m/e.onnx', enc.encode('zzzz').buffer as ArrayBuffer); // 같은 크기, 다른 내용
    fetchMock.mockClear();
    const out = await store.load(spec);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(out['e.onnx']!)).toBe('aaaa');
  });

  it('HTTP 오류는 파일명과 함께 알린다', async () => {
    const { spec } = await makeSpec({
      'e.onnx': 'aaaa',
      'd.onnx': 'bbbb',
      'j.onnx': 'cccc',
      'tokens.txt': 'dddd',
    });
    const store = new ModelStore({ store: new MemoryBlobStore(), fetch: mockFetch(new Map()) });
    await expect(store.load(spec)).rejects.toThrow(/e\.onnx HTTP 404/);
  });

  it('clear(spec)는 캐시를 비운다', async () => {
    const { spec, bodies } = await makeSpec({
      'e.onnx': 'aaaa',
      'd.onnx': 'bbbb',
      'j.onnx': 'cccc',
      'tokens.txt': 'dddd',
    });
    const store = new ModelStore({ store: new MemoryBlobStore(), fetch: mockFetch(bodies) });
    await store.load(spec);
    await store.clear(spec);
    expect(await store.isCached(spec)).toBe(false);
  });

  it('sha256Hex는 알려진 값과 같다', async () => {
    expect(await sha256Hex(enc.encode('abc').buffer as ArrayBuffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
