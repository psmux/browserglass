export default {
  id: 'bgls-plugin-fixture',
  kind: 'frame-encoder',
  hostApi: '1.x',
  platforms: ['darwin', 'linux', 'win32'],
  summary: 'A fixture plugin used only by packages/cli/test/plugins/fetch.test.ts.',
  probe: async () => ({ usable: true, detail: 'fixture' }),
};
