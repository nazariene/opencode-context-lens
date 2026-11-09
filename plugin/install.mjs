// Stage a standalone package before publishing its stable path and JSONC registration.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
let staged, release, temporaryConfig, temporaryLink, current, previousLink, published = false, configured = false;
try {
  if (process.argv.length !== 3) throw new Error('Expected the target OpenCode config file. Use install.sh.');
  let config = resolve(process.argv[2]);
  mkdirSync(dirname(config), { recursive: true });
  config = existsSync(config) ? realpathSync(config) : join(realpathSync(dirname(config)), basename(config));
  const original = existsSync(config) ? readFileSync(config, 'utf8') : null;
  const home = join(dirname(config), 'context-lens'), releases = join(home, 'releases');
  current = join(home, 'current');
  if (existsSync(current) || (() => { try { return lstatSync(current).isSymbolicLink(); } catch { return false; } })()) {
    if (!lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to replace an unmanaged directory: ${current}`);
    previousLink = readlinkSync(current);
    if (!resolve(home, previousLink).startsWith(releases + '/')) throw new Error(`Unrecognized installation link: ${current}`);
  }
  mkdirSync(releases, { recursive: true });
  staged = mkdtempSync(join(releases, '.stage-'));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'check-gui.mjs', 'src']) cpSync(join(source, name), join(staged, name), { recursive: true });
  const npm = (...args) => {
    const result = spawnSync('npm', [...args, '--no-audit', '--no-fund'], { cwd: staged, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`npm ${args.join(' ')} failed; previous installation is unchanged.`);
  };
  npm('ci', '--include=dev');
  const { parse, modify, applyEdits } = createRequire(join(staged, 'package.json'))('jsonc-parser');
  const errors = [], settings = parse(original ?? '{}', errors, { allowTrailingComma: true });
  if (errors.length || !settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('OpenCode configuration must be a valid JSON/JSONC object.');
  if (settings.plugins !== undefined && !Array.isArray(settings.plugins)) throw new Error('OpenCode plugins must be an array.');
  const packageName = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name;
  const matches = (entry) => {
    const spec = typeof entry === 'string' ? entry : entry?.package;
    if (typeof spec !== 'string') throw new Error('Invalid plugin entry in OpenCode configuration.');
    if (['context-lens', '-context-lens', packageName].includes(spec) || spec.startsWith(packageName + '@')) return true;
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file:')) return false;
    const path = spec.startsWith('file:') ? fileURLToPath(spec) : isAbsolute(spec) ? spec : resolve(dirname(config), spec);
    return [source, current, join(source, 'dist/index.js')].some((target) => path === target || existsSync(path) && existsSync(target) && realpathSync(path) === realpathSync(target));
  };
  const plugins = settings.plugins ?? [], indices = plugins.flatMap((entry, index) => matches(entry) ? [index] : []);
  let options = {};
  for (const index of indices) {
    const value = plugins[index]?.options;
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Context Lens options must be an object.');
    options = { ...options, ...value };
  }
  let updated = original ?? '{}\n';
  const edit = (path, value) => {
    if (JSON.stringify(path.reduce((entry, key) => entry?.[key], parse(updated))) === JSON.stringify(value)) return;
    updated = applyEdits(updated, modify(updated, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: updated.includes('\r\n') ? '\r\n' : '\n' } }));
  };
  if (settings.$schema === undefined) edit(['$schema'], 'https://opencode.ai/config.json');
  const entry = { package: current, options: { ...options, manualPruning: true } };
  if (indices.length) {
    const first = indices[0];
    if (typeof plugins[first] === 'string') edit(['plugins', first], entry);
    else {
      edit(['plugins', first, 'package'], current);
      for (const [key, value] of Object.entries(entry.options)) edit(['plugins', first, 'options', key], value);
    }
    for (const index of indices.slice(1).reverse()) edit(['plugins', index], undefined);
  } else if (settings.plugins === undefined) edit(['plugins'], [entry]);
  else edit(['plugins', -1], entry);
  npm('run', 'build');
  npm('prune', '--omit=dev');
  for (const name of ['src', 'tsconfig.json', 'vite.config.ts', 'dist/test', 'dist/gui.jsx', 'dist/gui.d.ts']) rmSync(join(staged, name), { recursive: true, force: true });
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', "const server=(await import('./dist/index.js')).default, tui=(await import('./dist/tui.js')).default; if(server.id!=='context-lens'||tui.id!=='context-lens.tui') throw Error('Invalid plugin exports'); await (await import('./check-gui.mjs')).loadGUI()"], { cwd: staged, stdio: 'inherit' });
  if (smoke.error || smoke.status !== 0) throw new Error('Installed plugin entry points failed to load.');
  if ((existsSync(config) ? readFileSync(config, 'utf8') : null) !== original) throw new Error('OpenCode configuration changed during the build. Rerun the installer.');
  const id = randomUUID();
  if (updated !== original) {
    temporaryConfig = `${config}.lens-${id}`;
    writeFileSync(temporaryConfig, updated, { mode: original === null ? 0o600 : statSync(config).mode & 0o777, flag: 'wx' });
    if (original !== null) writeFileSync(`${config}.lens-backup-${id}`, original, { mode: 0o600, flag: 'wx' });
  }
  release = join(releases, `release-${id}`);
  renameSync(staged, release); staged = undefined;
  temporaryLink = join(home, `.current-${id}`);
  symlinkSync(`releases/release-${id}`, temporaryLink);
  renameSync(temporaryLink, current); temporaryLink = undefined; published = true;
  if (temporaryConfig) { renameSync(temporaryConfig, config); temporaryConfig = undefined; }
  configured = true;
  console.log(`Installed Context Lens: ${current}\nConfig: ${config}\nManual pruning enabled; auto-compaction settings preserved.\nRun /lens-prune help in Terminal or Desktop. Desktop: Settings > Extensions > Plugins, then Open Context Lens in the palette.\nOpenCode watches configuration and local GUI bundles; the installer does not restart the service.`);
} catch (error) {
  if (published && !configured) {
    if (previousLink !== undefined) {
      const rollback = `${current}.rollback-${randomUUID()}`;
      symlinkSync(previousLink, rollback); renameSync(rollback, current);
    } else rmSync(current, { force: true });
  }
  console.error(`install.sh: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  for (const path of [staged, temporaryConfig, temporaryLink, !configured && release]) if (path) rmSync(path, { recursive: true, force: true });
}
