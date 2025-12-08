/**
 * NoiseProcessor: AudioWorkletProcessor that generates stereo pink/brown noise.
 *
 * Uses xoshiro128++ PRNG seeded from crypto.getRandomValues, with entropy
 * seeds mixed in from the main thread for additional randomness.
 *
 * Pink noise: Paul Kellet 3-tap IIR filter
 * Brown noise: Integrated white noise with sampleRate-derived decay
 * Mode switching: Equal-power crossfade over ~50ms
 */

// --- xoshiro128++ PRNG state (per channel) ---

interface XoshiroState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * xoshiro128++ next() - generates a 32-bit random number.
 */
function xoshiroNext(state: XoshiroState): number {
  const result = (rotl((state.s0 + state.s3) >>> 0, 7) + state.s0) >>> 0;

  const t = (state.s1 << 9) >>> 0;

  state.s2 = (state.s2 ^ state.s0) >>> 0;
  state.s3 = (state.s3 ^ state.s1) >>> 0;
  state.s1 = (state.s1 ^ state.s2) >>> 0;
  state.s0 = (state.s0 ^ state.s3) >>> 0;

  state.s2 = (state.s2 ^ t) >>> 0;
  state.s3 = rotl(state.s3, 11);

  return result;
}

/**
 * Generate a float in [-1, 1) from PRNG state.
 */
function nextSignedFloat(state: XoshiroState): number {
  return (xoshiroNext(state) / 0x100000000) * 2 - 1;
}

/**
 * Initialize PRNG state from seeds.
 */
function initState(seeds: Uint32Array): XoshiroState {
  return {
    s0: seeds[0] ?? 0x12345678,
    s1: seeds[1] ?? 0x9abcdef0,
    s2: seeds[2] ?? 0xdeadbeef,
    s3: seeds[3] ?? 0xcafebabe,
  };
}

/**
 * Mix entropy words into PRNG state.
 */
function mixEntropy(state: XoshiroState, words: Uint32Array): void {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    // XOR into state with rotation
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
  // Advance state a few times to mix
  for (let i = 0; i < 8; i++) {
    xoshiroNext(state);
  }
}

// --- Pink noise filter state (Paul Kellet algorithm) ---

interface PinkState {
  b0: number;
  b1: number;
  b2: number;
}

function initPinkState(): PinkState {
  return { b0: 0, b1: 0, b2: 0 };
}

/**
 * Apply Paul Kellet pink noise filter to white sample.
 * Coefficients designed for -3dB/octave slope.
 */
function pinkFilter(pink: PinkState, white: number): number {
  pink.b0 = 0.99765 * pink.b0 + white * 0.0990460;
  pink.b1 = 0.96300 * pink.b1 + white * 0.2965164;
  pink.b2 = 0.57000 * pink.b2 + white * 1.0526913;
  const output = pink.b0 + pink.b1 + pink.b2 + white * 0.1848;
  // Normalize (roughly -4.5dB reduction)
  return output * 0.16;
}

// --- Brown noise state ---

interface BrownState {
  b: number;
  decay: number;
  scale: number;
  gain: number;
}

function initBrownState(sampleRate: number): BrownState {
  // Time constant for brown noise (controls "slowness" of random walk)
  const tau = 0.02; // 20ms
  const decay = Math.exp(-1 / (sampleRate * tau));
  // Scale factor for input
  const scale = 1 - decay;
  // Gain compensation: leaky integrator attenuates signal significantly
  // RMS of output ≈ sqrt((1-decay)/(1+decay)), so gain ≈ sqrt((1+decay)/(1-decay))
  const gain = Math.sqrt((1 + decay) / (1 - decay)) * 0.5; // *0.5 to match pink level roughly
  return { b: 0, decay, scale, gain };
}

/**
 * Apply brown (integrated) noise filter.
 */
function brownFilter(brown: BrownState, white: number): number {
  brown.b = brown.decay * brown.b + brown.scale * white;
  // Soft clamp internal state to prevent runaway
  if (brown.b > 1) brown.b = 1;
  if (brown.b < -1) brown.b = -1;
  // Apply gain compensation for output
  return brown.b * brown.gain;
}

// --- Message types ---

type WorkletMessage =
  | { type: 'entropy-seeds'; seeds: Uint32Array }
  | { type: 'initial-seeds'; seeds: Uint32Array }
  | { type: 'set-mode'; mode: 'pink' | 'brown' };

// --- Processor ---

class NoiseProcessor extends AudioWorkletProcessor {
  // PRNG states (independent per channel)
  private stateL: XoshiroState;
  private stateR: XoshiroState;

  // Pink filter states
  private pinkL: PinkState;
  private pinkR: PinkState;

  // Brown filter states
  private brownL: BrownState;
  private brownR: BrownState;

  // Mode crossfade
  private currentMode: 'pink' | 'brown' = 'pink';
  private targetMode: 'pink' | 'brown' = 'pink';
  private crossfadeProgress = 1; // 0 = old mode, 1 = target mode
  private crossfadeSamplesRemaining = 0;
  private crossfadeDuration = 0.05; // 50ms

