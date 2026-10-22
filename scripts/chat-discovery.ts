// `pnpm chat-discovery [--seconds 60] [--name Observer] [--speak "hello"]` (§15.3, §16.4): joins the running
// server and logs the raw JSON of every chat/system message plus how our parser reads it. Run this after
// changing the chat plugin or its version to confirm the format the parser expects.

import { loadVersionsConfig, loadWorldConfig, parseProximityLine } from '@agora/shared';
import { connectBody, disconnectBody } from '@agora/agent/body/bot';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const world = loadWorldConfig();
  const versions = loadVersionsConfig();
  const seconds = Number(arg('seconds', '60'));
  const name = arg('name', 'Observer_1');
  const speak = arg('speak', '');
  const bot = await connectBody({ host: world.server.host, port: world.server.port, username: name, version: versions.minecraft.version });
  console.log(`[chat-discovery] ${name} joined ${world.server.host}:${world.server.port}; logging for ${seconds}s`);
  bot.on('message', (json: unknown, position: string) => {
    console.log(`[raw ${position}] ${JSON.stringify(json)}`);
  });
  bot.on('messagestr', (text: string, position: string) => {
    console.log(`[str ${position}] ${JSON.stringify(text)} → ${JSON.stringify(parseProximityLine(text))}`);
  });
  if (speak) setTimeout(() => bot.chat(speak), 2000);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await disconnectBody(bot);
}

main().catch((err: unknown) => {
  console.error(`[chat-discovery] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
