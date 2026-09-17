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

    async destroy(profileId) {
        const id = Number(profileId);
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        this.runtimes.delete(id);
        await runtime.destroy();
    }

    async stopAll() {
        await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()));
    }
}

module.exports = { ProfileRuntimeManager };
