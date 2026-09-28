// AudioWorklet: runs on the audio rendering thread. Look-free peak limiter with a soft knee,
// so sudden bright/high-contrast image columns can never spike the listener's ears.
class SafetyLimiter extends AudioWorkletProcessor {
  constructor() { super(); this.g = 1; this.n = 0; this.pk = 0; }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], CEIL = 0.8, KNEE = 0.7;
    if (!inp.length) return true;
    for (let i = 0; i < inp[0].length; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) peak = Math.max(peak, Math.abs(inp[c][i]));
      const target = peak * this.g > CEIL ? CEIL / peak : 1;
      this.g += (target - this.g) * (target < this.g ? 0.2 : 0.0005); // fast attack, slow release
      for (let c = 0; c < out.length; c++) {
        const v = (inp[c] || inp[0])[i] * this.g, a = Math.abs(v);
        out[c][i] = a < KNEE ? v : Math.sign(v) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
      }
      this.pk = Math.max(this.pk, peak);
    }
    this.n += inp[0].length;
    if (this.n >= 2048) { this.port.postMessage({ peak: this.pk, gain: this.g }); this.n = 0; this.pk = 0; }
    return true;
  }
}
registerProcessor('safety-limiter', SafetyLimiter);
