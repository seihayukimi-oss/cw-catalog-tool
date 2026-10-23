# CWカタログ（ツール）

CardWirth（1.50／Next 1.60／Py）のシナリオを、**正しいフォルダに入れる・手持ちを一覧にする・更新を確かめる**ためのツールです。

- **アプリ版**（Windows）：インストールして使う。作者さんのサイトからの直接ダウンロード、配布ページの更新チェック、CardWirthの起動ができる。新しい版が出たらアプリの中から更新できる
- **HTML版**：`cw-catalog.html` をChrome・Edgeで開くだけ。インストール不要。WebCardWirth用のzipの書き出しもできる

どちらも中身（画面と処理）は同じです。

## できること

| | アプリ版 | HTML版 |
|---|---|---|
| zip・wsn・展開済みフォルダの中身を分析（形式・版・暗号化・りどみ） | ◯ | ◯ |
| 文字化けしたファイル名を正しく読み直す（UTF-8／Shift_JIS 自動判定） | ◯ | ◯ |
| りどみを表示してから、エンジンのScenarioフォルダへインストール | ◯ | ◯（Chrome・Edge） |
| 同じものがあればバックアップしてから置き換え | ◯ | ◯ |
| 手持ちの一覧・バージョンのタグ付け・タグ・メモ | ◯ | ◯ |
| カタログの読み込み・更新チェック | ◯ | ◯ |
| 作者さんのサイトからの直接ダウンロード | ◯ | △（ブラウザの制限で取れないことが多い） |
| URLから取ってくる（配布ページの中のダウンロードリンクを探す） | ◯ | △（読み込みを許可しているサイトだけ） |
| 同意ページ（斧アップローダーなど）で、本人が同意してからダウンロード | ◯ | △（同上） |
| アプリ内ブラウザで配布ページを開き、サイトのボタンを押したファイルをそのまま受け取る | ◯ | × |
| サイトに貼る「CWカタログで入れる」リンク（押すと確認してから取り込む） | ◯ | ◯ |
| カタログ外の作品（ブックマーク）の配布ページの変化チェック | ◯ | × |
| CardWirthの起動 | ◯ | × |
| WebCardWirth用のzipの書き出し | ◯ | ◯ |
| アプリ自体の自動更新 | ◯ | （Pages版は開くたびに最新） |

**まだできないこと**：lzh・cabの展開、Next→Pyの変換（自己責任での変換機能として追加予定）、スキン・素材のインストール。

## 安全のために

- 書き込むのは、登録したエンジンの `Scenario` と `CWCatalog_backup` フォルダだけです。宿（Yado）には触りません
- zipの中のファイルを実行することはありません
- zipの `../` などの危険なパス、異常なサイズ・圧縮率、壊れたファイル（CRC不一致）は止めます
- りどみやカタログの文字は、HTMLとして解釈せず文字として表示します
- ネットにつなぐのは、ボタンを押したときだけです
- 同意ページは、ページの文章を見せて、本人が「同意します」にチェックしてからでないと送信しません
- アプリ内ブラウザの窓は外部のページなので、アプリの機能（ファイル操作など）には一切触れられない設定です
- HTML版は、ファイルに埋め込んだスクリプト以外を実行しない設定（CSP）になっています
- アプリ版は、ユーザーがダイアログで選んだフォルダにしか触れません（Tauriの権限設定）
- 部品は最小限にし、版を固定しています（出てから2週間以上たった版のみ。インストール時のスクリプトは無効）

## データ形式

カタログと、ツールの記録の形式は公開しています：[docs/データ形式.md](docs/データ形式.md)

---

## 開発

```bash
npm ci            # 部品を入れる（.npmrc でインストール時スクリプトは無効）
npm test          # 中核処理の試験
npm run build     # dist/web/cw-catalog.html（HTML版）と dist/app/（アプリ版の画面）を作る
npx tauri dev     # アプリ版を開発モードで起動（Rustが必要）
```

実物の作品ファイルを使う試験は、作者さんの作品をリポジトリに入れないために、手元のフォルダを指定したときだけ動きます：

```bash
CW_FIXTURES=/path/to/fixtures npm test
CW_FIXTURES=/path/to/fixtures node test/e2e.mjs ./shots   # ブラウザでHTML版を動かす試験
```

### フォルダ構成

| 場所 | 中身 |
|---|---|
| `src/core/` | 中核処理（zip・文字コード・判定・インストール・カタログ）。HTML版・アプリ版で共通 |
| `src/app/` | 画面 |
| `src/platform/browser.js` | HTML版の入れ物（ブラウザのフォルダ書き込み機能） |
| `src/platform/tauri.js` | アプリ版の入れ物（Tauriのプラグイン） |
| `src-tauri/` | アプリ版の設定（Rustはプラグインの登録だけ） |
| `docs/データ形式.md` | 公開している仕様 |

## 初めてのリリースの前に

アプリの自動更新には、**更新用の署名鍵**（無料・自分で作る）が要ります。Windowsのコード署名証明書とは別物です。

1. 鍵を作る：`npx tauri signer generate -w ~/.tauri/cwcatalog.key`
2. 表示された**公開鍵**を `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に貼る
3. 同じファイルの `endpoints` の `OWNER/cw-catalog-tool` を、自分のリポジトリに書き換える
4. GitHubのリポジトリの Settings → Secrets and variables → Actions に登録：
   - `TAURI_SIGNING_PRIVATE_KEY`：秘密鍵ファイルの中身
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：鍵を作ったときのパスワード
5. 秘密鍵はなくさないように保管する（なくすと、それまでのアプリに更新を届けられなくなる）

## リリースのしかた

1. `package.json` の `version` を上げる（例：`0.2.0`）
2. `v0.2.0` というタグを付けて push する
3. GitHub Actions がアプリ版とHTML版を作り、**下書き**のリリースに置く
4. 中身を確認して、GitHubの画面で「公開」する → アプリ版を使っている人に更新のお知らせが届く

HTML版は、`main` に入るたびに GitHub Pages にも自動で置かれます（`https://<アカウント>.github.io/cw-catalog-tool/cw-catalog.html`）。

## おすすめの設定（GitHub）

- Settings → Code security：Dependabot alerts と CodeQL（Default setup）を有効にする
- Settings → Pages：Source を「GitHub Actions」にする

## ライセンス

MIT。使っている部品：fflate（MIT）、Tauri とそのプラグイン（MIT／Apache-2.0）。
