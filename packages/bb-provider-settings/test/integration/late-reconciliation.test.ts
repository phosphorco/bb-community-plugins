import { test, expect, mock } from 'bun:test';
import React from 'react';
// Controlled public-SDK callback boundary, delegating rendering to SDK testing/app.
// This mounts production controls; it is NOT native picker-effect evidence.
// The real native effect test remains the host/browser slot.
let callback: ((selection: any) => void) | undefined;
const app = await import('@get-bb/plugin-sdk/app');
const NativePicker = app.experimental_ProviderModelPicker;
mock.module('@get-bb/plugin-sdk/app', () => ({
  ...app,
  experimental_ProviderModelPicker(props: any) {
    callback = props.onChange;
    return React.createElement(NativePicker, props);
  },
}));
const { mount } = await import('./mounted-controls.test.mjs');
test('late reconciliation after incidental picker open/focus cannot promote intent or enable Save',async()=>{
  const m=await mount({kind:'fields',fields:{model:'catalog-id'}});
  try {
    await m.click(/^Edit$/i);
    expect(callback).toBeDefined();
    const picker=m.dom.window.document.querySelector('[data-testid="bb-provider-model-picker"]');
    expect(picker).not.toBeNull();
    await React.act(async()=>{
      picker!.dispatchEvent(new m.dom.window.MouseEvent('pointerdown',{bubbles:true}));
      (picker!.querySelector('input') as HTMLElement)?.focus();
    });
    // A delayed callback may come from native reconciliation even after these
    // incidental interactions. The callback has no origin metadata.
    await React.act(async()=>callback!({providerId:'p',model:'exec-model',reasoningLevel:'low'}));
    expect(m.calls.filter(c=>c==='save:b')).toHaveLength(0);
    const save=[...m.dom.window.document.querySelectorAll('button')].find((b:any)=>/^Save$/i.test(b.textContent?.trim()??'')) as HTMLButtonElement|undefined;
    expect(!save || save.disabled).toBe(true);
  } finally {await m.dispose();callback=undefined;}
});
