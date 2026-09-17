function normalizeWorkspace(stored = {}) {
    const groups = Array.isArray(stored.groups) ? stored.groups : [];
    const maxGroupId = groups.reduce((max, group) => Math.max(max, Number(group.id) || 0), 0);
    const maxAccountId = groups.flatMap(group => Array.isArray(group.accounts) ? group.accounts : [])
        .reduce((max, account) => Math.max(max, Number(account.id) || 0), 0);

    return {
        groups,
        nextGroupId: Math.max(Number(stored.nextGroupId) || 0, maxGroupId + 1),
        nextAccountId: Math.max(Number(stored.nextAccountId) || 0, maxAccountId + 1)
    };
}

module.exports = { normalizeWorkspace };
