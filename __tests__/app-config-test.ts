describe('app config', () => {
  const originalPluginUrl = process.env.AC2OPEN_CLAW_PLUGIN_URL;

  afterEach(() => {
    if (originalPluginUrl === undefined) delete process.env.AC2OPEN_CLAW_PLUGIN_URL;
    else process.env.AC2OPEN_CLAW_PLUGIN_URL = originalPluginUrl;
    jest.resetModules();
  });

  it('links the OpenClaw integration to the AC2 Protocol site by default', () => {
    delete process.env.AC2OPEN_CLAW_PLUGIN_URL;

    const config = require('../app.config.js');

    expect(config.expo.extra.ac2OpenClawPluginUrl).toBe('https://ac2protocol.org/');
  });
});
