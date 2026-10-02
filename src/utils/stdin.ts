/** Read all of stdin and parse it as JSON. */
import { LEADING_BYTE_ORDER_MARKS } from "../constants.js";

export function readStdin<T>(stream: NodeJS.ReadableStream = process.stdin): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => {
      try {
        resolve(JSON.parse(data.replace(LEADING_BYTE_ORDER_MARKS, "")));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    stream.on("error", reject);
  });
}
