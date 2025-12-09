/**
 * Main entry point: Bootstraps AudioEngine and wires UI controls.
 *
 * Audio context is created lazily on first user gesture (Play button).
 */

import { AudioEngine } from './audio/engine/AudioEngine';
import { PomodoroController } from './audio/engine/PomodoroController';
import {
  createStateStore,
  DEFAULT_STATE,
  sliderToDb,
  dbToSlider,
} from './ui/state';
import type { NoiseMode, ListenerMode } from './ui/state';

// --- DOM Helpers ---

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-\u221EdB';
  return `${db.toFixed(0)}dB`;
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)}kHz`;
  return `${hz.toFixed(0)}Hz`;
}

// --- Main ---

async function main(): Promise<void> {
  const engine = new AudioEngine();
  const store = createStateStore({ ...DEFAULT_STATE });

  // UI elements
  const playBtn = getElement<HTMLButtonElement>('play-btn');
  const pinkBtn = getElement<HTMLButtonElement>('pink-btn');
  const brownBtn = getElement<HTMLButtonElement>('brown-btn');

  const volumeSlider = getElement<HTMLInputElement>('volume-slider');
  const volumeValue = getElement<HTMLSpanElement>('volume-value');

  const hpSlider = getElement<HTMLInputElement>('hp-slider');
  const hpValue = getElement<HTMLSpanElement>('hp-value');

  const lpSlider = getElement<HTMLInputElement>('lp-slider');
  const lpValue = getElement<HTMLSpanElement>('lp-value');

  const crossfeedSlider = getElement<HTMLInputElement>('crossfeed-slider');
  const crossfeedValue = getElement<HTMLSpanElement>('crossfeed-value');

  const normalModeBtn = getElement<HTMLButtonElement>('normal-mode-btn');
  const pomodoroModeBtn = getElement<HTMLButtonElement>('pomodoro-mode-btn');
  const pomodoroIndicator = getElement<HTMLDivElement>('pomodoro-indicator');
  const pomodoroMinutesEl = getElement<HTMLSpanElement>('pomodoro-minutes');

  const errorBanner = getElement<HTMLDivElement>('error-banner');

  // --- Initialize slider positions from default state ---
  volumeSlider.value = String(dbToSlider(store.get().volumeDb, -48, 0));
  hpSlider.value = String(store.get().hpFreq);
  lpSlider.value = String(store.get().lpFreq);
  // Crossfeed: map -Infinity..-9dB to 0..1
  crossfeedSlider.value = String(
    store.get().crossfeedDb === -Infinity
      ? 0
      : (store.get().crossfeedDb + 48) / (48 - 9)
  );

  // --- Pomodoro Controller ---
  let pomodoroController: PomodoroController | null = null;
  let pomodoroVolumeOffset = 0; // Current volume offset from pomodoro

  function startPomodoro(): void {
    if (pomodoroController || !initialized) return;

    // Get RNG once and close over it
    const rng = engine.getEntropyRng();

    pomodoroController = new PomodoroController(
      () => rng.nextFloat(),
      (update) => {
        store.set('pomodoroPhase', update.phase);
        store.set('pomodoroMinutes', update.minutes);
        pomodoroVolumeOffset = update.volumeOffsetDb;

        // Apply LPF from pomodoro and update UI
        engine.setLpFreq(update.lpfHz);
        lpSlider.value = String(update.lpfHz);
        lpValue.textContent = formatHz(update.lpfHz);

        // Apply volume with offset
        const currentState = store.get();
        if (currentState.playing) {
          engine.setVolumeDb(currentState.volumeDb + pomodoroVolumeOffset);
        }
      }
    );
    pomodoroController.start();
  }

  function stopPomodoro(): void {
    if (!pomodoroController) return;

    pomodoroController.dispose();
    pomodoroController = null;
    pomodoroVolumeOffset = 0;

    // Restore user's LPF setting and UI
    const state = store.get();
    engine.setLpFreq(state.lpFreq);
    lpSlider.value = String(state.lpFreq);
    lpValue.textContent = formatHz(state.lpFreq);

    // Restore volume without offset
    if (state.playing) {
      engine.setVolumeDb(state.volumeDb);
    }
  }

  // --- State → Engine sync ---
  store.subscribe((state) => {
    engine.setPlaying(state.playing);
    engine.setMode(state.mode);

    // Volume: apply pomodoro offset if active
    const effectiveVolume = state.listenerMode === 'pomodoro'
      ? state.volumeDb + pomodoroVolumeOffset
      : state.volumeDb;
    engine.setVolumeDb(effectiveVolume);

    engine.setHpFreq(state.hpFreq);

    // LPF: only apply user setting if not in pomodoro mode
    if (state.listenerMode !== 'pomodoro') {
      engine.setLpFreq(state.lpFreq);
    }

    engine.setCrossfeedDb(state.crossfeedDb);

    // Manage pomodoro controller lifecycle
    if (state.listenerMode === 'pomodoro' && !pomodoroController) {
      startPomodoro();
    } else if (state.listenerMode !== 'pomodoro' && pomodoroController) {
      stopPomodoro();
    }
  });

  // --- State → UI sync ---
  function updateUI(): void {
    const state = store.get();

    // Play button
    playBtn.textContent = state.playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('bg-amber-600', state.playing);
    playBtn.classList.toggle('hover:bg-amber-700', state.playing);
    playBtn.classList.toggle('bg-sky-600', !state.playing);
    playBtn.classList.toggle('hover:bg-sky-700', !state.playing);

    // Mode buttons
    pinkBtn.classList.toggle('bg-sky-600', state.mode === 'pink');
    pinkBtn.classList.toggle('bg-neutral-700', state.mode !== 'pink');
    brownBtn.classList.toggle('bg-sky-600', state.mode === 'brown');
    brownBtn.classList.toggle('bg-neutral-700', state.mode !== 'brown');

    // Slider values
    volumeValue.textContent = formatDb(state.volumeDb);
    hpValue.textContent = formatHz(state.hpFreq);
    lpValue.textContent = formatHz(state.lpFreq);
    crossfeedValue.textContent = formatDb(state.crossfeedDb);

    // Listener mode buttons
    normalModeBtn.classList.toggle('bg-sky-600', state.listenerMode === 'normal');
    normalModeBtn.classList.toggle('bg-neutral-700', state.listenerMode !== 'normal');
    pomodoroModeBtn.classList.toggle('bg-sky-600', state.listenerMode === 'pomodoro');
    pomodoroModeBtn.classList.toggle('bg-neutral-700', state.listenerMode !== 'pomodoro');

    // Pomodoro indicator
    pomodoroIndicator.classList.toggle('hidden', state.listenerMode !== 'pomodoro');
    pomodoroMinutesEl.textContent = String(state.pomodoroMinutes);
    pomodoroMinutesEl.classList.toggle('text-rose-400/70', state.pomodoroPhase === 'work');
    pomodoroMinutesEl.classList.toggle('text-emerald-400/70', state.pomodoroPhase === 'break');

    // Disable HP/LP sliders in pomodoro mode
    const inPomodoro = state.listenerMode === 'pomodoro';
    hpSlider.disabled = inPomodoro;
    lpSlider.disabled = inPomodoro;
    hpSlider.classList.toggle('opacity-50', inPomodoro);
    hpSlider.classList.toggle('cursor-not-allowed', inPomodoro);
    lpSlider.classList.toggle('opacity-50', inPomodoro);
    lpSlider.classList.toggle('cursor-not-allowed', inPomodoro);
  }

  store.subscribe(updateUI);
  updateUI();

  // --- Event handlers ---

  let initialized = false;

  playBtn.addEventListener('click', async () => {
    try {
      // Lazy init on first play
      if (!initialized) {
        await engine.init();
        initialized = true;

        // If pomodoro mode was selected before init, start it now
        if (store.get().listenerMode === 'pomodoro') {
          startPomodoro();
        }
      }
      await engine.resume();

      store.set('playing', !store.get().playing);
    } catch (err) {
      errorBanner.textContent =
        err instanceof Error ? err.message : 'Audio initialization failed.';
      errorBanner.classList.remove('hidden');
    }
  });

  pinkBtn.addEventListener('click', () => {
    store.set('mode', 'pink' as NoiseMode);
  });

  brownBtn.addEventListener('click', () => {
    store.set('mode', 'brown' as NoiseMode);
  });

  volumeSlider.addEventListener('input', () => {
    const s = Number(volumeSlider.value);
    const db = sliderToDb(s, -48, 0);
    store.set('volumeDb', db);
  });

  hpSlider.addEventListener('input', () => {
    const freq = Number(hpSlider.value);
    store.set('hpFreq', freq);
  });

  lpSlider.addEventListener('input', () => {
    const freq = Number(lpSlider.value);
    store.set('lpFreq', freq);
  });

  crossfeedSlider.addEventListener('input', () => {
    const s = Number(crossfeedSlider.value);
    // Map 0..1 to -Infinity..-9dB
    const db = s <= 0 ? -Infinity : -48 + s * (48 - 9);
    store.set('crossfeedDb', db);
  });

  normalModeBtn.addEventListener('click', () => {
    store.set('listenerMode', 'normal' as ListenerMode);
  });

  pomodoroModeBtn.addEventListener('click', () => {
    store.set('listenerMode', 'pomodoro' as ListenerMode);
  });
}

main().catch((err) => {
  console.error('Failed to initialize:', err);
});
