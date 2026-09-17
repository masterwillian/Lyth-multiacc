class ProfileRuntimeManager {
    constructor(createRuntime) {
        this.createRuntime = createRuntime;
        this.runtimes = new Map();
    }

    ensure(profile) {
        const existing = this.runtimes.get(profile.id);
        if (existing) {
            existing.profile = profile;
            return existing;
        }
        const runtime = this.createRuntime(profile);
        this.runtimes.set(profile.id, runtime);
        return runtime;
    }

    get(profileId) {
        return this.runtimes.get(Number(profileId));
    }

    values() {
        return [...this.runtimes.values()];
    }

    snapshots() {
        return this.values().map(runtime => runtime.snapshot());
    }

    async startAll(profiles) {
        const results = await Promise.allSettled(profiles.map(profile => this.ensure(profile).start()));
        return results.map((result, index) => ({
            profile: profiles[index],
            status: result.status,
            runtime: this.get(profiles[index].id),
            error: result.status === "rejected" ? result.reason : null
        }));
    }

    async destroy(profileId) {
        const id = Number(profileId);
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        await runtime.destroy();
        this.runtimes.delete(id);
    }

    async stopAll() {
        return Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()));
    }
}

module.exports = { ProfileRuntimeManager };
