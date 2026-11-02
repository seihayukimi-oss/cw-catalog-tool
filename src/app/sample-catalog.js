// お試し用のサンプルカタログ（実在の作品ではありません）
export const SAMPLE_CATALOG = {
  format: 1,
  engines: [],
  attribution: { name: 'CWカタログのサンプル' },
  authors: {
    'example-author': { owner: 'example-author', names: ['見本作者'], readme_url: '' },
  },
  entries: [
    {
      id: 'e00001', owner: 'example-author', type: 'scenario', name: 'サンプルの森', author: '見本作者',
      version: '1.10', updated: '2026-11-01', format: 'classic', wsn_version: null,
      compat: { cw150: 'verified', next: 'verified', py: 'expected' }, convert: 'self',
      downloads: [
        { label: 'GitHub Releases', url: 'https://github.com/example-author/sample-forest/releases/download/v1.10/sample_forest_v1.10.zip', kind: 'direct', status: 'active' },
        { label: '作者サイト', url: 'https://example.com/cw/dl.html', kind: 'page', status: 'mirror', note: 'DLキーはReadme参照' },
        { label: 'uploader.jp（移転前）', url: 'https://ux.getuploader.com/example/download/1', kind: 'page', status: 'closed', until: '2026-11-25' },
      ],
      file: { name: 'sample_forest_v1.10.zip' }, readme: 'りどみ.txt', level: { min: 1, max: 3 },
      tags: ['探索', '短編'], description: 'これは書式見本のデータです。実在の作品ではありません。', requires: [], related: [],
    },
    {
      id: 'e00002', owner: 'example-author', type: 'scenario', name: 'サンプルの塔（Py版）', author: '見本作者',
      version: '2.0', updated: '2026-10-01', format: 'wsn', wsn_version: 5,
      compat: { cw150: 'no', next: 'no', py: 'verified' }, convert: 'forbidden',
      downloads: [{ label: '作者サイト', url: 'https://example.com/cw/tower.html', kind: 'page', status: 'active' }],
      file: {}, tags: ['戦闘'], description: 'Py専用の見本データです。', requires: [], related: ['e00001'],
      rating: 'r15', content: ['gore'],
    },
    {
      id: 'e00003', owner: '', type: 'scenario', name: 'サンプルの洞窟（一時保留中の見本）', author: '別の見本作者',
      version: '1.0', updated: '2026-09-01', format: 'classic', wsn_version: null,
      compat: { cw150: 'expected', next: 'expected', py: 'expected' }, convert: 'self',
      downloads: [{ label: '配布ページ', url: 'https://example.com/cw/cave.html', kind: 'page', status: 'active' }],
      file: {}, tags: [], description: '「一時保留中の作品」の見本データです。実在の作品ではありません。', requires: [], related: [],
      state: 'held', held_reason: '見本：通報が多かったため', checked: 'other', derivative: { of: 'サンプルの森', basis: '見本のため、ありません' },
    },
    {
      id: 'e00004', owner: '', type: 'scenario', name: 'サンプルの館（R18の見本）', author: '別の見本作者',
      version: '1.0', updated: '2026-09-15', format: 'classic', wsn_version: null,
      compat: { cw150: 'expected', next: 'expected', py: 'expected' }, convert: 'self',
      downloads: [{ label: '配布ページ', url: 'https://example.com/cw/house.html', kind: 'page', status: 'active' }],
      intro: [{ url: 'https://example.com/cw/house-intro.html', label: '紹介' }],
      file: {}, tags: [], description: '「R18」の見本データです。実在の作品ではありません。', requires: [], related: [],
      rating: 'r18',
    },
  ],
};
