import { STDIN_DRAIN_TIMEOUT_MS } from "../constants.js";

/** Read all of stdin and parse it as JSON. */
export function readStdin<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

export function drainStdinToAvoidEpipe(timeoutMs = STDIN_DRAIN_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
    process.stdin.resume();
  });
}
