import { describe, expect, it } from 'vitest';
import { READ_SYSTEM_PROMPT } from '../../src/read/aiReadExplainer';

describe('command guidance prompt', () => {
	it('uses reliable sports command syntax with matchup and selected team', () => {
		expect(READ_SYSTEM_PROMPT).toContain('bet $[amount] on [team A] vs [team B] on [team you want to bet on]');
		expect(READ_SYSTEM_PROMPT).toContain('bet $5 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers');
		expect(READ_SYSTEM_PROMPT).toContain('bet $5 on Missouri Tigers vs Miami Hurricanes on Miami Hurricanes');
	});

	it('still keeps explicit yes/no syntax for non-sports markets', () => {
		expect(READ_SYSTEM_PROMPT).toContain('bet $[amount] on [market description] yes');
		expect(READ_SYSTEM_PROMPT).toContain('bet $[amount] on [market description] no');
	});

	it('does not instruct team-only sports commands', () => {
		expect(READ_SYSTEM_PROMPT).not.toContain('Just use the team name, NOT yes/no.');
	});
});
