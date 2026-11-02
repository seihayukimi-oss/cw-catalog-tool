import { platform } from './platform/tauri.js';
import { FsaDirFromHandle } from './platform/fsa.js';
import { startApp } from './app/app.js';

// アプリの画面にフォルダをドロップしたときも、ブラウザ部品（WebView2）の機能で読める
platform.FsaDirFromHandle = FsaDirFromHandle;
startApp(platform);
