import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Install } from '../locate.js';
import { sameSkillDir, settleSkillDirs, skillDirsInUse, type SkillDirRelease, type SkillDirs } from '../resources/skill-dirs.js';
import type { Host } from '../tool-home.js';
import { TeamaiConfigSchema } from '../types.js';

type Case = {
  readonly name: string;
  readonly previous: SkillDirs | undefined;
  readonly previousFormer?: SkillDirs;
  readonly current: SkillDirs;
  readonly incomplete?: readonly string[];
  readonly followSession?: readonly string[];
  readonly inUse?: readonly string[];
  readonly record: SkillDirs;
  readonly former?: SkillDirs;
  readonly release: readonly SkillDirRelease[];
};

const CASES: readonly Case[] = [
  {
    name: 'releases nothing when no tool moved',
    previous: { hermes: ['/a'] }, current: { hermes: ['/a'] },
    record: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'releases nothing without a previous record',
    previous: undefined, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, release: [],
  },
  {
    name: 'releases the old directory of a tool that moved and took everything',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'keeps both directories on record for a tool that moved and missed something',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'] }, release: [],
  },
  {
    name: 'releases both directories a held move kept once the tool takes everything elsewhere',
    previous: { hermes: ['/a', '/b'] }, current: { hermes: ['/c'] },
    record: { hermes: ['/c'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/c' }, { dir: '/b', tool: 'hermes', currentDir: '/c' }],
  },
  {
    name: 'keeps a directory another tool still writes',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/a'] },
    record: { hermes: ['/b'], pi: ['/a'] }, release: [],
  },
  {
    name: 'keeps a shared directory a held tool keeps, when the other tool moves in the same pull',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'], pi: ['/c'] }, release: [],
  },
  {
    name: 'keeps a shared directory a held tool keeps, when the other tool moves in a later pull',
    previous: { hermes: ['/a', '/b'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'], pi: ['/c'] }, release: [],
  },
  {
    name: 'releases a directory two tools moved off once',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] },
    record: { hermes: ['/b'], pi: ['/c'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'keeps a directory a session-following tool writes now, and leaves that tool off the record',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'], openclaw: ['/a'] }, followSession: ['openclaw'],
    record: { hermes: ['/b'] }, release: [],
  },
  {
    name: 'never releases the old directory of a session-following tool',
    previous: { openclaw: ['/a'] }, current: { openclaw: ['/b'] }, followSession: ['openclaw'],
    record: {}, release: [],
  },
  {
    name: 'keeps a tool that takes skills nowhere now as former, and releases nothing of it',
    previous: { hermes: ['/a'] }, current: {},
    record: {}, former: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'keeps as former the directories of a held tool that takes skills nowhere now',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { pi: ['/c'] }, incomplete: ['hermes'],
    record: { pi: ['/c'] }, former: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'keeps a former tool as former while it still takes skills nowhere',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: {},
    record: {}, former: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'releases the former directory of a tool once it takes skills elsewhere',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'records, and releases nothing of, a tool that takes skills from its former directory again',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/a'] },
    record: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'keeps the former directory on record when the tool that takes skills elsewhere missed something',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/b'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'] }, release: [],
  },
  {
    name: 'releases only the directory of a tool with two that moved',
    previous: { codex: ['/home/.codex/skills', '/home/.agents/skills'] }, current: { codex: ['/x/skills', '/home/.agents/skills'] },
    record: { codex: ['/x/skills', '/home/.agents/skills'] }, release: [{ dir: '/home/.codex/skills', tool: 'codex', currentDir: '/x/skills' }],
  },
  {
    name: 'keeps a directory an installed or selected tool reads, though no tool writes it now',
    previous: { hermes: ['/home/.claude/skills'] }, current: { hermes: ['/b'] }, inUse: ['/home/.claude/skills'],
    record: { hermes: ['/b'] }, release: [],
  },
  {
    name: 'keeps the former directory of a tool once it takes skills elsewhere, while another tool reads it',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/b'] }, inUse: ['/a/'],
    record: { hermes: ['/b'] }, release: [],
  },
  {
    name: 'releases only the directories no tool in use reads',
    previous: { hermes: ['/a', '/c'] }, current: { hermes: ['/b'] }, inUse: ['/c'],
    record: { hermes: ['/b'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
];

describe('settleSkillDirs', () => {
  it.each(CASES)('$name', async ({ previous, previousFormer, current, incomplete = [], followSession = [], inUse = [], record, former = {}, release }) => {
    const settled = await settleSkillDirs({
      previous, former: previousFormer, current, incomplete: new Set(incomplete), inUse, followsSession: (tool) => followSession.includes(tool),
    });

    expect(settled).toEqual({ record, former, release });
  });

  it('compares Windows directories in their own flavor', async () => {
    const settled = await settleSkillDirs({
      previous: { hermes: ['C:\\Users\\M\\hermes\\skills'] }, former: undefined, current: { hermes: ['c:\\users\\m\\hermes\\skills\\'] },
      incomplete: new Set(), inUse: [], followsSession: () => false,
    });

    expect(settled.release).toEqual([]);
  });

  it('releases nothing when the tool takes skills from its old directory through a link', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-settle-'));
    try {
      const real = path.join(tmp, 'real'); const link = path.join(tmp, 'link');
      await fse.ensureDir(real); await fse.symlink(real, link, 'junction');

      const settled = await settleSkillDirs({ previous: { hermes: [real] }, former: undefined, current: { hermes: [link] }, incomplete: new Set(), inUse: [], followsSession: () => false });

      expect(settled).toEqual({ record: { hermes: [link] }, former: {}, release: [] });
    } finally {
      await fse.remove(tmp);
    }
  });
});

describe('sameSkillDir', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-same-dir-'));
    await fse.ensureDir(path.join(tmp, 'real'));
    await fse.ensureDir(path.join(tmp, 'other'));
    await fse.symlink(path.join(tmp, 'real'), path.join(tmp, 'link'), 'junction');
  });
  afterAll(async () => { await fse.remove(tmp); });

  it.each([
    { name: 'the same existing path', a: 'real', b: 'real', same: true },
    { name: 'a link and the directory it points to', a: 'link', b: 'real', same: true },
    { name: 'a trailing separator', a: 'real', b: `real${path.sep}`, same: true },
    { name: 'a path that does not exist yet, as written', a: 'missing', b: 'missing', same: true },
    { name: 'a missing path and an existing one', a: 'missing', b: 'real', same: false },
    { name: 'two existing directories', a: 'real', b: 'other', same: false },
  ])('$name: $same', async ({ a, b, same }) => {
    expect(await sameSkillDir(path.join(tmp, a), path.join(tmp, b))).toBe(same);
  });

  it.each([
    { name: 'a Windows path in either case and separator', a: 'C:\\Users\\M\\skills', b: 'c:/users/m/skills/', same: true },
    { name: 'a POSIX path in another case', a: '/Users/M/skills', b: '/users/m/skills', same: false },
  ])('$name: $same', async ({ a, b, same }) => {
    expect(await sameSkillDir(a, b)).toBe(same);
  });
});

describe('skillDirsInUse', () => {
  const { toolPaths } = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' });
  const opencodeDirs = ['/home/m/.config/opencode/skills', '/home/m/.config/opencode/skills', '/home/m/.claude/skills'];
  const host = (installed: boolean): Host => ({
    platform: 'linux', path: path.posix, home: '/home/m', env: {}, toolHomes: { kind: 'missing' }, cwd: () => '/home/m',
    exists: async (file) => installed && file === '/home/m/.config/opencode', readJson: async () => ({ kind: 'missing' }),
  });

  it.each([
    { name: 'installed and selected', installed: true, enabledAgents: ['opencode'], dirs: opencodeDirs },
    { name: 'installed, not selected', installed: true, enabledAgents: ['hermes'], dirs: opencodeDirs },
    { name: 'selected, not installed', installed: false, enabledAgents: ['opencode'], dirs: opencodeDirs },
    { name: 'neither installed nor selected', installed: false, enabledAgents: ['hermes'], dirs: [] },
  ])('counts a tool $name', async ({ installed, enabledAgents, dirs }) => {
    const install: Install = { toolPaths: { opencode: toolPaths.opencode }, agents: { enabledAgents }, toolRoots: {}, scope: 'user' };

    expect(await skillDirsInUse(install, host(installed))).toEqual(dirs);
  });
});
