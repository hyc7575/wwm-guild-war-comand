/** 오디오 파일(WAV 등) -> 16kHz 모노 Float32. 브라우저 디코더가 리샘플까지 해 준다 */
export async function decodeTo16kMono(
  buf: ArrayBuffer,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const ab = await ctx.decodeAudioData(buf.slice(0));
  const n = ab.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const ch = ab.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i]! += (ch[i] ?? 0) / ab.numberOfChannels;
  }
  return { samples: mono, sampleRate: ab.sampleRate };
}
