import { describe, it, expect } from 'vitest';
import { createShutdownController } from '../../src/worker/shutdown.js';

describe('createShutdownController', () => {
  it('starts with stopRequested = false', () => {
    expect(createShutdownController().stopRequested).toBe(false);
  });

  it('sets stopRequested = true after requestStop', () => {
    const controller = createShutdownController();
    controller.requestStop();
    expect(controller.stopRequested).toBe(true);
  });

  it('is idempotent — calling requestStop twice is safe', () => {
    const controller = createShutdownController();
    controller.requestStop();
    controller.requestStop();
    expect(controller.stopRequested).toBe(true);
  });
});