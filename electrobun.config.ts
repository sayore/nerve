import { type ElectrobunConfig } from "electrobun";

const config: ElectrobunConfig = {
  app: {
    name: "Nerve",
    identifier: "de.sayore.nerve",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/ui/index.html",
      },
    },
  },
};

export default config;
