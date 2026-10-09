import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsOutbox, Journal } from '../journal';
const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'tiktok-journal-')); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, {recursive: true, force:true})));
describe('persistent journal', () => {
 it('redacts and rotates logs', () => {
  const dir=temp(); const journal=new Journal(dir, 100);
  for(let i=0;i<5;i++) journal.write('failed', {error:'http://user:pass@proxy:80', padding:'x'.repeat(50)});
  expect(readdirSync(dir).length).toBeLessThanOrEqual(4);
  expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).not.toContain('pass');
 });
 it('replays stats after restart and retains failures', async () => {
  const dir=temp(); const outbox=new StatsOutbox(dir, async () => {throw new Error('offline');});
  await outbox.record({status:'success', bytes:42});
  expect(readdirSync(dir)).toHaveLength(1);
  const delivered: any[]=[];
  const restarted=new StatsOutbox(dir, async payload=> {delivered.push(payload);});
  await restarted.flush();
  expect(delivered[0].event_id).toBeTruthy();
  expect(delivered[0].bytes).toBe(42);
  expect(readdirSync(dir)).toHaveLength(0);
 });
});
