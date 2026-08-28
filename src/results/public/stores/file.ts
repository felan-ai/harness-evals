import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { PublicResultsObjectOptions, PublicResultsStore } from '../types.js';
import { resolvePublicObjectPath, validatePublicObjectKey } from './keys.js';

/** A local store which only accepts safe relative POSIX object keys. */
export class FilePublicResultsStore implements PublicResultsStore {
  private readonly root: string;
  private rootReady?: Promise<string>;

  public constructor(root: string) {
    if (!root) throw new Error('Public result file store root must not be empty');
    this.root = resolve(root);
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    validatePublicObjectKey(key);
    const root = await this.existingRoot();
    if (!root) return undefined;
    const path = resolvePublicObjectPath(root, key);
    await this.assertInsideRoot(path, root);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) return undefined;
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  public async put(key: string, content: Uint8Array, _options: PublicResultsObjectOptions): Promise<void> {
    const root = await this.ensureRoot();
    const path = resolvePublicObjectPath(root, key);
    await this.assertInsideRoot(dirname(path), root);
    await mkdir(dirname(path), { recursive: true });
    await this.assertInsideRoot(dirname(path), root);
    await rejectSymlink(path);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o644 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  public async list(prefix: string): Promise<string[]> {
    validatePublicObjectKey(prefix, { allowEmpty: true });
    const root = await this.existingRoot();
    if (!root) return [];
    const prefixPath = prefix ? resolvePublicObjectPath(root, prefix) : root;
    try {
      await this.assertInsideRoot(prefixPath, root);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const found: string[] = [];
    await this.walk(root, root, found, prefix);
    found.sort(compareStrings);
    return found;
  }

  private async ensureRoot(): Promise<string> {
    this.rootReady ??= (async () => {
      await mkdir(this.root, { recursive: true });
      return realpath(this.root);
    })();
    return this.rootReady;
  }

  private async existingRoot(): Promise<string | undefined> {
    try {
      return await realpath(this.root);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async assertInsideRoot(path: string, root: string): Promise<void> {
    let actual: string;
    try {
      actual = await realpath(path);
    } catch (error) {
      if (isNotFound(error)) {
        // Check the nearest existing ancestor. This also prevents a symlinked
        // directory from being created underneath the configured root.
        return this.assertInsideRoot(dirname(path), root);
      }
      throw error;
    }
    const fromRoot = relative(root, actual);
    if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Public result path escapes its root: ${path}`);
    }
  }

  private async walk(root: string, directory: string, found: string[], prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to traverse symlink in public result store: ${path}`);
      if (stat.isDirectory()) {
        await this.walk(root, path, found, prefix);
      } else if (stat.isFile()) {
        const key = relative(root, path).split(requirementPlatformSeparator()).join('/');
        if (key === prefix || key.startsWith(`${prefix}/`) || prefix === '') found.push(key);
      }
    }
  }
}

function requirementPlatformSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing to follow symlink in public result store: ${path}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error, 'ENOENT');
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
