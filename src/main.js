/**
 * Main entry point: Bootstraps AudioEngine and wires UI controls.
 *
 * Audio context is created lazily on first user gesture (Play button).
 */
import { AudioEngine } from './audio/engine/AudioEngine';
import { createStateStore, DEFAULT_STATE, sliderToDb, dbToSlider, } from './ui/state';
// --- DOM Helpers ---
function getElement(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`Element #${id} not found`);
    return el;
}
function formatDb(db) {
    if (!Number.isFinite(db))
        return '-\u221EdB';
    return `${db.toFixed(0)}dB`;
}
function formatHz(hz) {
    if (hz >= 1000)
        return `${(hz / 1000).toFixed(1)}kHz`;
    return `${hz.toFixed(0)}Hz`;
}
// --- Main ---
async function main() {
    const engine = new AudioEngine();
    const store = createStateStore({ ...DEFAULT_STATE });
    // UI elements
    const playBtn = getElement('play-btn');
    const pinkBtn = getElement('pink-btn');
    const brownBtn = getElement('brown-btn');
    const volumeSlider = getElement('volume-slider');
    const volumeValue = getElement('volume-value');
    const hpSlider = getElement('hp-slider');
    const hpValue = getElement('hp-value');
    const lpSlider = getElement('lp-slider');
    const lpValue = getElement('lp-value');
    const crossfeedSlider = getElement('crossfeed-slider');
    const crossfeedValue = getElement('crossfeed-value');
    const errorBanner = getElement('error-banner');
    // --- Initialize slider positions from default state ---
    volumeSlider.value = String(dbToSlider(store.get().volumeDb, -48, 0));
    hpSlider.value = String(store.get().hpFreq);
    lpSlider.value = String(store.get().lpFreq);
    // Crossfeed: map -Infinity..-9dB to 0..1
    crossfeedSlider.value = String(store.get().crossfeedDb === -Infinity
        ? 0
        : (store.get().crossfeedDb + 48) / (48 - 9));
    // --- State → Engine sync ---
    store.subscribe((state) => {
        engine.setPlaying(state.playing);
        engine.setMode(state.mode);
        engine.setVolumeDb(state.volumeDb);
        engine.setHpFreq(state.hpFreq);
        engine.setLpFreq(state.lpFreq);
        engine.setCrossfeedDb(state.crossfeedDb);
    });
    // --- State → UI sync ---
    function updateUI() {
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
            }
            await engine.resume();
            store.set('playing', !store.get().playing);
        }
        catch (err) {
            errorBanner.textContent =
                err instanceof Error ? err.message : 'Audio initialization failed.';
            errorBanner.classList.remove('hidden');
        }
    });
    pinkBtn.addEventListener('click', () => {
        store.set('mode', 'pink');
    });
    brownBtn.addEventListener('click', () => {
        store.set('mode', 'brown');
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
}
main().catch((err) => {
    console.error('Failed to initialize:', err);
});
