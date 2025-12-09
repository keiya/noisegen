/**
 * AudioEngine: Builds and owns the fixed audio graph.
 *
 * Graph topology (never disconnected/reconnected):
 *
 * NoiseWorklet (stereo) ─► ChannelSplitter
 *   L ─► HPFilter ─► LPFilter ─► GainL ─┬──────────► ChannelMerger ─► MasterGain ─► Destination
 *                                       └─► CrossfeedR (to R)
 *   R ─► HPFilter ─► LPFilter ─► GainR ─┬──────────► ChannelMerger
 *                                       └─► CrossfeedL (to L)
 *
 * All parameter changes use smooth AudioParam automation.
 */
import { dbToGain } from '../../ui/state';
import { EntropyRng } from '../entropy/EntropyRng';
import { EntropyFeeder } from '../entropy/EntropyFeeder';
// Q for Butterworth (maximally flat passband)
const BUTTERWORTH_Q = Math.SQRT1_2; // ~0.707
// Default ramp times
const GAIN_RAMP_TIME = 0.03; // 30ms for gain changes
const FILTER_RAMP_TIME = 0.15; // 150ms for filter sweeps
/**
 * Smoothly ramp an AudioParam to a target value.
 */
function rampTo(ctx, param, value, time = GAIN_RAMP_TIME) {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + time);
}
/**
 * Smoothly ramp filter frequency (exponential is more natural for freq).
 */
