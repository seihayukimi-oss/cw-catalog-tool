import { platform, opfsFolder } from './platform/browser.js';
import { startApp } from './app/app.js';

platform.opfsFolder = opfsFolder; // テスト用（#dev-opfs のときだけ画面に出る）
startApp(platform);
