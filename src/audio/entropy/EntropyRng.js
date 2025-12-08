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
function imul32(a, b) {
    return Math.imul(a, b) >>> 0;
}
/**
 * 32-bit rotate left.
 */
function rotl32(x, k) {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}
/**
 * Mix a 32-bit word into the pool using a simple mixing function.
 */
function mixWord(pool, word, index) {
    const poolVal = pool[index];
    if (poolVal === undefined)
        return;
    // xorshift-style mixing
    const mixed = (poolVal ^ rotl32(word, 13)) >>> 0;
    pool[index] = (imul32(mixed, 0x9e3779b9) ^ rotl32(mixed, 17)) >>> 0;
}
export class EntropyRng {
    pool;
    counter = 0;
    eventBuffer = [];
    rafId = null;
    lastRafTime = 0;
    stirIndex = 0;
    boundHandlers;
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
    start() {
        const opts = { passive: true };
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
    stop() {
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
    stir(word) {
        mixWord(this.pool, word >>> 0, this.stirIndex);
        this.stirIndex = (this.stirIndex + 1) % POOL_SIZE;
    }
    /**
     * Generate a single 32-bit random word.
     * Uses the pool state combined with CSPRNG for output.
     */
    nextU32() {
        this.counter++;
        // Mix counter into pool
        this.stir(this.counter);
        // Get fresh CSPRNG word
        const fresh = new Uint32Array(1);
        crypto.getRandomValues(fresh);
        const freshVal = fresh[0];
        if (freshVal === undefined)
            return 0;
        // Combine pool state with fresh randomness
        const poolIndex = this.counter % POOL_SIZE;
        const poolVal = this.pool[poolIndex];
        if (poolVal === undefined)
            return freshVal;
        const output = (poolVal ^ freshVal) >>> 0;
        // Update pool with output for forward secrecy
        this.stir(output);
        return output;
    }
    /**
     * Generate a random float in [0, 1).
     */
    nextFloat() {
        return this.nextU32() / 0x100000000;
    }
    /**
     * Generate a random float in [-1, 1).
     */
    nextSignedFloat() {
        return this.nextFloat() * 2 - 1;
    }
    /**
     * Generate multiple 32-bit words for seeding other RNGs.
     */
    getWords(count) {
        const words = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
            words[i] = this.nextU32();
        }
        return words;
    }
    // --- Event handlers ---
    scheduleRaf() {
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
    processEventBuffer() {
        // Process accumulated event entropy
        for (const word of this.eventBuffer) {
            this.stir(word);
        }
        this.eventBuffer = [];
    }
    addEventEntropy(values) {
        for (const v of values) {
            this.eventBuffer.push(v >>> 0);
        }
    }
    onMouseMove(e) {
        // Combine position and timestamp for entropy
        const word1 = ((e.clientX & 0xffff) << 16) | (e.clientY & 0xffff);
        const word2 = (e.timeStamp * 1000) >>> 0;
        this.addEventEntropy([word1, word2]);
    }
    onWheel(e) {
        const word = ((e.deltaX & 0xffff) << 16) | (e.deltaY & 0xffff);
        this.addEventEntropy([word, (e.timeStamp * 1000) >>> 0]);
    }
    onKeyDown(e) {
        // Use keycode and timestamp
        const word = ((e.keyCode & 0xff) << 24) | ((e.timeStamp * 1000) & 0xffffff);
        this.addEventEntropy([word >>> 0]);
    }
    onScroll() {
        const word = ((window.scrollX & 0xffff) << 16) | (window.scrollY & 0xffff);
        this.addEventEntropy([word, (performance.now() * 1000) >>> 0]);
    }
    onResize() {
        const word = ((window.innerWidth & 0xffff) << 16) | (window.innerHeight & 0xffff);
        this.addEventEntropy([word, (performance.now() * 1000) >>> 0]);
    }
}
