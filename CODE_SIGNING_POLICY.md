# コード署名ポリシー（Code signing policy）

## いまの状態

- いまの CWCatalog.exe には、コード署名をしていません。
- SignPath Foundation（オープンソース向けの無料のコード署名）に申し込みましたが、プロジェクトがもっと広く知られてから申し込み直してほしい、とのことでした（2026年11月）。広く使っていただけるようになったら、申し込み直す予定です。
- 署名がないため、起動するときに Windows の警告が出ることがあります。そのときの対処は、README と配布物の「はじめに.txt」をご覧ください。
- 下の節は、コード署名を始めるときの決まりです。

## 署名するもの

- CWCatalog.exe（アプリ版・Windows）だけです。
- HTML版（cw-catalog.html）は実行ファイルではないため、署名しません。
- 本プロジェクトのリポジトリで作ったファイルにだけ署名します。ほかの方が作ったプログラムには署名しません。

## 作り方

- CWCatalog.exe は、公開しているリポジトリ（<https://github.com/seihayukimi-oss/cw-catalog-tool>）のソースから、GitHub Actions（GitHub が用意する作業用のパソコン）で自動で作ります。
- 手元のパソコンで作ったファイルに署名することはありません。
- 署名は、版を出すたびに、運営者が中身を確かめてから、手で承認します。

## 役割

- 作る人・確かめる人・承認する人：清葉雪見（ひとりで運営しています）
- コードの変更の一部は、制作補助ツール（Claude Code）で作っています。リポジトリに入るのは、運営者が指示し、確かめたものだけです。
- GitHub のアカウントは、2段階認証を使っています。コード署名を始めるときは、署名に使うサービスのアカウントも2段階認証にします。

## プライバシー

本アプリは、個人の情報を集めたり、送ったりしません。利用状況の送信（テレメトリ）もありません。
本アプリがネットにつながるのは、次のときだけです。

- カタログを読み込むとき（共用カタログや、利用者が追加したカタログの URL）
- アプリの更新を確認するとき（GitHub のリリース。起動時の自動確認は設定でオフにできます）
- 利用者が操作して、作品の配布ページ・紹介ページ（作者さんのサイトや SNS の告知など）を開くとき、ファイルをダウンロードするとき、リンクを確かめるとき
- 同意ページの送信や DLキーの入力は、利用者がはっきり「同意する」を選んだとき、キーを入れたときだけ、そのサイトへ送ります

設定・記録は、アプリ版は CWCatalog-data フォルダ、HTML版はブラウザの中だけに保存します。
つながる先のサイトでの情報の扱いは、それぞれのサイトの決まりによります。

---

# Code signing policy (English)

## Current status

- CWCatalog.exe is currently not code-signed.
- We applied to SignPath Foundation (free code signing for open source projects). They asked us to reapply once the project has gained broader recognition (November 2026). We plan to reapply when the project is more widely used.
- Because the app is not signed, Windows may show a warning when you start it. See the README and the "はじめに.txt" file in the download for what to do.
- The sections below describe the rules we will follow once code signing starts.

## What we sign

- Only CWCatalog.exe (the Windows desktop application).
- The HTML version (cw-catalog.html) is not an executable, so it is not signed.
- We sign only files built from this project's own repository. We never sign programs made by others.

## How it is built

- CWCatalog.exe is built automatically by GitHub Actions (GitHub-hosted runners) from the source code in the public repository (<https://github.com/seihayukimi-oss/cw-catalog-tool>).
- We never sign files built on a local computer.
- For every release, the maintainer checks the build and approves each signing manually.

## Team roles

- Author, reviewer and approver: 清葉雪見 (Seiha Yukimi). This is a single-maintainer project.
- Some code changes are written with an AI coding assistant (Claude Code). Only changes that the maintainer requested and reviewed are added to the repository.
- The GitHub account uses multi-factor authentication. When code signing starts, the account of the signing service will use multi-factor authentication as well.

## Privacy

This program does not collect or send any personal information, and it has no telemetry.
It connects to the network only in these cases:

- When it loads a catalog (the shared catalog, or catalog URLs that the user added)
- When it checks for app updates (GitHub Releases; the check at startup can be turned off in the settings)
- When the user opens a distribution page or an introduction page of a work (such as the author's website or a social media post), downloads a file, or checks links
- Consent forms are submitted, and download keys are sent, only when the user explicitly agrees or enters the key

Settings and records are stored only in the CWCatalog-data folder (app) or inside the browser (HTML version).
How connected external sites handle information is subject to each site's own policies.
