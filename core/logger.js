const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function serializeError(error) {
  if (!(error instanceof Error)) return String(error);
  return {
    name: error.name,
    message: error.message,
    status: error.status,
  };
}

export function createLogger({ level = process.env.LOG_LEVEL || 'info' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(entryLevel, event, fields = {}) {
    if (LEVELS[entryLevel] < threshold) return;
    const output = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      event,
      ...fields,
    };
    if (output.error) output.error = serializeError(output.error);
    const line = `${JSON.stringify(output)}\n`;
    (entryLevel === 'error' ? process.stderr : process.stdout).write(line);
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
