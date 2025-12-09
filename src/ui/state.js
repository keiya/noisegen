/**
 * Minimal state store and dB/linear mapping utilities.
 */
export const DEFAULT_STATE = {
    playing: false,
    mode: 'pink',
    volumeDb: -12,
    hpFreq: 150,
    lpFreq: 5000,
    crossfeedDb: -18,
    listenerMode: 'normal',
    pomodoroPhase: 'work',
    pomodoroMinutes: 25,
};
// --- dB ↔ linear conversion ---
/**
 * Convert a slider value [0, 1] to dB.
 * slider=0 → minDb, slider=1 → maxDb
 * slider≤0 returns -Infinity (full mute).
 */
export function sliderToDb(s, minDb = -48, maxDb = 0) {
    if (s <= 0)
        return -Infinity;
    return minDb + (maxDb - minDb) * s;
}
/**
 * Convert dB to slider value [0, 1].
 */
export function dbToSlider(db, minDb = -48, maxDb = 0) {
    if (!Number.isFinite(db) || db <= minDb)
        return 0;
    if (db >= maxDb)
        return 1;
    return (db - minDb) / (maxDb - minDb);
}
/**
 * Convert dB to linear gain.
 */
export function dbToGain(db) {
    if (!Number.isFinite(db) || db <= -100)
        return 0;
    return Math.pow(10, db / 20);
}
/**
 * Convert linear gain to dB.
 */
export function gainToDb(gain) {
    if (gain <= 0)
        return -Infinity;
    return 20 * Math.log10(gain);
}
export function createStateStore(initial = { ...DEFAULT_STATE }) {
    let state = { ...initial };
    const listeners = new Set();
    return {
        get() {
            return state;
        },
        set(key, value) {
            if (state[key] === value)
                return; // idempotent
            state = { ...state, [key]: value };
            for (const fn of listeners)
                fn(state);
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
