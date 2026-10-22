import { describe, expect, it } from 'vitest';
import { parseProximityLine, renderProximityChatConfig, withVolumePrefix } from '@agora/shared';

describe('ProximityChat! line parser (§15.3)', () => {
  it('parses normal, shout and whisper lines (as observed live on 26.1.2)', () => {
    expect(parseProximityLine('Pip » hello there')).toEqual({ kind: 'speech', speaker: 'Pip', text: 'hello there', volume: 'normal' });
    expect(parseProximityLine('[Shout] Bram » come here')).toEqual({ kind: 'speech', speaker: 'Bram', text: 'come here', volume: 'shout' });
    expect(parseProximityLine('(Whisper) Lira » psst')).toEqual({ kind: 'speech', speaker: 'Lira', text: 'psst', volume: 'whisper' });
  });

  it('strips color codes (fade recolors the text)', () => {
    expect(parseProximityLine('§7Pip §8» §x§a§a§a§a§a§ahello')).toEqual({ kind: 'speech', speaker: 'Pip', text: 'hello', volume: 'normal' });
  });

  it('keeps » inside the message', () => {
    const r = parseProximityLine('Pip » a » b');
    expect(r).toEqual({ kind: 'speech', speaker: 'Pip', text: 'a » b', volume: 'normal' });
  });

  it('recognizes spy lines, the no-one-heard notice and other system lines', () => {
    expect(parseProximityLine('[Spy] Bram » far away')).toEqual({ kind: 'spy', speaker: 'Bram', text: 'far away' });
    expect(parseProximityLine('* No one heard you... *')).toEqual({ kind: 'noOneHeard' });
    expect(parseProximityLine('Pip joined the game').kind).toBe('other');
    expect(parseProximityLine('Pip was slain by Zombie').kind).toBe('other');
  });

  it('does not mistake a shout for a normal line', () => {
    const r = parseProximityLine('[Shout] Pip » hey');
    expect(r.kind === 'speech' && r.volume).toBe('shout');
  });

  it('prefixes outgoing text by volume and never lets normal text trigger a mode', () => {
    expect(withVolumePrefix('hi', 'shout')).toBe('!hi');
    expect(withVolumePrefix('hi', 'whisper')).toBe('#hi');
    expect(withVolumePrefix('!not a shout', 'normal')).toBe('not a shout');
    expect(withVolumePrefix('# hashtag', 'normal')).toBe('hashtag');
  });

  it('renders the plugin config with our ranges', () => {
    const yml = renderProximityChatConfig({ normalRange: 15, whisperRange: 5, shoutRange: 48, fadeStart: 0.6, cooldownSec: 1 });
    expect(yml).toContain('  default: 15');
    expect(yml).toContain('  shout: 48');
    expect(yml).toContain('  whisper: 5');
    expect(yml).toContain('start-percentage: 60');
    expect(yml).toMatch(/cooldown:\n {4}enabled: true\n {4}time: 1/);
  });
});
