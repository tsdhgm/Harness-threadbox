<p align="center"><a href="README.md">English</a> | <b>日本語</b></p>

# harness-threadbox (`hthreadbox`)

> 本ファイルは [README.md](README.md)（英語）の翻訳です。内容が食い違う場合は英語版を正とします。

AI コーディングハーネスのセッションログを Linux コンソール（TUI）で閲覧するツールです。
**いま実行中** のセッションをストリーミングで表示し、過去のすべてのセッションを
プロジェクトごとに 1 本の連続したトランスクリプトとして読み返せます。

最初に対応したハーネスは **Claude Code** です（`~/.claude/projects/` 配下の JSONL
トランスクリプトを読みます）。Codex / Gemini / Grok は同じインターフェースの
プロバイダとして追加する予定です。

VS Code 拡張 [vsc-claude-threadbox](https://github.com/tosihide/vsc-claude-threadbox)
のコンソール版にあたります。

**Anthropic とは無関係です。** Claude Code がローカルに書き出すファイルを読むだけの
非公式ビューアで、Claude を起動したり通信したりすることはありません。

## 機能

- **3 ペイン構成。** 左: プロジェクト（リポジトリ）の一覧。最近活動したものが下に並び、
  ライブマーク（`●` 実行中、`○` 待機中）とセッション数を表示します。中央: 選択した
  プロジェクトのセッション一覧。右: Claude Code 自身の出力を再現したトランスクリプト。
  `> プロンプト`、`⏺ 本文`、`⏺ Bash(cmd)` と `⎿ 結果` のプレビュー、`✻ Thinking…`、
  編集の差分色付け。
- **プロジェクト内の連続スクロール。** 右ペインは選択プロジェクトの全セッションを
  連結した 1 本の仮想ドキュメントです。セッションの末尾を越えると次のセッションが
  始まりますが、プロジェクトの外には出ません。中央の選択は表示中のセッションに
  追従します。左ペインで移動すると他の 2 ペインが切り替わり、中央ペインでクリック
  または Enter するとそのセッションにジャンプします。
- **ライブ追従。** 実行中セッションは `~/.claude/sessions/` から検出します。
  ライブセッションの末尾を表示していると新しいターンが追記され、表示が末尾に
  張り付きます（ステータスバーに `FOLLOW`）。結果待ちのツール呼び出しは、結果が
  届くまで `⎿ Running…` と表示されます。
- **ツールごとの要約表示。** コマンド、ファイルパス、`Added N lines, removed M` と
  色付き差分、`Read N lines`、エージェントの説明、Web 検索語、MCP ツール名。
- **検索とフィルタ。** `/` でプロジェクト内のセッションを横断検索（必要に応じて
  読み込み）、`n`/`N` で一致箇所を移動。thinking 本文の表示切替、ツール出力の
  詳細度の切替（折りたたみ / 全文 / 非表示）、ツール専用ターンの非表示、
  隠しメタレコードの表示。
- **Markdown エクスポート。** 任意のセッションを出力（TUI の `e`、または
  `hthreadbox export`）。
- **ペイン幅の変更。** `[`、`]`、`\`、またはマウスで境界をドラッグ。
- **非対話モード。** パイプやスクリプト向けに `cat`、`cat -f`、`list --json`、`export`。
- 実際のログ形式に対応。1 レコード 1 ブロックに分割されたアシスタント発言
  （`message.id` でマージ）、`attachment` 封筒、`isMeta` レコード、スラッシュ
  コマンドの包み、`<persisted-output>` 参照、コンパクション境界、画像、14 MB の
  セッション（先頭・末尾の読み取りでインデックス化し、遅延ロード）。

## インストール

Node.js 24 以上が必要です（Linux。macOS も動くはずです。Windows は後述）。

```bash
git clone https://github.com/tsdhgm/Harness-threadbox.git
cd Harness-threadbox
npm install
npm run build
npm link            # `hthreadbox` を PATH に登録
```

リンクせずに実行する場合は `node dist/cli.js` です。

### Windows: WSL（推奨）

Node.js 24 以上を入れた WSL ディストリビューション（Ubuntu など）の中で、上と同じ
コマンドでインストールします。Claude Code 自体も WSL で動かしている場合、ログは
WSL のホームディレクトリ（`~/.claude`）にあり、Linux と同じように動作します。

Claude Code を Windows 側で動かしている場合、ログは Windows のプロファイル配下に
あります。`/mnt/c` マウント経由で場所を指定してください。

```bash
hthreadbox --claude-dir /mnt/c/Users/<you>/.claude
```

WSL の境界を越えてログを読む場合、次の 2 つの制約があります。

- `/mnt/c` ではファイル変更イベントが届かないため、ライブセッションの更新は
  ライブと判定済みのファイルに対する 2 秒ごとのポーリングだけに頼ります。新しい
  セッションやプロジェクトは自動では現れず、`r`（再走査）で表示されます。
- Windows 側のライブレジストリにあるプロセス ID は WSL から見えないため、ライブ
  判定は「直近 60 秒以内に更新された」（一覧では `◌`）にフォールバックします。

端末は Windows Terminal を推奨します。tmux の中で使う場合は `set -g mouse on` で
マウスを有効にしてください。

### Windows: PowerShell または cmd.exe（実験的）

`hthreadbox` は Linux で開発・テストしています。ネイティブ Windows での動作は
作者未検証ですが、Linux 固有の仕組みは使っていません。`node:tty` の生モード、
`fs.watch`、標準的な VT エスケープシーケンスだけで、いずれも Windows 10/11 の
**Windows Terminal** で動作します（従来のコンソールホストは非対応）。
Node.js 24 以上と Git for Windows が必要です。

PowerShell:

```powershell
git clone https://github.com/tsdhgm/Harness-threadbox.git
cd Harness-threadbox
npm install
npm run build
npm link            # %APPDATA%\npm に hthreadbox.cmd / hthreadbox.ps1 を作成
hthreadbox
```

cmd.exe でもコマンドは同じです。PowerShell が `hthreadbox.ps1` の実行を拒否する
場合（"running scripts is disabled"）は、`Set-ExecutionPolicy -Scope CurrentUser
RemoteSigned` でローカルスクリプトを一度許可するか、拡張子付きで
`hthreadbox.cmd` を呼んでください。

ネイティブ Windows での注意点:

- ログは `%USERPROFILE%\.claude`（または `%CLAUDE_CONFIG_DIR%`）から読みます。
  プロジェクトディレクトリ名は Claude Code のエンコード規則に従い、たとえば
  `C--Users-you-src-myrepo` になります。`--project C:\Users\you\src\myrepo` も使えます。
- `npm run smoke:tui` は bash と tmux が必要なため WSL / Linux 専用です。ユニット
  テスト（`npm test`）と `npm run smoke` はどこでも動きます。
- `⏺` / `⎿` が 2 マス幅や豆腐で表示される場合は `--ascii` を付けるか
  `HTHREADBOX_ASCII=1` を設定してください。

## 使い方

```
hthreadbox                                   # TUI（全プロジェクト）
hthreadbox --project ~/src/myrepo            # このプロジェクトのセッションのみ
hthreadbox cat latest                        # 最新セッションを出力（stdout が TTY なら ANSI 色付き）
hthreadbox cat live -f                       # 最新のライブセッションを tail -f のように追従
hthreadbox cat 6aa06f9a --no-color --tools full --thinking --width 120
hthreadbox export latest -o session.md       # Markdown エクスポート（ -o - で stdout へ）
hthreadbox list [--json] [--live]
```

`<session>` にはセッション ID、一意に決まる ID の前方一致、`.jsonl` ファイルの
パス、`latest`（既定）、`live` のいずれかを指定します。

共通オプション: `--claude-dir DIR`（既定は `$CLAUDE_CONFIG_DIR` または
`~/.claude`）、`--project PATH`、`--ascii`（`⏺`/`⎿`/`✻` を 2 マス幅で描く端末向けに
`*`/`L`/`~` を使う）、`--no-color`（`NO_COLOR` / `FORCE_COLOR` も尊重）。

### キー操作

| キー | トランスクリプト（右） | セッション（中央） | プロジェクト（左） |
|---|---|---|---|
| `j`/`↓`、`k`/`↑` | 1 行スクロール | 選択を移動 | プロジェクトを切替 |
| `PgDn`/`Space`/`Ctrl-f`、`PgUp`/`Ctrl-b` | ページ | ページ | ページ |
| `d` / `u` | 半ページ | | |
| `g` / `G` | プロジェクトの先頭 / 末尾（`G` は追従を有効化） | 最初 / 最後のセッション | 最初 / 最後のプロジェクト |
| `Tab` / `Shift-Tab` | フォーカスを巡回: プロジェクト → セッション → トランスクリプト | | |
| `Enter` / クリック | | 選択セッションを表示 | そのセッション一覧へ |
| `L` | 次のライブセッションへジャンプ（全プロジェクト対象） | | |
| `/`、`n`、`N` | プロジェクト内を検索、次、前 | | |
| `t` | thinking 本文の表示切替 | | |
| `o` | ツール出力: 折りたたみ → 全文 → 非表示 | | |
| `h` | ツール専用のアシスタントターンを非表示 | | |
| `m` | 隠しメタレコードを表示 | | |
| `[` `]` `\` | フォーカス中ペインの右側の境界を −2 / +2 / 両方リセット | | |
| `e` | Markdown にエクスポート | 選択セッションをエクスポート | |
| `r` | セッションを再走査 | | |
| `?` / `q` | ヘルプ / 終了 | | |

マウス: ホイールはポインタ下のペインをスクロール、クリックで選択、境界のドラッグで
幅を変更。80 桁未満ではフォーカス中のペインだけを表示します（`Tab` で巡回）。
tmux の中では `set -g mouse on` が必要です。

## セッションの見つけ方

```
cwd  →  realpath  →  /[^A-Za-z0-9-]/ を "-" に置換  →  ~/.claude/projects/<encoded>/<sessionId>.jsonl
```

エンコード後の名前は元に戻せないため、表示する作業ディレクトリはレコード内の
`cwd` フィールドから取得します。ライブセッションは `~/.claude/sessions/<pid>.json`
（`kill -0` で確認）から判定し、見つからない場合は「直近 1 分以内に更新された」
ことをフォールバックとします。

サブエージェントのトランスクリプト（`<sessionId>/subagents/agent-*.jsonl`）は
まだ表示していません。データモデルには余地を残してあります。

## 開発

使用している言語・ライブラリ・端末制御技術の入門者向け解説は
[docs/TECHNOLOGY.md](docs/TECHNOLOGY.md)（英語）と、その日本語訳
[docs/TECHNOLOGY.ja.md](docs/TECHNOLOGY.ja.md) を参照してください。

```bash
npm run dev -- list            # tsx でソースから実行
npm test                       # vitest（フィクスチャは test/fixtures）
npm run lint
npm run build && npm run smoke # ~/.claude に対する実データスモークテスト（無ければスキップ）
npm run smoke:tui              # tmux の中で TUI を操作して確認
node dist/cli.js --frames 3 --size 120x40 --keys "G,k,Tab"   # デバッグ用にフレームを stdout へ描画
```

アーキテクチャ、Claude Code のログ形式に関するメモ、プロバイダの追加手順は
`CLAUDE.md` を参照してください。

## ライセンス

MIT
