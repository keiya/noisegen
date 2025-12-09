# Noise Generator

ブラウザベースの高品質ピンク/ブラウンノイズジェネレーター。

## Features

- **ノイズタイプ**: Pink / Brown ノイズを切り替え
- **高品質乱数**: `crypto.getRandomValues` (CSPRNG) + ユーザーイベントエントロピー混合
- **ステレオ独立生成**: 左右チャンネルで独立した乱数シーケンス
- **フィルター**: HPF (1-200Hz) / LPF (1000-8000Hz)、12dB/oct
- **クロスフィード**: ステレオチャンネルのブレンド調整
- **ポモドーロモード**: 25分作業 + 5分休憩サイクルを音で体感
  - LPFがゆるやかにランダムウォーク (4.5-6kHz)
  - 休憩時に音量が自動的に変化

## Tech Stack

- **Vite** - 高速な開発サーバー＆ビルド
- **TypeScript** - 型安全なコード
- **Tailwind CSS** - ユーティリティファーストのスタイリング
- **Web Audio API** - AudioWorklet によるリアルタイム音声処理

## Architecture

```
src/
├── audio/
│   ├── entropy/
│   │   ├── EntropyRng.ts      # イベント混合RNG (256-bit pool)
│   │   └── EntropyFeeder.ts   # Workletへのエントロピー供給
│   ├── worklets/
│   │   └── NoiseProcessor.ts  # AudioWorkletProcessor (ノイズ生成)
│   └── engine/
│       ├── AudioEngine.ts     # オーディオグラフ管理
│       └── PomodoroController.ts  # ポモドーロタイマー
├── ui/
│   └── state.ts               # 状態管理 + dB/linear変換
└── main.ts                    # エントリポイント
```

### Audio Graph

```
NoiseWorkletNode (stereo) -> ChannelSplitter
  L -> HPF -> LPF -> GainL -+
                            +-> Crossfeed Mix -> MasterGain -> Destination
  R -> HPF -> LPF -> GainR -+
```

オーディオグラフは一度構築したら再接続しない。パラメータ変更は全て `AudioParam` のスムーズな自動化で行う。

## Development

### Requirements

- Node.js 18+
- npm

### Setup

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動 (http://localhost:5173)
npm run dev

# プロダクションビルド
npm run build

# ビルド結果のプレビュー
npm run preview
```

### Project Structure

| ファイル | 役割 |
|---------|------|
| `index.html` | UIテンプレート (Tailwind) |
| `src/main.ts` | アプリ初期化、UI イベントバインディング |
| `src/audio/engine/AudioEngine.ts` | AudioContext とグラフ管理 |
| `src/audio/worklets/NoiseProcessor.ts` | ノイズ生成 (Worklet) |
| `src/ui/state.ts` | アプリ状態とdB変換ユーティリティ |

## Design Decisions

- **Math.random 禁止**: 全ての乱数は `crypto.getRandomValues` ベース
- **ノード再接続禁止**: パラメータ変更は AudioParam の ramp で行う
- **クリック/ポップ防止**: ゲイン変更は 30-50ms、フィルター変更は 100-200ms でスムーズ化
- **等パワークロスフェード**: ノイズモード切り替え時の音量ディップを防止

詳細は [DESIGN.md](./DESIGN.md) を参照。

## Browser Support

モダンブラウザ (Chrome, Firefox, Safari, Edge の最新版) が必要。
AudioWorklet をサポートしていないブラウザではエラーメッセージを表示。

## License

Private
