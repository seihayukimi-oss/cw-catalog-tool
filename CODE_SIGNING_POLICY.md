コード署名ポリシー（Code signing policy）
==========================================

Free code signing provided by SignPath.io, certificate by SignPath Foundation
（SignPath.io による無料のコード署名。証明書は SignPath Foundation が発行しています）
※SignPath Foundation の審査を申し込み中です。承認されるまで、CWCatalog.exe は署名されていません。

■ 署名するもの
  ・CWCatalog.exe（アプリ版・Windows）だけです。
  ・HTML版（cw-catalog.html）は実行ファイルではないため、署名しません。
  ・本プロジェクトのリポジトリで作ったファイルにだけ署名します。ほかの方が作ったプログラムには署名しません。

■ 作り方
  ・CWCatalog.exe は、公開しているリポジトリ（https://github.com/seihayukimi-oss/cw-catalog-tool）の
    ソースから、GitHub Actions（GitHub が用意する作業用のパソコン）で自動で作ります。
  ・手元のパソコンで作ったファイルに署名することはありません。
  ・署名は、版を出すたびに、運営者が SignPath の画面で中身を確かめてから、手で承認します。

■ 役割
  ・作る人・確かめる人・承認する人：清葉雪見（ひとりで運営しています）
  ・コードの変更の一部は、制作補助ツール（Claude Code）で作っています。リポジトリに入るのは、
    運営者が指示し、確かめたものだけです。
  ・GitHub と SignPath のアカウントは、どちらも2段階認証を使っています。

■ プライバシー
  本アプリは、個人の情報を集めたり、送ったりしません。利用状況の送信（テレメトリ）もありません。
  本アプリがネットにつながるのは、次のときだけです。
  ・カタログを読み込むとき（共用カタログや、利用者が追加したカタログの URL）
  ・アプリの更新を確認するとき（GitHub のリリース。起動時の自動確認は設定でオフにできます）
  ・利用者が操作して、作品の配布ページ・紹介ページを開くとき、ファイルをダウンロードするとき、リンクを確かめるとき
  ・同意ページや DLキーの入力は、利用者が「同意する」やキーの入力をしたときだけ、そのサイトへ送ります
  設定・記録は、アプリ版は CWCatalog-data フォルダ、HTML版はブラウザの中だけに保存します。
  つながる先のサイトでの情報の扱いは、それぞれのサイトの決まりによります。


------------------------------------------------------------------------
Code signing policy (English)
------------------------------------------------------------------------

Free code signing provided by SignPath.io, certificate by SignPath Foundation
* Our application to SignPath Foundation is pending. Until it is approved, CWCatalog.exe is not signed.

What we sign
  - Only CWCatalog.exe (the Windows app).
  - The HTML version (cw-catalog.html) is not an executable, so it is not signed.
  - We sign only files built from this project's own repository. We never sign programs made by others.

How it is built
  - CWCatalog.exe is built automatically by GitHub Actions (GitHub-hosted runners) from the source code
    in the public repository (https://github.com/seihayukimi-oss/cw-catalog-tool).
  - We never sign files built on a local computer.
  - For every release, the maintainer checks the request on SignPath and approves each signing manually.

Team roles
  - Author, reviewer and approver: 清葉雪見 (Seiha Yukimi). This is a single-maintainer project.
  - Some code changes are written with an AI coding assistant (Claude Code). Only changes that the
    maintainer requested and reviewed are added to the repository.
  - Both the GitHub and SignPath accounts use multi-factor authentication.

Privacy
  This program does not collect or send any personal information, and it has no telemetry.
  It connects to the network only in these cases:
  - When it loads a catalog (the shared catalog, or catalog URLs that the user added)
  - When it checks for app updates (GitHub Releases; the check at startup can be turned off in the settings)
  - When the user opens a distribution page or an introduction page of a work, downloads a file, or checks links
  - Consent forms and download keys are sent to a site only when the user agrees or enters the key
  Settings and records are stored only in the CWCatalog-data folder (app) or inside the browser (HTML version).
  How the sites the program connects to handle information depends on each site's own policy.
