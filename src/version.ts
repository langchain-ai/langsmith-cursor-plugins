/** Version injected by esbuild so the SEA never needs a runtime package.json. */
declare const __LS_INTEGRATION_VERSION__: string;

export const LS_INTEGRATION_VERSION: string | undefined =
  typeof __LS_INTEGRATION_VERSION__ !== "undefined"
    ? __LS_INTEGRATION_VERSION__
    : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || undefined;