  // Entropy management
  private seedQueue: Uint32Array[] = [];
  private samplesSinceLastSeed = 0;
  private seedRequestThreshold = 0;
  private initialized = false;

  constructor() {
    super();

    // Initialize PRNG with fallback seeds (will be replaced by main thread seeds)
    // Use currentTime-based entropy as temporary fallback
    const fallbackSeeds = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      // Mix currentFrame/currentTime for some initial entropy
      fallbackSeeds[i] = ((currentFrame * 2654435761) ^ (i * 0x9e3779b9)) >>> 0;
    }

    this.stateL = initState(fallbackSeeds.subarray(0, 4));
    this.stateR = initState(fallbackSeeds.subarray(4, 8));

    // Pink filter states
    this.pinkL = initPinkState();
    this.pinkR = initPinkState();

    // Brown filter states
    this.brownL = initBrownState(sampleRate);
    this.brownR = initBrownState(sampleRate);

    // Request seeds more frequently if running low
    this.seedRequestThreshold = Math.floor(sampleRate * 0.5); // Every 500ms

    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      this.handleMessage(event.data);
    };
  }

  private handleMessage(msg: WorkletMessage): void {
    switch (msg.type) {
      case 'initial-seeds':
        // Replace PRNG state with high-quality seeds from main thread
        if (!this.initialized && msg.seeds.length >= 8) {
          this.stateL = initState(msg.seeds.subarray(0, 4));
          this.stateR = initState(msg.seeds.subarray(4, 8));
          this.initialized = true;
        }
        break;
      case 'entropy-seeds':
        this.seedQueue.push(msg.seeds);
        break;
      case 'set-mode':
        if (msg.mode !== this.targetMode) {
          this.targetMode = msg.mode;
          // Start crossfade if not already transitioning
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

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0];
    if (!output) return true;

    const outL = output[0];
    const outR = output[1];
    if (!outL || !outR) return true;

    const blockSize = outL.length;

    // Check if we need more entropy
    this.samplesSinceLastSeed += blockSize;
    if (
      this.samplesSinceLastSeed >= this.seedRequestThreshold &&
      this.seedQueue.length < 2
    ) {
      this.port.postMessage({ type: 'need-seed' });
      this.samplesSinceLastSeed = 0;
    }

    // Mix in queued entropy seeds
    const seed = this.seedQueue.shift();
    if (seed) {
      // Split seeds between L and R channels
      const halfLen = Math.floor(seed.length / 2);
      mixEntropy(this.stateL, seed.subarray(0, halfLen));
      mixEntropy(this.stateR, seed.subarray(halfLen));
    }

    // Calculate crossfade parameters
    const crossfading = this.crossfadeSamplesRemaining > 0;
    const crossfadeIncrement = crossfading
      ? 1 / this.crossfadeSamplesRemaining
      : 0;

    for (let i = 0; i < blockSize; i++) {
      // Generate white noise
      const whiteL = nextSignedFloat(this.stateL);
      const whiteR = nextSignedFloat(this.stateR);

      // Generate pink noise
      const pinkSampleL = pinkFilter(this.pinkL, whiteL);
      const pinkSampleR = pinkFilter(this.pinkR, whiteR);

      // Generate brown noise
      const brownSampleL = brownFilter(this.brownL, whiteL);
      const brownSampleR = brownFilter(this.brownR, whiteR);

      // Output with crossfade
      let sampleL: number;
      let sampleR: number;

      if (crossfading) {
        // Equal-power crossfade: out = cos(0.5 * pi * t) * old + sin(0.5 * pi * t) * new
        const t = this.crossfadeProgress;
        const angle = 0.5 * Math.PI * t;
        const oldGain = Math.cos(angle);
        const newGain = Math.sin(angle);

        const oldL = this.currentMode === 'pink' ? pinkSampleL : brownSampleL;
        const oldR = this.currentMode === 'pink' ? pinkSampleR : brownSampleR;
        const newL = this.targetMode === 'pink' ? pinkSampleL : brownSampleL;
        const newR = this.targetMode === 'pink' ? pinkSampleR : brownSampleR;

        sampleL = oldGain * oldL + newGain * newL;
        sampleR = oldGain * oldR + newGain * newR;

        this.crossfadeProgress += crossfadeIncrement;
        this.crossfadeSamplesRemaining--;

        if (this.crossfadeSamplesRemaining <= 0) {
          this.currentMode = this.targetMode;
          this.crossfadeProgress = 1;
        }
      } else {
        sampleL = this.currentMode === 'pink' ? pinkSampleL : brownSampleL;
        sampleR = this.currentMode === 'pink' ? pinkSampleR : brownSampleR;
      }

      outL[i] = sampleL;
      outR[i] = sampleR;
    }

    return true;
  }
}

registerProcessor('noise-processor', NoiseProcessor);
