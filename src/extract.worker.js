// Web Worker: fetch GIBS image -> decode -> per-column features. Keeps the UI thread free.
// Output: Float32Array, 8 floats per column: [l0,s0, l1,s1, l2,s2, contrast, meanLum]
self.onmessage = async ({ data: { id, url, W, H } }) => {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob()); // rejects if server returned an XML error
    const g = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, feat = new Float32Array(W * 8);
    for (let x = 0; x < W; x++) {
      const b = new Float32Array(6), n = [0, 0, 0];
      let sum = 0, sq = 0;
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4, r = px[i], gr = px[i + 1], bl = px[i + 2];
        const l = (0.2126 * r + 0.7152 * gr + 0.0722 * bl) / 255;
        const mx = Math.max(r, gr, bl), mn = Math.min(r, gr, bl), k = Math.min(2, Math.floor((y * 3) / H));
        b[k * 2] += l; b[k * 2 + 1] += mx ? (mx - mn) / mx : 0; n[k]++; sum += l; sq += l * l;
      }
      const o = x * 8, m = sum / H;
      for (let k = 0; k < 3; k++) { feat[o + k * 2] = b[k * 2] / (n[k] || 1); feat[o + k * 2 + 1] = b[k * 2 + 1] / (n[k] || 1); }
      feat[o + 6] = Math.min(1, Math.sqrt(Math.max(0, sq / H - m * m)) * 3);
      feat[o + 7] = m;
    }
    self.postMessage({ id, W, feat }, [feat.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
