/**
 * EntropyFeeder: Periodically sends entropy seeds to the AudioWorklet.
 *
 * Uses message-based communication (v1). Future v2 could use SharedArrayBuffer
 * ring buffer for lower latency once COOP/COEP headers are configured.
 */
import { EntropyRng } from './EntropyRng';
const FEED_INTERVAL_MS = 150; // Post seeds every ~150ms
const WORDS_PER_FEED = 8; // 8 x 32-bit words per feed
export class EntropyFeeder {
    rng;
    port = null;
    intervalId = null;
    running = false;
    constructor(rng) {
        this.rng = rng;
    }
    /**
     * Connect to an AudioWorkletNode's message port.
     */
    connect(port) {
        this.port = port;
        // Listen for seed requests from the worklet
        this.port.onmessage = (event) => {
            if (event.data !== null &&
                typeof event.data === 'object' &&
                'type' in event.data &&
                event.data.type === 'need-seed') {
                this.sendSeeds();
            }
        };
    }
    /**
     * Start periodic seed feeding.
     */
    start() {
        if (this.running)
            return;
        this.running = true;
        // Send initial seeds immediately
        this.sendSeeds();
        // Then periodically
        this.intervalId = setInterval(() => {
            this.sendSeeds();
        }, FEED_INTERVAL_MS);
    }
    /**
     * Stop periodic seed feeding.
     */
    stop() {
        this.running = false;
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    /**
     * Send seeds to the worklet.
     */
    sendSeeds() {
        if (!this.port)
            return;
        const seeds = this.rng.getWords(WORDS_PER_FEED);
        this.port.postMessage({
            type: 'entropy-seeds',
            seeds: seeds,
        });
    }
    /**
     * Disconnect and clean up.
     */
    dispose() {
        this.stop();
        if (this.port) {
            this.port.onmessage = null;
            this.port = null;
        }
    }
}
