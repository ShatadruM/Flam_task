// Tracks whether a graceful shutdown has been requested. Kept as a tiny
// standalone module so it's unit-testable without touching real OS signals.
export function createShutdownController() {
  let stopRequested = false;
  return {
    requestStop() {
      stopRequested = true;
    },
    get stopRequested() {
      return stopRequested;
    },
  };
}