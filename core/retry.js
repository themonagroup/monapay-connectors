const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retry(operation, {
  attempts = 3,
  delayMs = 250,
  sleep = defaultSleep,
  onRetry = () => {},
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('attempts phải là số nguyên dương');

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await onRetry(error, attempt);
      await sleep(delayMs * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
