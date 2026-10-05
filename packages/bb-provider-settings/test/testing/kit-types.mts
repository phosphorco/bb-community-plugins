// Compiles consumer-shaped kit usage against the emitted declarations.
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { RoleChoice } from '@phosphorco/bb-provider-settings';
import { createFakeCatalog, createOwnerProbe, crossOwnerScenario, defineScenarios, invocationScenarios, ownerScenarios, withOverride, type InvocationSubject, type RoleSubject } from '@phosphorco/bb-provider-settings/testing';
import { editorScenarios, mountEditor, type EditorSubject } from '@phosphorco/bb-provider-settings/testing/react';
import { RoleSettingsEditor } from '@phosphorco/bb-provider-settings/react';
import { createElement } from 'react';
import test from 'node:test';
const host = createFakePluginHost({ pluginId: 'owner' }), catalog = createFakeCatalog();
const choice: RoleChoice = { kind: 'inherit' };
const subject: RoleSubject = { host, roleId: 'role', acceptedChoice: choice, catalog, readRaw: () => ({}), roleKeys: ['role'], writeExternally: async () => {} };
defineScenarios(test, [...ownerScenarios(subject), crossOwnerScenario([subject, subject])]);
const invocation: InvocationSubject = { baseline: [], setChoice: async () => {}, invoke: async () => {}, requests: () => [], override: { choice, expected: [withOverride({ method: 'm', args: {} }, { model: 'x' })] } };
void invocationScenarios(invocation, { skip: { 'refused-before-dispatch': 'no refusals in this plugin' } });
const probe = createOwnerProbe(host, { catalog });
const role = { id: 'role', label: 'Role', choiceKinds: ['inherit'], providerPolicy: 'any', saveValidation: 'invocation', applies: 'Next', writable: true } as const;
const editor: EditorSubject = { probe, catalog, render: () => createElement(RoleSettingsEditor, { client: probe.client(), role: { ...role, choiceKinds: [...role.choiceKinds] }, catalogSdk: catalog.sdk }), readRaw: () => ({}), writeExternally: async () => {} };
void editorScenarios(editor);
void mountEditor(editor.render(), { probe, settle: false });
