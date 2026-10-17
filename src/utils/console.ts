export async function withWarningsTo<T>(
  sink: (message: string) => void,
  run: () => Promise<T>,
): Promise<T> {
  const original = console.warn;
  console.warn = (...args: unknown[]) => sink(args.map(String).join(" "));
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}
