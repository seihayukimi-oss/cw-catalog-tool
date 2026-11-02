import { platform, opfsFolder, devFetchRange, devCheckLink } from './platform/browser.js';
import { startApp } from './app/app.js';

platform.opfsFolder = opfsFolder; // テスト用（#dev-opfs のときだけ画面に出る）
if (typeof location !== 'undefined' && location.hash.includes('dev-opfs')) {
  platform.fetchRange = devFetchRange;
  platform.checkLink = devCheckLink;
}
startApp(platform);
