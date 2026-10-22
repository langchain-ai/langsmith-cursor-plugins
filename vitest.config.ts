import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/utils/no-managed-config-setup.ts", "test/utils/no-desktop-setup.ts"],
  },
});
