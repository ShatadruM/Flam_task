// delay = base ^ attempts, where attempts is the number of completed attempts.
// Pure function — no DB, no I/O — so it's trivial to unit test exhaustively.
export function computeBackoffDelaySeconds(base, attempts) {
  return base ** attempts;
}