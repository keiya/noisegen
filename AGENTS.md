いいね、その方向性めちゃ好き。
じゃあ「このリポジトリで TypeScript 書くときはこうしてくれ」という **AGENTS.md のたたき台**つくるね。

そのままコピペして使えるようにしてあるので、要らないとこは消したり足したりしてくれればOK。

````md
# AGENTS.md

Guidelines for AI assistants generating code in this repository.

This project is **modern browser TypeScript** (Vite + TS + Tailwind, vanilla DOM / Web APIs, Web Audio).  
All generated code should follow the rules below unless the user explicitly asks otherwise.

---

## 1. General Principles

- Prefer **clarity over cleverness**.
- Assume **ESNext modules** and **modern evergreen browsers**.
- Code must be:
  - Type-safe (`strict: true` in `tsconfig.json` assumed)
  - Small and composable
  - Easy to skim and modify later

When in doubt, write the code as if a mid-level frontend dev will maintain it for years.

---

## 2. TypeScript Style

### 2.1 Language level

- Target **ESNext** features:
  - Use `const` / `let`, never `var`.
  - Use **arrow functions** for inline callbacks and simple utilities.
  - Use **optional chaining** and **nullish coalescing** where appropriate.
  - Prefer `for...of`, `Array.prototype.map/filter/reduce` over manual `for` loops, unless performance-critical.

### 2.2 Types

- `strict: true` を前提にする。
- Avoid `any` and `unknown` unless absolutely necessary.
  - If you must use `any`, add a short comment why.
- Prefer **type aliases** for most cases:

  ```ts
  type NoiseMode = "pink" | "brown";
  ```

* Use `interface` mainly for:

  * Public shapes (API-like)
  * Objects that are likely to be extended

* Narrow types as early as possible with type guards instead of casting:

  ```ts
  if (!(event.target instanceof HTMLInputElement)) return;
  ```

* Use enums **only** if you need a runtime object. Otherwise use union string literals.

* Array/object index access may return `undefined`—always check:
  ```ts
  const first = arr[0];
  if (first === undefined) return;
  ```

* Use `import type` for type-only imports:
  ```ts
  import type { NoiseMode } from './types';
  ```

* Catch variables are `unknown`—narrow before use:
  ```ts
  catch (e) {
    if (e instanceof Error) console.error(e.message);
  }
  ```

### 2.3 Functions and modules

* Prefer small, single-purpose functions.
* Keep modules focused:

  * `audio/` → Web Audio graph and DSP-related helpers
  * `ui/` → DOM and user interaction
  * `state/` → simple state management and mapping utilities

Example:

```ts
// audio/gain.ts
export function dbToGain(db: number): number {
  if (db <= -100) return 0;
  return Math.pow(10, db / 20);
}
```

---

## 3. Browser & DOM Code

* Use **vanilla DOM APIs**, no framework unless explicitly requested.
* Attach events with `addEventListener`. Do not use inline `onclick` attributes.

```ts
const slider = document.querySelector<HTMLInputElement>("#volume");
if (!slider) throw new Error("#volume not found");

slider.addEventListener("input", () => {
  const value = Number(slider.value);
  // ...
});
```

* Always null-check DOM queries with appropriate generics (`querySelector<...>()`).
* Prefer `classList.add/remove/toggle` instead of `className` rewrite.

---

## 4. Web Audio & Noise Engine Rules

When working with audio in this project, follow these constraints:

### 4.1 Graph design

* **Build the audio graph once** and keep it connected.
* Do **not**:

  * Stop / restart sources unnecessarily
  * Reconnect nodes for parameter changes
* Do:

  * Use `AudioParam` automation (`linearRampToValueAtTime`, `setTargetAtTime`) for smooth changes.
  * Keep the graph topology stable.

### 4.2 Parameter changes

* All user-facing controls must be **click/pop free**.

* Use helper functions for smoothing:

  ```ts
  export function rampTo(
    param: AudioParam,
    value: number,
    time = 0.05
  ): void {
    const ctx = param.context as AudioContext;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + time);
  }
  ```

* Typical ramp times:

  * Gain: **30–50 ms**
  * Filter cutoff: **100–200 ms**

### 4.3 Randomness

* For randomness, **do not use `Math.random`**.
* Use `crypto.getRandomValues` as the base, plus entropy utilities provided by this repo (`EntropyRng` etc.) when available.

---

## 5. dB, Sliders, and Mapping

* User volume controls should be in **dB**, not linear gain.
* Map slider value `[0, 1]` to `[-60 dB, 0 dB]` (or similar) and then to linear gain:

```ts
export function sliderToDb(s: number, minDb = -60, maxDb = 0): number {
  if (s <= 0) return -Infinity;
  return minDb + (maxDb - minDb) * s;
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= -100) return 0;
  return Math.pow(10, db / 20);
}
```

* When generating UI code:

  * Show dB labels if the user is audio-literate.
  * Otherwise you may display `0–100` while still using dB internally.

---

## 6. Code Organization in This Repo

When adding new code, prefer these locations:

* `src/audio/`
  Web Audio setup, processors, and audio-related utilities.
* `src/audio/entropy/`
  Entropy / RNG related logic (no DOM here).
* `src/audio/engine/`
  AudioEngine: constructs and owns the AudioContext graph.
* `src/ui/`
  DOM bindings, event listeners, simple view logic.
* `src/ui/state.ts`
  Small state container and mapping utilities.
* `src/main.ts`
  Bootstrapping: create `AudioEngine`, bind UI, start on user gesture.

New logic should be attached to the **closest relevant layer** instead of putting everything into `main.ts`.

---

## 7. Tailwind & Styling

* Use Tailwind utility classes for layout and basic styling.
* Keep HTML semantic (e.g., `button`, `label`, `fieldset`).
* Do not generate custom CSS files unless the user explicitly asks.

Example:

```html
<button
  id="play"
  class="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
>
  Play
</button>
```

---

## 8. How to Modify Existing Code

When the user asks you to update code:

1. **Preserve existing structure** unless they request refactoring.
2. Prefer **minimal diffs**:

   * Show only the updated function / module when possible.
3. Do not introduce new dependencies or frameworks unless asked.
4. Respect all rules in this document even when editing small snippets.

---

## 9. Things to Avoid

* `any` や `as unknown as T` の多用。
* `Math.random` ベースの乱数。
* `var`、古いブラウザ互換のための不要なポリフィル。
* インラインイベントハンドラ (`onclick="..."` など)。
* 不必要に複雑なメタプログラミングや過剰な抽象化。

---

If any requirement in this file conflicts with the explicit user request in a conversation, **the user’s request wins**, but otherwise follow these rules strictly.

```
