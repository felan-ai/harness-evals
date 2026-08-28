import { isAbsolute, relative, resolve } from 'node:path';

/** Validate an object key before it reaches a filesystem or object store. */
export function validatePublicObjectKey(key: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof key !== 'string' || key.includes('\\') || key.includes('\0')) {
    throw new Error('Public result keys must use safe relative POSIX paths');
  }
  if (key === '') {
    if (options.allowEmpty) return key;
    throw new Error('Public result key must not be empty');
  }
  if (isAbsolute(key) || key.startsWith('/')) {
    throw new Error(`Unsafe public result key: ${key}`);
  }
  const segments = key.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe public result key: ${key}`);
  }
  return key;
}

export function resolvePublicObjectPath(root: string, key: string): string {
  validatePublicObjectKey(key);
  const rootPath = resolve(root);
  const destination = resolve(rootPath, ...key.split('/'));
  const outside = relative(rootPath, destination);
  if (outside === '..' || outside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(outside)) {
    throw new Error(`Public result key resolves outside its root: ${key}`);
  }
  return destination;
}
