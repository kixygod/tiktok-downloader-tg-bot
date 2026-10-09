import { describe, it, expect } from 'vitest';
import { runProcess } from '../process';
import { failureDecision, redact, canonicalMediaUrl } from '../reliability';

describe('external processes', () => {
  it('drains stdout and bounds captured output', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(200000)); process.stderr.write('e'.repeat(200000))"], { timeoutMs: 2000 });
    expect(result.stdout.length).toBeLessThanOrEqual(16384);
    expect(result.stderr.length).toBeLessThanOrEqual(16384);
  });
  it('rejects missing executables without crashing the worker', async () => {
    await expect(runProcess('/nonexistent/tiktok-tool', [], { timeoutMs: 1000 })).rejects.toThrow();
  });
  it('kills hung processes', async () => {
    await expect(runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 100 })).rejects.toThrow(/timeout/);
  });
  it('reports nonzero exits', async () => {
    await expect(runProcess(process.execPath, ['-e', "process.stderr.write('HTTP 403');process.exit(1)"])).rejects.toThrow(/HTTP 403/);
  });
});
describe('retry decisions', () => {
  it('keeps transient failures pending until final attempt', () => {
    expect(failureDecision(new Error('HTTP 503'), 1, 3).terminal).toBe(false);
    expect(failureDecision(new Error('HTTP 503'), 2, 3).terminal).toBe(false);
    expect(failureDecision(new Error('HTTP 503'), 3, 3).terminal).toBe(true);
  });
  it('stops repeating login restrictions and explains them', () => {
    const result = failureDecision(new Error('TikTok: Log in for access'), 1, 3);
    expect(result.terminal).toBe(true);
    expect(result.message).toContain('авторизац');
  });
  it('retries failed public fallbacks even when yt-dlp requests login', () => {
    const error = new Error('TikTok: Log in for access | fallback: All download methods failed: SSSTik: no media returned');
    expect(failureDecision(error, 1, 3).terminal).toBe(false);
    const final = failureDecision(error, 3, 3);
    expect(final.terminal).toBe(true);
    expect(final.message).not.toContain('авторизац');
  });
  it('removes tracking parameters from canonical cache keys', () => {
    expect(canonicalMediaUrl('https://www.tiktok.com/@u/video/123?_t=one&_r=1')).toBe('https://www.tiktok.com/@u/video/123');
    expect(canonicalMediaUrl('https://example.com/file?signature=123')).toContain('signature=123');
  });
  it('redacts tokens and proxy credentials', () => {
    expect(redact('https://api.telegram.org/bot123456789:ABCabc_def/getMe http://user:pass@proxy:80')).not.toContain('ABCabc_def');
    expect(redact('http://user:pass@proxy:80')).not.toContain('pass');
    expect(redact('-1003615875017:17813:0')).toBe('-1003615875017:17813:0');
  });
});
