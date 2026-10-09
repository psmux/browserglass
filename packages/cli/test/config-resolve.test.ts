import { describe, expect, it } from 'vitest';
import { envToConfig, flatten, resolveAnnotated } from '../src/config-resolve.js';

describe('envToConfig', () => {
  it('maps BGLS_* env vars into the nested config shape, using __ for nesting', () => {
    const config = envToConfig({
      BGLS_LISTEN: '0.0.0.0:9000',
      BGLS_STORE__URL: 'sqlite:./x.db',
      BGLS_NODE__MAX_INSTANCES: '5',
      UNRELATED: 'ignored',
    });
    expect(config['listen']).toBe('0.0.0.0:9000');
    expect((config['store'] as Record<string, unknown>)['url']).toBe('sqlite:./x.db');
    expect((config['node'] as Record<string, unknown>)['max_instances']).toBe(5);
    expect(config['unrelated']).toBeUndefined();
  });
});

describe('flatten', () => {
  it('flattens nested objects into dot paths, leaving arrays as leaves', () => {
    const flat = flatten({ a: { b: 1, c: { d: 2 } }, e: [1, 2, 3] });
    expect(flat.get('a.b')).toBe(1);
    expect(flat.get('a.c.d')).toBe(2);
    expect(flat.get('e')).toEqual([1, 2, 3]);
  });
});

describe('resolveAnnotated', () => {
  it('resolves later layers winning per key, and names the winning layer', () => {
    const report = resolveAnnotated(
      {
        default: { listen: '127.0.0.1:7443', node: { maxInstances: 20 } },
        'config file': { listen: '127.0.0.1:8000' },
        environment: {},
        'cli flag': { node: { maxInstances: 5 } },
      },
      '/tmp/bgls.config.ts',
    );
    const byPath = new Map(report.values.map((v) => [v.path, v]));
    expect(byPath.get('listen')?.value).toBe('127.0.0.1:8000');
    expect(byPath.get('listen')?.layer).toBe('config file');
    expect(byPath.get('node.maxInstances')?.value).toBe(5);
    expect(byPath.get('node.maxInstances')?.layer).toBe('cli flag');
    expect(report.configFilePath).toBe('/tmp/bgls.config.ts');
  });
});