function rampFreqTo(ctx, param, value, time = FILTER_RAMP_TIME) {
    const now = ctx.currentTime;
    // Clamp to valid range for exponential ramp
    const safeValue = Math.max(1, value);
    param.cancelScheduledValues(now);
    param.setValueAtTime(Math.max(1, param.value), now);
    param.exponentialRampToValueAtTime(safeValue, now + time);
}
export class AudioEngine {
    ctx = null;
    noiseNode = null;
    splitter = null;
    merger = null;
    // Per-channel filters
    hpL = null;
    hpR = null;
    lpL = null;
    lpR = null;
    // Per-channel gains
    gainL = null;
    gainR = null;
    // Crossfeed gains
    crossfeedLtoR = null;
    crossfeedRtoL = null;
    // Master
    masterGain = null;
    // Entropy
    entropyRng = null;
    entropyFeeder = null;
    // State tracking for idempotent updates
    currentMode = 'pink';
    currentVolumeDb = -12;
    currentHpFreq = 150;
    currentLpFreq = 5000;
    currentCrossfeedDb = -18;
    isMuted = true;
    /**
     * Initialize the audio engine. Must be called on user gesture.
     */
    async init() {
        if (this.ctx)
            return;
        this.ctx = new AudioContext();
        // Start entropy collection
        this.entropyRng = new EntropyRng();
        this.entropyRng.start();
        // Load worklet (served from public/ as pre-compiled JS)
        try {
            await this.ctx.audioWorklet.addModule('/worklets/NoiseProcessor.js');
        }
        catch (err) {
            throw new Error('AudioWorklet init failed. Please use a modern browser.');
        }
        // Create noise source
        this.noiseNode = new AudioWorkletNode(this.ctx, 'noise-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        // Send initial high-quality seeds from main thread (crypto available here)
        const initialSeeds = new Uint32Array(8);
        crypto.getRandomValues(initialSeeds);
        this.noiseNode.port.postMessage({ type: 'initial-seeds', seeds: initialSeeds });
        // Connect entropy feeder
        this.entropyFeeder = new EntropyFeeder(this.entropyRng);
        this.entropyFeeder.connect(this.noiseNode.port);
        this.entropyFeeder.start();
        // Create channel splitter/merger
        this.splitter = this.ctx.createChannelSplitter(2);
        this.merger = this.ctx.createChannelMerger(2);
        // Create filters (Butterworth Q)
        this.hpL = this.createBiquad('highpass', this.currentHpFreq);
        this.hpR = this.createBiquad('highpass', this.currentHpFreq);
        this.lpL = this.createBiquad('lowpass', this.currentLpFreq);
        this.lpR = this.createBiquad('lowpass', this.currentLpFreq);
        // Create channel gains (unity)
        this.gainL = this.ctx.createGain();
        this.gainR = this.ctx.createGain();
        // Create crossfeed gains (default -18dB)
        this.crossfeedLtoR = this.ctx.createGain();
        this.crossfeedRtoL = this.ctx.createGain();
        const crossfeedGain = dbToGain(this.currentCrossfeedDb);
        this.crossfeedLtoR.gain.value = crossfeedGain;
        this.crossfeedRtoL.gain.value = crossfeedGain;
        // Master gain (initially 0 for muted state)
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0;
        // Wire the graph
        // Noise → Splitter
        this.noiseNode.connect(this.splitter);
        // Left channel: Splitter[0] → HP → LP → GainL
        this.splitter.connect(this.hpL, 0);
        this.hpL.connect(this.lpL);
        this.lpL.connect(this.gainL);
        // Right channel: Splitter[1] → HP → LP → GainR
        this.splitter.connect(this.hpR, 1);
        this.hpR.connect(this.lpR);
        this.lpR.connect(this.gainR);
        // Direct paths to merger
        this.gainL.connect(this.merger, 0, 0); // L → L
        this.gainR.connect(this.merger, 0, 1); // R → R
        // Crossfeed paths
        this.gainL.connect(this.crossfeedLtoR);
        this.crossfeedLtoR.connect(this.merger, 0, 1); // L → R crossfeed
        this.gainR.connect(this.crossfeedRtoL);
        this.crossfeedRtoL.connect(this.merger, 0, 0); // R → L crossfeed
        // Merger → Master → Destination
        this.merger.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);
    }
    createBiquad(type, freq) {
        if (!this.ctx)
            throw new Error('AudioContext not initialized');
        const filter = this.ctx.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = freq;
        filter.Q.value = BUTTERWORTH_Q;
        return filter;
    }
    /**
     * Resume audio context (needed after init on some browsers).
     */
    async resume() {
        if (this.ctx?.state === 'suspended') {
            await this.ctx.resume();
        }
    }
    /**
     * Set playing state. Uses smooth gain ramp.
     */
    setPlaying(playing) {
        if (!this.ctx || !this.masterGain)
            return;
        this.isMuted = !playing;
        const targetGain = playing ? dbToGain(this.currentVolumeDb) : 0;
        rampTo(this.ctx, this.masterGain.gain, targetGain);
    }
    /**
     * Set noise mode (pink/brown).
     */
    setMode(mode) {
        if (mode === this.currentMode)
            return;
        this.currentMode = mode;
        this.noiseNode?.port.postMessage({ type: 'set-mode', mode });
    }
    /**
     * Set master volume in dB.
     */
    setVolumeDb(db) {
        if (db === this.currentVolumeDb)
            return;
        this.currentVolumeDb = db;
        if (!this.isMuted && this.ctx && this.masterGain) {
            rampTo(this.ctx, this.masterGain.gain, dbToGain(db));
        }
    }
    /**
     * Set high-pass filter frequency (Hz).
     */
    setHpFreq(freq) {
        if (freq === this.currentHpFreq)
            return;
        this.currentHpFreq = freq;
        if (this.ctx && this.hpL)
            rampFreqTo(this.ctx, this.hpL.frequency, freq);
        if (this.ctx && this.hpR)
            rampFreqTo(this.ctx, this.hpR.frequency, freq);
    }
    /**
     * Set low-pass filter frequency (Hz).
     */
    setLpFreq(freq) {
        if (freq === this.currentLpFreq)
            return;
        this.currentLpFreq = freq;
        if (this.ctx && this.lpL)
            rampFreqTo(this.ctx, this.lpL.frequency, freq);
        if (this.ctx && this.lpR)
            rampFreqTo(this.ctx, this.lpR.frequency, freq);
    }
    /**
     * Set crossfeed level in dB (-Infinity to -9dB typical).
     */
    setCrossfeedDb(db) {
        if (db === this.currentCrossfeedDb)
            return;
        this.currentCrossfeedDb = db;
        const gain = dbToGain(db);
        if (this.ctx && this.crossfeedLtoR)
            rampTo(this.ctx, this.crossfeedLtoR.gain, gain);
        if (this.ctx && this.crossfeedRtoL)
            rampTo(this.ctx, this.crossfeedRtoL.gain, gain);
    }
    /**
     * Get the entropy RNG instance for external use (e.g., PomodoroController).
     */
    getEntropyRng() {
        if (!this.entropyRng)
            throw new Error('Engine not initialized');
        return this.entropyRng;
    }
    /**
     * Clean up all resources.
     */
    dispose() {
        this.entropyFeeder?.dispose();
        this.entropyRng?.stop();
        if (this.ctx) {
            this.ctx.close();
            this.ctx = null;
        }
        this.noiseNode = null;
        this.splitter = null;
        this.merger = null;
        this.hpL = null;
        this.hpR = null;
        this.lpL = null;
        this.lpR = null;
        this.gainL = null;
        this.gainR = null;
        this.crossfeedLtoR = null;
        this.crossfeedRtoL = null;
        this.masterGain = null;
    }
}
