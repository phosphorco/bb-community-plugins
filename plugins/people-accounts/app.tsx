import './app.css';
import { lazy, Suspense } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';

const PeopleAccountsSettings = lazy(() => import('./settings.tsx').then(module => ({ default: module.PeopleAccountsSettings })));

function SettingsSection() {
  return <Suspense fallback={<p role="status">Loading people and token health…</p>}><PeopleAccountsSettings /></Suspense>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'people-accounts-health', title: 'People and token health', component: SettingsSection });
});
