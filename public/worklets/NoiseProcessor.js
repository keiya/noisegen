function rotl(x, k) {
  return (x << k | x >>> 32 - k) >>> 0;
}
function xoshiroNext(state) {
  const result = rotl(state.s0 + state.s3 >>> 0, 7) + state.s0 >>> 0;
  const t = state.s1 << 9 >>> 0;
  state.s2 = (state.s2 ^ state.s0) >>> 0;
  state.s3 = (state.s3 ^ state.s1) >>> 0;
  state.s1 = (state.s1 ^ state.s2) >>> 0;
  state.s0 = (state.s0 ^ state.s3) >>> 0;
  state.s2 = (state.s2 ^ t) >>> 0;
  state.s3 = rotl(state.s3, 11);
  return result;
}
function nextSignedFloat(state) {
  return xoshiroNext(state) / 4294967296 * 2 - 1;
}
function initState(seeds) {
  return {
    s0: seeds[0] ?? 305419896,
    s1: seeds[1] ?? 2596069104,
    s2: seeds[2] ?? 3735928559,
    s3: seeds[3] ?? 3405691582
  };
}
function mixEntropy(state, words) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === void 0) continue;
    switch (i % 4) {
      case 0:
        state.s0 = (state.s0 ^ word) >>> 0;
        break;
      case 1:
        state.s1 = (state.s1 ^ rotl(word, 5)) >>> 0;
        break;
      case 2:
        state.s2 = (state.s2 ^ rotl(word, 13)) >>> 0;
        break;
      case 3:
        state.s3 = (state.s3 ^ rotl(word, 21)) >>> 0;
        break;
    }
  }
  for (let i = 0; i < 8; i++) {
    xoshiroNext(state);
  }
}
function initPinkState() {
  return { b0: 0, b1: 0, b2: 0 };
}
function pinkFilter(pink, white) {
  pink.b0 = 0.99765 * pink.b0 + white * 0.099046;
  pink.b1 = 0.963 * pink.b1 + white * 0.2965164;
  pink.b2 = 0.57 * pink.b2 + white * 1.0526913;
  const output = pink.b0 + pink.b1 + pink.b2 + white * 0.1848;
  return output * 0.16;
}
function initBrownState(sampleRate2) {
  const tau = 0.02;
  const decay = Math.exp(-1 / (sampleRate2 * tau));
  const scale = 1 - decay;
  const gain = Math.sqrt((1 + decay) / (1 - decay)) * 0.5;
  return { b: 0, decay, scale, gain };
}
function brownFilter(brown, white) {
  brown.b = brown.decay * brown.b + brown.scale * white;
  if (brown.b > 1) brown.b = 1;
  if (brown.b < -1) brown.b = -1;
  return brown.b * brown.gain;
}
class NoiseProcessor extends AudioWorkletProcessor {
  // PRNG states (independent per channel)
  stateL;
  stateR;
  // Pink filter states
  pinkL;
  pinkR;
  // Brown filter states
  brownL;
  brownR;
  // Mode crossfade
  currentMode = "pink";
  targetMode = "pink";
  crossfadeProgress = 1;
  // 0 = old mode, 1 = target mode
  crossfadeSamplesRemaining = 0;
  crossfadeDuration = 0.05;
  // 50ms
  // Entropy management
  seedQueue = [];
  samplesSinceLastSeed = 0;
  seedRequestThreshold = 0;
  initialized = false;
  constructor() {
    super();
    const fallbackSeeds = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      fallbackSeeds[i] = (currentFrame * 2654435761 ^ i * 2654435769) >>> 0;
    }
    this.stateL = initState(fallbackSeeds.subarray(0, 4));
    this.stateR = initState(fallbackSeeds.subarray(4, 8));
    this.pinkL = initPinkState();
    this.pinkR = initPinkState();
    this.brownL = initBrownState(sampleRate);
    this.brownR = initBrownState(sampleRate);
    this.seedRequestThreshold = Math.floor(sampleRate * 0.5);
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }
  handleMessage(msg) {
    switch (msg.type) {
      case "initial-seeds":
        if (!this.initialized && msg.seeds.length >= 8) {
          this.stateL = initState(msg.seeds.subarray(0, 4));
          this.stateR = initState(msg.seeds.subarray(4, 8));
          this.initialized = true;
        }
        break;
      case "entropy-seeds":
        this.seedQueue.push(msg.seeds);
        break;
      case "set-mode":
        if (msg.mode !== this.targetMode) {
          this.targetMode = msg.mode;
          if (this.crossfadeProgress >= 1) {
            this.crossfadeProgress = 0;
            this.crossfadeSamplesRemaining = Math.floor(
              this.crossfadeDuration * sampleRate
            );
          }
        }
        break;
    }
  }
  process(_inputs, outputs, _parameters) {
    const output = outputs[0];
    if (!output) return true;
    const outL = output[0];
    const outR = output[1];
    if (!outL || !outR) return true;
    const blockSize = outL.length;
    this.samplesSinceLastSeed += blockSize;
    if (this.samplesSinceLastSeed >= this.seedRequestThreshold && this.seedQueue.length < 2) {
      this.port.postMessage({ type: "need-seed" });
      this.samplesSinceLastSeed = 0;
    }
    const seed = this.seedQueue.shift();
    if (seed) {
      const halfLen = Math.floor(seed.length / 2);
      mixEntropy(this.stateL, seed.subarray(0, halfLen));
      mixEntropy(this.stateR, seed.subarray(halfLen));
    }
    const crossfading = this.crossfadeSamplesRemaining > 0;
    const crossfadeIncrement = crossfading ? 1 / this.crossfadeSamplesRemaining : 0;
    for (let i = 0; i < blockSize; i++) {
      const whiteL = nextSignedFloat(this.stateL);
      const whiteR = nextSignedFloat(this.stateR);
      const pinkSampleL = pinkFilter(this.pinkL, whiteL);
      const pinkSampleR = pinkFilter(this.pinkR, whiteR);
      const brownSampleL = brownFilter(this.brownL, whiteL);
      const brownSampleR = brownFilter(this.brownR, whiteR);
      let sampleL;
      let sampleR;
      if (crossfading) {
        const t = this.crossfadeProgress;
        const angle = 0.5 * Math.PI * t;
        const oldGain = Math.cos(angle);
        const newGain = Math.sin(angle);
        const oldL = this.currentMode === "pink" ? pinkSampleL : brownSampleL;
        const oldR = this.currentMode === "pink" ? pinkSampleR : brownSampleR;
        const newL = this.targetMode === "pink" ? pinkSampleL : brownSampleL;
        const newR = this.targetMode === "pink" ? pinkSampleR : brownSampleR;
        sampleL = oldGain * oldL + newGain * newL;
        sampleR = oldGain * oldR + newGain * newR;
        this.crossfadeProgress += crossfadeIncrement;
        this.crossfadeSamplesRemaining--;
        if (this.crossfadeSamplesRemaining <= 0) {
          this.currentMode = this.targetMode;
          this.crossfadeProgress = 1;
        }
      } else {
        sampleL = this.currentMode === "pink" ? pinkSampleL : brownSampleL;
        sampleR = this.currentMode === "pink" ? pinkSampleR : brownSampleR;
      }
      outL[i] = sampleL;
      outR[i] = sampleR;
    }
    return true;
  }
}
registerProcessor("noise-processor", NoiseProcessor);
