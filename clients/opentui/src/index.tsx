/**
 * OpenTUI (Solid) client for the prise server.
 */

import { render, useRenderer } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";
import { onMount } from "solid-js";
import { App } from "./ui";

function AppWithSetup() {
  const renderer = useRenderer();

  onMount(() => {
    // Enable kitty keyboard protocol. This improves key disambiguation (Alt, etc.).
    renderer.enableKittyKeyboard(1);
    process.stdout.write("\x1b[>1u");

    // Force flush if available.
    if (process.stdout.isTTY) {
      (process.stdout as any)._handle?.flush?.();
    }
  });

  return <App />;
}

async function main() {
  await render(() => <AppWithSetup />, {
    exitOnCtrlC: false,
    exitSignals: ["SIGTERM", "SIGQUIT", "SIGABRT"],
    useMouse: false,
    enableMouseMovement: false,
    useConsole: true,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      sizePercent: 30,
    },
  });
}

main().catch((err) => {
  console.error("Failed to start prise OpenTUI client:", err);
  process.exit(1);
});
