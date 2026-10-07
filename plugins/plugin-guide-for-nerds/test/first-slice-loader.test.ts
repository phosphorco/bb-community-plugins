import { describe, expect, it, vi } from 'vitest';
import { createGuideContentLoader, guideRetryUrl } from '../src/content-loader';
import type { GuideContentModule } from '../src/floating/contract';
const prefix = '/api/v1/plugins/plugin-guide-for-nerds/assets/g/' + 'a'.repeat(32) + '/';
const owner = 'http://localhost' + prefix + 'app.js';
const factory = `() => import("${prefix}chunks/guide-content-ABC.js")`;

describe('failed module recovery', () => {
  it('coalesces cold and retry imports across close/reopen, clearing a settled failure', async () => {
    const content: GuideContentModule = { default: () => null };
    let settleCold!: (module: GuideContentModule) => void;
    const first = vi.fn(() => new Promise<GuideContentModule>(resolve => { settleCold = resolve; }));
    const cold = createGuideContentLoader(first, owner);
    const opened = cold(), reopened = cold();
    expect(reopened).toBe(opened);
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();
    settleCold(content);
    await expect(reopened).resolves.toBe(content);

    const failed = vi.fn<() => Promise<GuideContentModule>>().mockRejectedValue(new Error('503'));
    failed.toString = () => factory;
    let rejectRetry!: (error: Error) => void;
    const fresh = vi.fn<(url: string) => Promise<GuideContentModule>>()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRetry = reject; }))
      .mockResolvedValue(content);
    const load = createGuideContentLoader(failed, owner, fresh);
    await expect(load()).rejects.toThrow('503');
    const retry = load(), retryReopen = load();
    expect(retryReopen).toBe(retry);
    await Promise.resolve();
    expect(fresh).toHaveBeenCalledOnce();
    const rejected = expect(retryReopen).rejects.toThrow('offline');
    rejectRetry(new Error('offline'));
    await rejected;
    await expect(load()).resolves.toBe(content);
    expect(fresh.mock.calls.map(([url]) => new URL(url).search)).toEqual(['?bb-guide-retry=1', '?bb-guide-retry=2']);
  });
  it('adds a unique query to the same plugin generation', () => {
    expect(guideRetryUrl(factory, owner, 2)).toBe('http://localhost' + prefix + 'chunks/guide-content-ABC.js?bb-guide-retry=2');
  });
  it.each([
    '() => Promise.reject()',
    '() => import("https://other.test' + prefix + 'chunks/guide-content-ABC.js")',
    '() => import("' + prefix.replace('for-nerds', 'other') + 'chunks/guide-content-ABC.js")',
    '() => import("' + prefix.replace('a'.repeat(32), 'b'.repeat(32)) + 'chunks/guide-content-ABC.js")',
    factory + '; import("./another.js")',
  ])('rejects unsupported factories: %s', (source) => {
    expect(() => guideRetryUrl(source, owner, 1)).toThrow('Reload BB');
  });
  it('retries distinct URLs, then retains only the successful namespace', async () => {
    const content: GuideContentModule = { default: () => null };
    const first = vi.fn<() => Promise<GuideContentModule>>().mockRejectedValue(new Error('503'));
    first.toString = () => factory;
    const fresh = vi.fn<(url: string) => Promise<GuideContentModule>>()
      .mockRejectedValueOnce(new Error('still offline')).mockResolvedValue(content);
    const load = createGuideContentLoader(first, owner, fresh);
    await expect(load()).rejects.toThrow('503');
    await expect(load()).rejects.toThrow('still offline');
    expect(await load()).toBe(content);
    expect(await load()).toBe(content);
    expect(first).toHaveBeenCalledOnce();
    expect(fresh.mock.calls.map(([url]) => new URL(url).search)).toEqual(['?bb-guide-retry=1', '?bb-guide-retry=2']);
  });
});
