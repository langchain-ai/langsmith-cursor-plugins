const LEADING_EXECUTABLE = /^"([^"]*)"|^'([^']*)'|^(\S+)/;

export function commandExecutable(command: string): string {
  const match = LEADING_EXECUTABLE.exec(command.trim());
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}
