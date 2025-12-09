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

---

# Pomodoro Breathe Mode

## 概要

25分作業 + 5分休憩のサイクルを音で体感できるモード。

- **LPFランダムウォーク**: 4.5〜6 kHz の範囲で緩やかに変動（tau=8秒で追従）
- **休憩時の音量変化**: 25分経過後、2.5分かけて -3dB → 2.5分かけて元に戻る
- **スライダー制御**: HPF/LPFスライダーは read-only（表示は継続）
- **UI表示**: 分単位で超subtleに状態表示

---

## 状態設計

### ListenerMode（新規）

```ts
// NoiseMode ('pink' | 'brown') とは別の軸
export type ListenerMode = 'normal' | 'pomodoro';
```

後から追加できるよう union type で定義。

### AppState への追加

```ts
export interface AppState {
  // --- 既存 ---
  playing: boolean;
  mode: NoiseMode;
  volumeDb: number;
  hpFreq: number;
  lpFreq: number;
  crossfeedDb: number;

  // --- 新規 ---
  listenerMode: ListenerMode;
  pomodoroPhase: 'work' | 'break';  // pomodoro時のみ意味を持つ
  pomodoroMinutes: number;          // 残り分数（表示用）
}
```

### Pomodoro 内部状態（PomodoroController 内）

```ts
interface PomodoroInternalState {
  elapsedMs: number;        // 現フェーズの経過時間
  lpfHz: number;            // 現在のLPF周波数
  targetLpfHz: number;      // ランダムウォークのターゲット
  volumeOffsetDb: number;   // 休憩時の音量オフセット (-3〜0)
}
```

---

## 定数

```ts
const WORK_DURATION_MS = 25 * 60 * 1000;   // 25分
const BREAK_DURATION_MS = 5 * 60 * 1000;   // 5分

const LPF_MIN_HZ = 4500;
const LPF_MAX_HZ = 6000;
const LPF_CENTER_HZ = 5250;
const LPF_TAU_SEC = 8;       // 追従の時定数
const LPF_TARGET_UPDATE_INTERVAL = 10;  // 平均10秒ごとにターゲット更新

const VOLUME_DROP_DB = -3;
```

---

## ファイル構成

```
src/
├── audio/
│   └── engine/
│       ├── AudioEngine.ts      # getEntropyRng() 追加のみ
│       └── PomodoroController.ts  # 新規: タイマー + LPFウォーク + 音量制御
├── ui/
│   ├── state.ts               # ListenerMode, pomodoroPhase, pomodoroMinutes 追加
│   └── pomodoro.ts            # 新規: UIバインディング（ボタン、状態表示）
└── main.ts                    # PomodoroController の生成・接続
```

---

## PomodoroController 詳細

### 責務

1. 25分/5分タイマーの管理
2. LPFランダムウォークの計算
3. 休憩時の音量オフセット計算
4. 状態変更のコールバック通知

### インターフェース

```ts
type PomodoroCallback = (update: {
  phase: 'work' | 'break';
  minutes: number;       // 残り分数
  lpfHz: number;         // 適用すべきLPF周波数
  volumeOffsetDb: number; // 適用すべき音量オフセット
}) => void;

export class PomodoroController {
  constructor(
    rng: () => number,      // EntropyRng.nextFloat を渡す
    onUpdate: PomodoroCallback
  );

  start(): void;   // タイマー開始
  stop(): void;    // タイマー停止、状態リセット
  dispose(): void; // リソース解放
}
```

### LPFランダムウォーク

```ts
private stepLpf(dtSec: number): void {
  // 確率的にターゲット更新（平均10秒ごと）
  if (this.rng() < dtSec / LPF_TARGET_UPDATE_INTERVAL) {
    const r = this.rng() * 2 - 1; // -1..1
    const span = LPF_MAX_HZ - LPF_MIN_HZ;
    this.state.targetLpfHz = LPF_CENTER_HZ + span * 0.5 * r;
    this.state.targetLpfHz = Math.max(LPF_MIN_HZ, Math.min(LPF_MAX_HZ, this.state.targetLpfHz));
  }

  // 指数的追従
  const alpha = 1 - Math.exp(-dtSec / LPF_TAU_SEC);
  this.state.lpfHz += (this.state.targetLpfHz - this.state.lpfHz) * alpha;
}
```

### 休憩時の音量オフセット

```ts
private getBreakVolumeOffset(breakElapsedMs: number): number {
  const halfBreak = BREAK_DURATION_MS / 2;

  if (breakElapsedMs < halfBreak) {
    // 前半 2.5分: 0 → -3 dB
    const t = breakElapsedMs / halfBreak;
    return VOLUME_DROP_DB * t;
  } else {
    // 後半 2.5分: -3 → 0 dB
    const t = (breakElapsedMs - halfBreak) / halfBreak;
    return VOLUME_DROP_DB * (1 - t);
  }
}
```

