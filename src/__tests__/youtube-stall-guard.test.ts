import { StallGuard } from '../modules/youtube/youtube.stall-guard';

describe('StallGuard', () => {
    const build = (threshold: number, uptimeMs = 60 * 60_000) => {
        const restart = jest.fn();
        return { restart, guard: new StallGuard(threshold, 10 * 60_000, restart, () => uptimeMs) };
    };

    it('restarts once after the configured number of consecutive stalls', () => {
        const { guard, restart } = build(3);
        guard.record('network_timeout');
        guard.record('network_timeout');
        expect(restart).not.toHaveBeenCalled();
        guard.record('network_timeout');
        guard.record('network_timeout');
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('resets the streak after a successful download', () => {
        const { guard, restart } = build(2);
        guard.record('network_timeout');
        guard.record('ok');
        guard.record('network_timeout');
        expect(restart).not.toHaveBeenCalled();
    });

    it('ignores unrelated failures without clearing the streak', () => {
        const { guard, restart } = build(2);
        guard.record('network_timeout');
        guard.record('other');
        expect(restart).not.toHaveBeenCalled();
        guard.record('network_timeout');
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('never restarts a young process or when disabled', () => {
        const young = build(1, 60_000);
        young.guard.record('network_timeout');
        expect(young.restart).not.toHaveBeenCalled();
        const disabled = build(0);
        for (let i = 0; i < 10; i++) disabled.guard.record('network_timeout');
        expect(disabled.restart).not.toHaveBeenCalled();
    });
});
