# Noise Generator Design

## Goals and Constraints
- Browser-based pink/brown noise generator with stereo independence and crossfeed.
- High-quality randomness: CSPRNG + user-event entropy; no audible artifacts when parameters change.
- Audio graph stays wired; never stop/disconnect nodes—use smooth automation on AudioParams.
- Built with Vite + TypeScript + vanilla DOM APIs; Tailwind for minimal UI styling.

## Architecture Overview
- `src/audio/entropy/EntropyRng.ts`: Event-mixing RNG (spec from request) running on the main thread.
- `src/audio/entropy/EntropyFeeder.ts`: Periodically pulls words from `EntropyRng` and posts them as seeds to the AudioWorklet via `port` (message-based for v1; SAB ring buffer deferred to v2 to avoid COOP/COEP friction).
- `src/audio/worklets/NoiseProcessor.ts` (AudioWorkletProcessor): Generates stereo white noise using CSPRNG + entropy seeds; shapes to pink/brown; exposes parameters via `AudioParam` automation.
- `src/audio/engine/AudioEngine.ts`: Builds the fixed audio graph, owns nodes, provides smoothing helpers, and forwards UI updates to AudioParams/MessagePort without reconnecting nodes.
- `src/ui/state.ts`: Minimal state store (current values, ranges, derived linear gains) + mapping utilities (dB ↔ linear).
- `src/main.ts`: Entry point; wires UI controls, starts audio context on user gesture, and initializes Tailwind styles.

## Audio Graph (fixed, no reconnects)
```
NoiseWorkletNode (stereo) ──► ChannelSplitter
  L ─► HP chain ─► LP chain ─► Gain L ─┐
                                       ├─► Crossfeed Mix ─► Master Gain ─► Destination
  R ─► HP chain ─► LP chain ─► Gain R ─┘

Crossfeed Mix details:
  - L_out = GainL + CrossfeedFromR
  - R_out = GainR + CrossfeedFromL
  - CrossfeedFromR/L are `GainNode`s fed from the opposite channel with adjustable gain (−∞ to −9 dB).
```

## Randomness and Entropy
- **EntropyRng** (main thread):
  - Implements the provided 256-bit pool mixer and event listeners (mousemove, wheel, keydown, scroll, resize, raf jitter).
  - Base randomness uses `crypto.getRandomValues`; event-derived words are mixed via `stir`.
- **Feeder → Worklet** (v1):
  - Every ~100–200 ms, post a small `Uint32Array` seed (e.g., 4–8 words) via `port.postMessage`.
  - Worklet requests extra seeds with `need-seed` when low; main thread responds with fresh words.
  - Worklet-side RNG seeds from `crypto.getRandomValues` at startup, runs a lightweight PRNG (e.g., xoshiro/PCG) per channel, and XOR-mixes incoming seeds into its state. If seeds pause, it continues with its PRNG + initial CSPRNG seed (no pops).
- **Future v2**: SharedArrayBuffer ring buffer can be added once COOP/COEP headers are in place.

## Noise Synthesis (Worklet)
- **White noise source**: Pulls random floats in `[−1, 1)` from the mixed RNG per sample, per channel (independent sequences for L/R).
- **Pink noise**: Paul Kellet filter (3-tap IIR) applied per channel.
- **Brown noise**: Accumulated white noise with sampleRate-derived coefficients:
  - Define a time constant `tau` (e.g., 0.02 s) that controls how "slow" the random walk feels.
  - Compute decay per sample: `decay = Math.exp(-1 / (sampleRate * tau))`.
  - Update: `b = decay * b + (1 - decay) * white`, clamped to ±1.
  - This ensures consistent spectral slope across 44.1k/48k/96k.
- **Mode switching**: Controlled via `AudioParam`/`port` flag; internal state uses **equal-power crossfade** (~50 ms) between pink/brown outputs:
  - `t`: crossfade progress 0→1 over ~50 ms.
  - `out = cos(0.5 * π * t) * oldMode + sin(0.5 * π * t) * newMode`.
  - This avoids the perceived volume dip that linear crossfade produces.

