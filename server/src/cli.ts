import { stderr, stdout } from 'node:process';

import { perceiveScreenshot } from './agent/perceive.ts';
import { proposeCards } from './agent/propose.ts';

function parseExtractArgs(args: string[]): { imagePath: string; note?: string } {
  if (args.length === 0) {
    throw new Error('Usage: extract <image> [--note text]');
  }

  const [imagePath, ...rest] = args;
  let note: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === '--note') {
      const next = rest[index + 1];

      if (!next) {
        throw new Error('Missing value for --note');
      }

      note = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return { imagePath, note };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  if (command !== 'extract') {
    throw new Error('Usage: extract <image> [--note text]');
  }

  const { imagePath, note } = parseExtractArgs(rest);
  const extraction = await perceiveScreenshot({ imagePath, note });
  const cards = proposeCards(extraction);
  stdout.write(`${JSON.stringify(cards, null, 2)}\n`);
}

const isMainModule = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
