import assert from 'node:assert/strict';
import { installTestPluginRuntime, loadPluginApp } from '@get-bb/plugin-sdk/testing/app';
installTestPluginRuntime();
const {definePluginApp, useSdk, experimental_Icon} = await import('@get-bb/plugin-sdk/app');
assert.equal(typeof useSdk, 'function');
assert.equal(typeof experimental_Icon, 'function');
const captured = await loadPluginApp(definePluginApp(app => {
  app.slots.sidebarFooterAction({id:'probe', title:'Probe', icon:'Zap', run(){}});
  app.slots.experimental_appOverlay({id:'probe-overlay', component:() => null});
}));
assert.equal(captured.appOverlays.length, 1);
assert.equal(captured.sidebarFooterActions.length, 1);
assert.equal(captured.appOverlays[0].id, 'probe-overlay');
console.log('published SDK 0.5.29 test runtime and slot capture: PASS');
