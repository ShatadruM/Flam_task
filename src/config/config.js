const KNOWN_KEYS = {
  'max-retries': { validate: isPositiveInteger, description: 'default max_retries for new jobs' },
  'backoff-base': { validate: isPositiveInteger, description: 'base for delay = base^attempts' },
};

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

export async function getConfig(db, key, defaultValue) {
  const row = await db.get('SELECT value FROM config WHERE key = ?', key);
  return row ? row.value : defaultValue;
}

export async function setConfig(db, key, value) {
  if (!(key in KNOWN_KEYS)) {
    throw new Error(`Unknown config key "${key}". Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}`);
  }
  if (!KNOWN_KEYS[key].validate(value)) {
    throw new Error(`Invalid value "${value}" for "${key}" — must be a positive integer`);
  }

  await db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, String(value)
  );
}