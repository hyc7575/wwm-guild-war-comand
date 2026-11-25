#!/usr/bin/env node
// pub.dev sherpa_onnx_web 2.0.3 아카이브에서 브라우저용 WASM 자산 3개만 꺼내
// apps/web/public/vendor/sherpa-onnx/ 에 둔다. (gitignored. 바이너리는 커밋하지 않는다.)
// 근거: docs/planning/research/stt-integration-notes.md 2.2절
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.0.3';
const ARCHIVE_URL = `https://pub.dev/api/archives/sherpa_onnx_web-${VERSION}.tar.gz`;
const ARCHIVE_SHA256 = '07b395676417b7a35d14fc90ff1b20a1bbca4d9198933493af3f08e7539c9c41';
const ASSETS = {
  'sherpa-onnx-wasm-web.wasm': '324a7da57770f9cbbcfb6135fb78e205f149f74afe7c774f6142f9094dee90ee',
  'sherpa-onnx-wasm-web.js': 'aa267dbd0482fd92739ae5a3669faf2d96c3379169548ce92c2512d64e25cd09',
  'sherpa-onnx-asr.js': 'ce92ee9f1548dbb1f0d41044f8ae91566610cbde1c01e954e975502068df54b7',
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps/web/public/vendor/sherpa-onnx');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const force = process.argv.includes('--force');

const upToDate = () =>
  Object.entries(ASSETS).every(
    ([name, hash]) =>
      existsSync(join(outDir, name)) && sha256(readFileSync(join(outDir, name))) === hash,
  );

if (!force && upToDate()) {
  console.log(`[fetch-sherpa-wasm] 이미 최신입니다: ${outDir}`);
  process.exit(0);
}

console.log(`[fetch-sherpa-wasm] 다운로드: ${ARCHIVE_URL}`);
const res = await fetch(ARCHIVE_URL);
if (!res.ok) throw new Error(`다운로드 실패: HTTP ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());
const got = sha256(archive);
console.log(`[fetch-sherpa-wasm] 아카이브 ${archive.length} bytes, sha256=${got}`);
if (got !== ARCHIVE_SHA256) throw new Error(`아카이브 SHA-256 불일치 (기대 ${ARCHIVE_SHA256})`);

const work = mkdtempSync(join(tmpdir(), 'sherpa-web-'));
try {
  const tgz = join(work, 'a.tar.gz');
  const ex = join(work, 'x');
  mkdirSync(ex);
  writeFileSync(tgz, archive);
  // 필요한 3개만 추출. 경로 탈출을 막기 위해 이름을 고정해 넘긴다.
  execFileSync('tar', ['-xzf', tgz, '-C', ex, ...Object.keys(ASSETS).map((n) => `assets/${n}`)], {
    stdio: 'inherit',
  });
  mkdirSync(outDir, { recursive: true });
  for (const [name, hash] of Object.entries(ASSETS)) {
    const src = join(ex, 'assets', name);
    const h = sha256(readFileSync(src));
    if (h !== hash) throw new Error(`${name} SHA-256 불일치: ${h}`);
    copyFileSync(src, join(outDir, name));
    console.log(`[fetch-sherpa-wasm] OK ${name}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`[fetch-sherpa-wasm] 완료: ${outDir}`);
