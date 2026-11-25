export interface ModelFile {
  name: string;
  size: number;
  /** 소문자 hex SHA-256. 모르면 생략(크기만 확인) */
  sha256?: string;
  /** FS에 쓸 때의 역할 */
  role: 'encoder' | 'decoder' | 'joiner' | 'tokens';
}

export interface ModelSpec {
  id: string;
  label: string;
  license: string;
  /** 고정 리비전의 resolve URL 접두사(끝에 / 없음) */
  baseUrl: string;
  files: ModelFile[];
  /**
   * sherpa-onnx modelConfig.modelingUnit. 'bpe'로 두면 bpeVocab 없이 getResult에서 wasm이 `null function`으로 죽는다
   * (스모크 테스트로 확인). BPE 모델도 핫워드를 안 쓰면 'cjkchar'로 충분하다.
   */
  modelingUnit: 'cjkchar' | 'bpe';
  /** 핫워드(문맥 편향)를 쓸 수 있나. BPE 모델은 bpe.vocab 생성이 필요해 지원하지 않는다 */
  supportsHotwords: boolean;
}

export const totalBytes = (m: ModelSpec): number => m.files.reduce((n, f) => n + f.size, 0);

/** 주력: kangkyu 72M chunk-16 int8 (docs/planning/research/stt-integration-notes.md 1.1) */
export const MODEL_KO_72M: ModelSpec = {
  id: 'kangkyu-ko-zipformer-72m-chunk16-int8',
  label: 'sherpa-onnx 72M (kangkyu, chunk-16 int8)',
  license: 'Apache-2.0',
  baseUrl:
    'https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-72m/resolve/db24b58d22736349eaeb34cc181ad0f3debf9903',
  modelingUnit: 'cjkchar',
  supportsHotwords: true,
  files: [
    {
      name: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      role: 'encoder',
      size: 70_133_869,
      sha256: '5f2b6e5e92834849cfdbda3aaa355e6f39ff993f067794e4ab9d5cb993b15311',
    },
    {
      name: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      role: 'decoder',
      size: 1_544_210,
      sha256: '40c3c57ad27b45b59e27bec8bfc02f04d27c060aeb8e964ae2f87bd9f356bf7d',
    },
    {
      name: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      role: 'joiner',
      size: 1_270_777,
      sha256: '7d3bd9c1e9cf60efa5d5fed728fbd52d0f08139775f9e9002fd088b4d78f3e73',
    },
    {
      name: 'tokens.txt',
      role: 'tokens',
      size: 20_844,
      sha256: '435dfb9e0a2b6a79124f1a4d8f0f33a951b25384726e2e0d854f081533e6ec9d',
    },
  ],
};

/**
 * 비교 기준: k2-fsa 2024-06-16 (Zipformer v1, BPE 5000). 마이크 입력에서 빈 결과가 나온다는
 * 미해결 이슈(sherpa-onnx #2886)가 있어 기준선으로만 쓴다.
 * SHA-256은 HF API(lfs.oid)와 tokens.txt 직접 계산으로 확인했다(리비전 84fd2005...).
 */
export const MODEL_K2FSA_KO_2024: ModelSpec = {
  id: 'k2fsa-ko-zipformer-2024-06-16-int8',
  label: 'sherpa-onnx k2-fsa 2024-06-16 (int8, 비교 기준)',
  license: 'Apache-2.0',
  baseUrl:
    'https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16/resolve/84fd200583460a3adb7f68b8dd6a740359a775ff',
  modelingUnit: 'cjkchar',
  supportsHotwords: false,
  files: [
    {
      name: 'encoder-epoch-99-avg-1.int8.onnx',
      role: 'encoder',
      size: 126_968_852,
      sha256: '8d0b1aa24fbedd4e3948564ab7facd151b8ce9b0c48fc987c541de2de3af5697',
    },
    {
      name: 'decoder-epoch-99-avg-1.int8.onnx',
      role: 'decoder',
      size: 2_844_692,
      sha256: '68ea197936aabd249f38b53a87c775422bca64428ad4427d0e6e8092593e71fb',
    },
    {
      name: 'joiner-epoch-99-avg-1.int8.onnx',
      role: 'joiner',
      size: 2_581_421,
      sha256: '128b80a66a1f718488af8560f9d15895109b99ff3e573f0a0130e03774ef1ced',
    },
    {
      name: 'tokens.txt',
      role: 'tokens',
      size: 60_246,
      sha256: '016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668',
    },
  ],
};

export const MODELS = {
  'ko-72m': MODEL_KO_72M,
  'k2fsa-ko-2024': MODEL_K2FSA_KO_2024,
} as const;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL_KEY: ModelKey = 'ko-72m';

export const SHERPA_WASM_VERSION = '2.0.3';
export const DEFAULT_WASM_BASE = '/vendor/sherpa-onnx/';