### タイマーループ

```ts
private lastTime = 0;
private rafId: number | null = null;

private tick = (now: number): void => {
  const dtSec = (now - this.lastTime) / 1000;
  this.lastTime = now;

  this.state.elapsedMs += dtSec * 1000;
  this.stepLpf(dtSec);

  // フェーズ判定
  if (this.phase === 'work' && this.state.elapsedMs >= WORK_DURATION_MS) {
    this.phase = 'break';
    this.state.elapsedMs = 0;
  } else if (this.phase === 'break' && this.state.elapsedMs >= BREAK_DURATION_MS) {
    this.phase = 'work';
    this.state.elapsedMs = 0;
  }

  // 音量オフセット計算
  this.state.volumeOffsetDb = this.phase === 'break'
    ? this.getBreakVolumeOffset(this.state.elapsedMs)
    : 0;

  // 残り分数計算
  const duration = this.phase === 'work' ? WORK_DURATION_MS : BREAK_DURATION_MS;
  const remainingMs = duration - this.state.elapsedMs;
  const minutes = Math.ceil(remainingMs / 60000);

  // コールバック
  this.onUpdate({
    phase: this.phase,
    minutes,
    lpfHz: this.state.lpfHz,
    volumeOffsetDb: this.state.volumeOffsetDb,
  });

  this.rafId = requestAnimationFrame(this.tick);
};
```

---

## UI 表示

### モード切替ボタン

Playback セクションに追加：

```html
<!-- Listener Mode -->
<fieldset class="mt-4">
  <legend class="mb-2 text-sm text-neutral-400">Mode</legend>
  <div class="flex gap-2">
    <button id="normal-mode-btn" class="...">Normal</button>
    <button id="pomodoro-mode-btn" class="...">Pomodoro</button>
  </div>
</fieldset>
```

### 状態表示（超subtle）

Pomodoro モード時のみ表示：

```html
<!-- Pomodoro indicator (shown only in pomodoro mode) -->
<div id="pomodoro-indicator" class="mt-2 hidden text-center">
  <span id="pomodoro-minutes" class="font-mono text-sm text-rose-400/70">23</span>
</div>
```

- 作業中: `text-rose-400/70`（赤系）
- 休憩中: `text-emerald-400/70`（緑系）

どちらも `/70` で opacity 下げて subtle に。

### スライダーの disabled 状態

Pomodoro モード時、HP/LP スライダーを disabled に：

```ts
hpSlider.disabled = state.listenerMode === 'pomodoro';
lpSlider.disabled = state.listenerMode === 'pomodoro';

// CSS で disabled 時の見た目を調整
// opacity-50 cursor-not-allowed など
```

値の表示は継続（PomodoroController からの値を反映）。

---

## main.ts での接続

```ts
// PomodoroController 生成
let pomodoroController: PomodoroController | null = null;

// ListenerMode 変更時
store.subscribe((state) => {
  if (state.listenerMode === 'pomodoro' && !pomodoroController) {
    pomodoroController = new PomodoroController(
      () => engine.getEntropyRng().nextFloat(),
      (update) => {
        store.set('pomodoroPhase', update.phase);
        store.set('pomodoroMinutes', update.minutes);

        // LPF適用
        engine.setLpFreq(update.lpfHz);

        // 音量 = ユーザー設定 + オフセット
        const finalVolumeDb = state.volumeDb + update.volumeOffsetDb;
        engine.setVolumeDb(finalVolumeDb);
      }
    );
    pomodoroController.start();
  } else if (state.listenerMode === 'normal' && pomodoroController) {
    pomodoroController.stop();
    pomodoroController.dispose();
    pomodoroController = null;

    // ユーザー設定のLPFに戻す
    engine.setLpFreq(state.lpFreq);
  }
});
```

### AudioEngine への追加（最小限）

```ts
// EntropyRng へのアクセサ追加
getEntropyRng(): EntropyRng {
  if (!this.entropyRng) throw new Error('Engine not initialized');
  return this.entropyRng;
}
```

---

## 実装順序

1. `src/ui/state.ts` - `ListenerMode` と関連フィールド追加
2. `src/audio/engine/PomodoroController.ts` - コントローラー実装
3. `src/audio/engine/AudioEngine.ts` - `getEntropyRng()` 追加
4. `index.html` - UI要素追加（ボタン、インジケーター）
5. `src/main.ts` - 接続とイベントハンドリング
6. CSS調整 - disabled スライダーのスタイル

---

## 将来の拡張

`ListenerMode` を union type にしているので、後から追加可能：

```ts
export type ListenerMode = 'normal' | 'pomodoro' | 'focus' | 'sleep';
```

各モードで異なるLPF挙動や音量パターンを実装できる。
