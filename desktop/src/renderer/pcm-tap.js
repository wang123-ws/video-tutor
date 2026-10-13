/**
 * AudioWorklet：把系统音频的每一块 PCM 直接抛回主线程。
 * 用 worklet 而不是老的 ScriptProcessor：
 * - 不占主线程，界面不会卡；
 * - 由音频线程驱动，只要节点在图上就一定会被调用，不会出现「明明有声音却收不到回调」。
 */
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const chCount = input.length;
      const len = input[0].length;
      let out;
      if (chCount === 1) {
        out = input[0].slice(0);
      } else {
        out = new Float32Array(len);
        for (let c = 0; c < chCount; c++) {
          const ch = input[c];
          for (let i = 0; i < len; i++) out[i] += ch[i];
        }
        for (let i = 0; i < len; i++) out[i] /= chCount;
      }
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
