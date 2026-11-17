import './app.css';
import { lazy, Suspense } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';

const PeopleAccountsSettings = lazy(() => import('./settings.tsx').then(module => ({ default: module.PeopleAccountsSettings })));
const PeopleLinksSettings = lazy(() => import('./links-settings.tsx').then(module => ({ default: module.PeopleLinksSettings })));

function SettingsSection() {
  return <Suspense fallback={<p role="status">Loading people and token health…</p>}><PeopleAccountsSettings /></Suspense>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'people-accounts-health', title: 'People and token health', component: SettingsSection });
  app.slots.settingsSection({ id: 'people-account-links', title: 'People account links', component: () => <Suspense fallback={<p role="status">Loading account links…</p>}><PeopleLinksSettings /></Suspense> });
});
