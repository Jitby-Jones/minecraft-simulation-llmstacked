// The controller live (owner request, 2026-10-24: agents stuck in a loop of conversation, the loop broken by making
// them move, as of their own will). Ada and Bram stand together and Ada keeps saying the same thing to Bram, in real
// chat. The controller (code alone here: tests/hub/controller.test.ts has the model's side) reads their telemetry,
// sees the talk going round in circles and pushes Ada along; she takes it as her own: a goodbye, the talk ended,
// Bram let be, and a walk away from him. Nothing on her mind speaks of a controller.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonaSchema, WorldConfigSchema, createLogger, loadVersionsConfig, nullLogger, sleep } from '@agora/shared';
import { Agent } from '@agora/agent';
import { Body } from '@agora/agent/body/body';
import { startTelemetry } from '@agora/agent/hub/telemetry';
import { Controller } from '@agora/hub';
import { DEEP_GROUND_Y, type LiveServer, liveJavaPath, startLiveServer, waitFor } from './harness';

const versions = loadVersionsConfig();
const Y = DEEP_GROUND_Y;

describe.skipIf(!liveJavaPath())('live: the controller breaks a talk going round in circles', () => {
  let server: LiveServer;

  beforeAll(async () => {
    server = await startLiveServer({ name: 'controller', port: 25620, rconPort: 25621, deepGround: true });
    for (const c of ['gamerule advance_time false', 'gamerule advance_weather false', 'weather clear', 'difficulty peaceful', 'time set 1000']) await server.cmd(c);
  }, 300_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('the one repeating herself says goodbye, ends the talk and walks off from him, as her own idea', async () => {
    const x = 3000;
    await server.cmd(`forceload add ${x - 48} -48 ${x + 48} 48`);
    const logger = createLogger({ name: 'controller-live', console: process.env.AGORA_DEBUG === '1' });
    const mk = async (name: string, at: number) => {
      const body = await Body.connect({ host: server.host, port: server.port, username: name, version: versions.minecraft.version, logger });
      await server.cmd(`tp ${name} ${at} ${Y} 0`);
      return body;
    };
    const adaBody = await mk('Ada', x);
    const bramBody = await mk('Bram', x + 2);
    await sleep(2000);
    const agent = (body: Body, name: string, sex: 'female' | 'male') =>
      new Agent({ body, persona: PersonaSchema.parse({ name, sex, traits: ['chatty'], social: { initiateChance: 0, maxTurns: 20 } }), username: name, llm: null, logger, world: WorldConfigSchema.parse({}), goalGen: false, socialGoals: false });
    const ada = agent(adaBody, 'Ada', 'female');
    const bram = agent(bramBody, 'Bram', 'male');
    const agents: Record<string, Agent> = { Ada: ada, Bram: bram };
    const controller = new Controller({
      llm: null,
      logger: nullLogger(),
      config: { enabled: true, everySec: 600, maxPerHour: 20 },
      send: (who, urge) => {
        const a = agents[who];
        if (!a) return false;
        void a.urge(urge);
        return true;
      },
    });
    const heardByBram: string[] = [];
    bramBody.bot.on('messagestr', (m: string) => void heardByBram.push(m));
    ada.start();
    bram.start();
    const stops = [ada, bram].map((a) => startTelemetry({ agent: a, bot: a === ada ? adaBody.bot : bramBody.bot, send: (kind, data) => controller.observe(a.name, kind, data), stateEveryMs: 2000 }));
    try {
      // Ada goes round in circles at Bram: the same thing said over in other words (the talk's own check ends one
      // that says a line again word for word; this one it doesn't).
      for (const line of ['bram we should build a house', 'i really think a house is what we should build', 'a house, we should totally build one', 'so building a house is the plan right', 'we gotta build that house bram', 'so yeah, a house we should build']) {
        await ada.talking.blurt('Bram', line);
        await sleep(2500);
      }
      expect(ada.conversations.withPartner('Bram')).toBeDefined();
      const steps = await controller.sweep();
      expect(steps.map((s) => [s.kind, s.agents[0], s.by])).toContainEqual(['repeating', 'Ada', 'code']);
      // Her own idea: a goodbye, the talk over, the thought on her mind.
      await waitFor(() => ada.conversations.active().length === 0, 15_000, 'the talk ended', 250);
      expect(Object.values(ada.store.state.conversations).some((c) => c.participants.includes('Bram') && c.endedReason === 'moved on')).toBe(true);
      await waitFor(() => heardByBram.some((m) => /gonna go get stuff done/.test(m)), 10_000, 'Bram heard the goodbye', 250);
      expect(ada.store.state.workmem.some((w) => /I've said my piece, time to get on with something/.test(w.text))).toBe(true);
      expect(ada.store.state.workmem.some((w) => /controller|nudge|pushed/i.test(w.text))).toBe(false);
      // And she walks off from him.
      await waitFor(() => adaBody.bot.entity.position.distanceTo(bramBody.bot.entity.position) > 8, 45_000, 'Ada walked off', 500);
      expect(ada.conversations.mayInitiate('Bram')).toBe(false);
    } finally {
      for (const s of stops) s();
      await ada.stop();
      await bram.stop();
      await adaBody.disconnect();
      await bramBody.disconnect();
    }
  }, 300_000);
});
