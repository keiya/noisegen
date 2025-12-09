/**
 * PomodoroController: Manages 25min work / 5min break cycles with LPF random walk.
 *
 * Responsibilities:
 * - Timer management (25min work, 5min break)
 * - LPF random walk calculation (4.5–6 kHz range)
 * - Volume offset calculation during breaks (-3dB fade)
 * - Callback notification for state changes
 */
// --- Constants ---
const WORK_DURATION_MS = 25 * 60 * 1000; // 25 minutes
const BREAK_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const LPF_MIN_HZ = 4500;
const LPF_MAX_HZ = 6000;
const LPF_CENTER_HZ = 5250;
const LPF_TAU_SEC = 8; // Exponential follow time constant
const LPF_TARGET_UPDATE_INTERVAL = 10; // Average seconds between target updates
const VOLUME_DROP_DB = -3;
// --- Controller ---
export class PomodoroController {
    rng;
    onUpdate;
    phase = 'work';
    state;
    lastTime = 0;
    rafId = null;
    running = false;
    constructor(rng, onUpdate) {
        this.rng = rng;
        this.onUpdate = onUpdate;
        // Initialize LPF at center
        this.state = {
            elapsedMs: 0,
            lpfHz: LPF_CENTER_HZ,
            targetLpfHz: LPF_CENTER_HZ,
            volumeOffsetDb: 0,
        };
    }
    /**
     * Start the pomodoro timer loop.
     */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.lastTime = performance.now();
        this.rafId = requestAnimationFrame(this.tick);
        // Emit initial state
        this.emitUpdate();
    }
    /**
     * Stop the timer and reset state.
     */
    stop() {
        this.running = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        // Reset to initial state
        this.phase = 'work';
        this.state = {
            elapsedMs: 0,
            lpfHz: LPF_CENTER_HZ,
            targetLpfHz: LPF_CENTER_HZ,
            volumeOffsetDb: 0,
        };
    }
    /**
     * Clean up resources.
     */
    dispose() {
        this.stop();
    }
    // --- Private Methods ---
    tick = (now) => {
        if (!this.running)
            return;
        const dtMs = now - this.lastTime;
        this.lastTime = now;
        // Clamp dt to avoid huge jumps (e.g., after tab was backgrounded)
        const dtSec = Math.min(dtMs / 1000, 1);
        this.state.elapsedMs += dtMs;
        this.stepLpf(dtSec);
        // Phase transition check
        if (this.phase === 'work' && this.state.elapsedMs >= WORK_DURATION_MS) {
            this.phase = 'break';
            this.state.elapsedMs = 0;
        }
        else if (this.phase === 'break' && this.state.elapsedMs >= BREAK_DURATION_MS) {
            this.phase = 'work';
            this.state.elapsedMs = 0;
        }
        // Calculate volume offset
        this.state.volumeOffsetDb = this.phase === 'break'
            ? this.getBreakVolumeOffset(this.state.elapsedMs)
            : 0;
        this.emitUpdate();
        this.rafId = requestAnimationFrame(this.tick);
    };
    stepLpf(dtSec) {
        // Probabilistically update target (average every LPF_TARGET_UPDATE_INTERVAL seconds)
        const roll = this.rng();
        const threshold = dtSec / LPF_TARGET_UPDATE_INTERVAL;
        if (roll < threshold) {
            const r = this.rng() * 2 - 1; // -1..1
            const span = LPF_MAX_HZ - LPF_MIN_HZ;
            this.state.targetLpfHz = LPF_CENTER_HZ + span * 0.5 * r;
            this.state.targetLpfHz = Math.max(LPF_MIN_HZ, Math.min(LPF_MAX_HZ, this.state.targetLpfHz));
        }
        // Exponential follow
        const alpha = 1 - Math.exp(-dtSec / LPF_TAU_SEC);
        this.state.lpfHz += (this.state.targetLpfHz - this.state.lpfHz) * alpha;
    }
    getBreakVolumeOffset(breakElapsedMs) {
        const halfBreak = BREAK_DURATION_MS / 2;
        if (breakElapsedMs < halfBreak) {
            // First half: 0 → -3 dB
            const t = breakElapsedMs / halfBreak;
            return VOLUME_DROP_DB * t;
        }
        else {
            // Second half: -3 → 0 dB
            const t = (breakElapsedMs - halfBreak) / halfBreak;
            return VOLUME_DROP_DB * (1 - t);
        }
    }
    emitUpdate() {
        const duration = this.phase === 'work' ? WORK_DURATION_MS : BREAK_DURATION_MS;
        const remainingMs = duration - this.state.elapsedMs;
        const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
        this.onUpdate({
            phase: this.phase,
            minutes,
            lpfHz: this.state.lpfHz,
            volumeOffsetDb: this.state.volumeOffsetDb,
        });
    }
}
