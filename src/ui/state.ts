/**
 * Minimal state store and dB/linear mapping utilities.
 */

export type NoiseMode = 'pink' | 'brown';

export interface AppState {
  playing: boolean;
  mode: NoiseMode;
  volumeDb: number;       // Master volume in dB (e.g., -48 to 0)
  hpFreq: number;         // High-pass cutoff Hz (1–200)
  lpFreq: number;         // Low-pass cutoff Hz (1000–8000)
  crossfeedDb: number;    // Crossfeed level in dB (-Infinity to -9)
}

export const DEFAULT_STATE: Readonly<AppState> = {
  playing: false,
  mode: 'pink',
  volumeDb: -12,
  hpFreq: 150,
  lpFreq: 5000,
  crossfeedDb: -18,
};

// --- dB ↔ linear conversion ---

/**
 * Convert a slider value [0, 1] to dB.
 * slider=0 → minDb, slider=1 → maxDb
 * slider≤0 returns -Infinity (full mute).
 */
export function sliderToDb(s: number, minDb = -48, maxDb = 0): number {
  if (s <= 0) return -Infinity;
  return minDb + (maxDb - minDb) * s;
}

/**
 * Convert dB to slider value [0, 1].
 */
export function dbToSlider(db: number, minDb = -48, maxDb = 0): number {
  if (!Number.isFinite(db) || db <= minDb) return 0;
  if (db >= maxDb) return 1;
  return (db - minDb) / (maxDb - minDb);
}

/**
 * Convert dB to linear gain.
 */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= -100) return 0;
  return Math.pow(10, db / 20);
}

/**
 * Convert linear gain to dB.
 */
export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

// --- Simple state container ---

export type StateListener = (state: Readonly<AppState>) => void;

export function createStateStore(initial: AppState = { ...DEFAULT_STATE }) {
  let state: AppState = { ...initial };
  const listeners = new Set<StateListener>();

  return {
    get(): Readonly<AppState> {
      return state;
    },

    set<K extends keyof AppState>(key: K, value: AppState[K]): void {
      if (state[key] === value) return; // idempotent
      state = { ...state, [key]: value };
      for (const fn of listeners) fn(state);
    },

    subscribe(fn: StateListener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
