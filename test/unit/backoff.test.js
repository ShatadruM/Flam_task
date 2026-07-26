import { describe, it, expect } from 'vitest';
import { computeBackoffDelaySeconds } from '../../src/lib/backoff.js';

describe('computeBackoffDelaySeconds', () => {
  it('matches the documented sequence for base=2: 2s, 4s, 8s', () => {
    expect(computeBackoffDelaySeconds(2, 1)).toBe(2);
    expect(computeBackoffDelaySeconds(2, 2)).toBe(4);
    expect(computeBackoffDelaySeconds(2, 3)).toBe(8);
  });

  it('handles a different base', () => {
    expect(computeBackoffDelaySeconds(3, 2)).toBe(9);
  });
});