/**
 * EntropyRng: 256-bit pool mixer for high-quality randomness.
 *
 * Combines crypto.getRandomValues (CSPRNG) with user-event entropy
 * (mouse, keyboard, scroll, resize, requestAnimationFrame timing jitter).
 */

const POOL_SIZE = 8; // 8 x 32-bit = 256-bit pool

/**
 * 32-bit integer multiply (truncated to 32 bits).
 */
function imul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

/**
 * 32-bit rotate left.
 */
function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Mix a 32-bit word into the pool using a simple mixing function.
 */
function mixWord(pool: Uint32Array, word: number, index: number): void {
  const poolVal = pool[index];
  if (poolVal === undefined) return;
  // xorshift-style mixing
  const mixed = (poolVal ^ rotl32(word, 13)) >>> 0;
  pool[index] = (imul32(mixed, 0x9e3779b9) ^ rotl32(mixed, 17)) >>> 0;
}

export class EntropyRng {
  private pool: Uint32Array;
  private counter = 0;
  private eventBuffer: number[] = [];
  private rafId: number | null = null;
  private lastRafTime = 0;
  private stirIndex = 0;
  private boundHandlers: {
    mousemove: (e: MouseEvent) => void;
    wheel: (e: WheelEvent) => void;
    keydown: (e: KeyboardEvent) => void;
    scroll: () => void;
    resize: () => void;
  };

  constructor() {
    this.pool = new Uint32Array(POOL_SIZE);
    // Initialize pool with CSPRNG
    crypto.getRandomValues(this.pool);

    // Bind event handlers
    this.boundHandlers = {
      mousemove: this.onMouseMove.bind(this),
      wheel: this.onWheel.bind(this),
      keydown: this.onKeyDown.bind(this),
      scroll: this.onScroll.bind(this),
      resize: this.onResize.bind(this),
    };
  }

  /**
   * Start collecting entropy from user events and RAF timing.
   */
  start(): void {
    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener('mousemove', this.boundHandlers.mousemove, opts);
    window.addEventListener('wheel', this.boundHandlers.wheel, opts);
    window.addEventListener('keydown', this.boundHandlers.keydown, opts);
    window.addEventListener('scroll', this.boundHandlers.scroll, opts);
    window.addEventListener('resize', this.boundHandlers.resize, opts);

    this.lastRafTime = performance.now();
    this.scheduleRaf();
  }

  /**
   * Stop collecting entropy.
   */
  stop(): void {
    window.removeEventListener('mousemove', this.boundHandlers.mousemove);
    window.removeEventListener('wheel', this.boundHandlers.wheel);
    window.removeEventListener('keydown', this.boundHandlers.keydown);
    window.removeEventListener('scroll', this.boundHandlers.scroll);
    window.removeEventListener('resize', this.boundHandlers.resize);

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Stir a 32-bit word into the entropy pool.
   */
  stir(word: number): void {
    mixWord(this.pool, word >>> 0, this.stirIndex);
    this.stirIndex = (this.stirIndex + 1) % POOL_SIZE;
  }

  /**
   * Generate a single 32-bit random word.
   * Uses the pool state combined with CSPRNG for output.
   */
  nextU32(): number {
    this.counter++;

    // Mix counter into pool
    this.stir(this.counter);

    // Get fresh CSPRNG word
    const fresh = new Uint32Array(1);
    crypto.getRandomValues(fresh);
    const freshVal = fresh[0];
    if (freshVal === undefined) return 0;

    // Combine pool state with fresh randomness
    const poolIndex = this.counter % POOL_SIZE;
    const poolVal = this.pool[poolIndex];
    if (poolVal === undefined) return freshVal;

    const output = (poolVal ^ freshVal) >>> 0;

    // Update pool with output for forward secrecy
    this.stir(output);

    return output;
  }

  /**
   * Generate a random float in [0, 1).
   */
  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }

  /**
   * Generate a random float in [-1, 1).
   */
  nextSignedFloat(): number {
    return this.nextFloat() * 2 - 1;
  }

  /**
   * Generate multiple 32-bit words for seeding other RNGs.
   */
  getWords(count: number): Uint32Array {
    const words = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      words[i] = this.nextU32();
    }
    return words;
  }

  // --- Event handlers ---

  private scheduleRaf(): void {
    this.rafId = requestAnimationFrame((now) => {
      // Use timing jitter as entropy
      const delta = now - this.lastRafTime;
      this.lastRafTime = now;

      // Extract entropy from sub-millisecond timing variations
      const jitter = Math.floor((delta % 1) * 0x100000000);
      this.stir(jitter);

      // Also use performance.now() fractional part
      const perfFrac = Math.floor((performance.now() % 1) * 0x100000000);
      this.stir(perfFrac);

      this.processEventBuffer();
      this.scheduleRaf();
    });
  }

  private processEventBuffer(): void {
    // Process accumulated event entropy
    for (const word of this.eventBuffer) {
      this.stir(word);
    }
    this.eventBuffer = [];
  }

  private addEventEntropy(values: number[]): void {
    for (const v of values) {
      this.eventBuffer.push(v >>> 0);
    }
  }

  private onMouseMove(e: MouseEvent): void {
    // Combine position and timestamp for entropy
    const word1 = ((e.clientX & 0xffff) << 16) | (e.clientY & 0xffff);
    const word2 = (e.timeStamp * 1000) >>> 0;
    this.addEventEntropy([word1, word2]);
  }

  private onWheel(e: WheelEvent): void {
    const word = ((e.deltaX & 0xffff) << 16) | (e.deltaY & 0xffff);
    this.addEventEntropy([word, (e.timeStamp * 1000) >>> 0]);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Use keycode and timestamp
    const word = ((e.keyCode & 0xff) << 24) | ((e.timeStamp * 1000) & 0xffffff);
    this.addEventEntropy([word >>> 0]);
  }

  private onScroll(): void {
    const word = ((window.scrollX & 0xffff) << 16) | (window.scrollY & 0xffff);
    this.addEventEntropy([word, (performance.now() * 1000) >>> 0]);
  }

  private onResize(): void {
    const word = ((window.innerWidth & 0xffff) << 16) | (window.innerHeight & 0xffff);
    this.addEventEntropy([word, (performance.now() * 1000) >>> 0]);
  }
}