## Filters and Slopes
- Each channel has one high-pass and one low-pass **BiquadFilterNode** (2nd order, ~12 dB/Oct); nodes stay connected permanently.
- **Q value: 0.707** (Butterworth) for both HP and LP to achieve flat passband response without resonance peak at cutoff.
- High-pass freq range: 1–200 Hz (default 150). Low-pass range: 1000–8000 Hz (default 5000).
- Cutoff changes are applied to the Biquad `frequency` AudioParam with ~0.1–0.2 s ramps to avoid zipper noise.
- Stick with Biquad because `IIRFilterNode` coefficients cannot be hot-swapped; this avoids node reconstruction during sweeps.
- No slope selection in v1. If steeper/shallower curves are desired later, a second Biquad can be cascaded (24 dB/Oct) or a 1st-order worklet filter added, but v1 keeps 12 dB/Oct fixed for simplicity.

## Gains, Crossfeed, and Smoothing
- Volume control: UI slider in dB (e.g., −48 dB to 0 dB). Mapping: `linear = 10^(dB/20)`. Applied to `masterGain.gain` with 30–50 ms `linearRampToValueAtTime`.
- Play/Pause: Toggle master gain between target volume and −∞ (mute) using the same smoothing; generators keep running.
- Crossfeed: Continuous **dB slider** from −∞ (off) to −9 dB. Two crossfeed `GainNode`s receive the converted linear gain; ramp over ~50 ms to avoid zipper noise. Optional future tweak: low-pass the crossfeed path (~700–1500 Hz) and add slight delay to mimic speaker bleed (v2).
- Noise mode switch: Crossfade inside worklet rather than toggling nodes.

## UI / UX
- Simple panel (Tailwind):
  - Play/Pause button (primary style, shows active state).
  - Noise type toggle buttons (Pink / Brown) with active styling.
  - Sliders: Volume (dB), High-pass freq, Low-pass freq, Crossfeed (dB). Labels show live values; slopes are fixed at 12 dB/Oct.
- Layout: single-column on mobile; two-column grouping on desktop (filters on one side, playback/noise controls on the other). No extraneous animations beyond subtle hover/focus.

## State and Messaging
- `AppState` holds current params; updates call into `AudioEngine` setters that schedule smooth changes.
- `AudioEngine` sends control messages to the worklet (`mode`, `entropy seeds`) and updates `AudioParam`s for gains/filter cutoffs.
- All updates are idempotent; repeated writes with the same value are ignored to reduce automation spam.

## Smooth Parameter Helpers
- Common helper `rampTo(param, value, time = 0.05)`:
  - `now = ctx.currentTime; param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); param.linearRampToValueAtTime(value, now + time);`
- Use shorter ramps (~0.03 s) for gain changes, longer (~0.1–0.2 s) for filter moves to avoid zipper noise.

## Errors and Fallbacks
- If AudioWorklet fails to load, display an error message: "AudioWorklet init failed. Please use a modern browser." No ScriptProcessorNode fallback (deprecated).
- If entropy feeder underflows, the worklet continues with `crypto.getRandomValues` (CSPRNG) so audio never stops; a warning banner can show "Using fallback RNG".
- Handle autoplay restrictions by instantiating the audio context on first user gesture (Play click) and lazily loading the worklet module.

## Files (planned)
- `src/audio/entropy/EntropyRng.ts`
- `src/audio/entropy/EntropyFeeder.ts`
- `src/audio/worklets/NoiseProcessor.ts` — AudioWorkletProcessor; see build notes below.
- `src/audio/engine/AudioEngine.ts`
- `src/ui/state.ts`
- `src/main.ts`
- `index.html`, `tailwind.css`, `vite.config.ts`

### Vite AudioWorklet Build
Vite does not automatically bundle AudioWorklet files. Use one of:
1. **`new URL()` import** (recommended):
   ```ts
   const workletUrl = new URL('./worklets/NoiseProcessor.ts', import.meta.url);
   await ctx.audioWorklet.addModule(workletUrl);
   ```
   Vite resolves and bundles the module separately.
2. **vite-plugin-audio-worklet** or similar plugin if more control is needed.
