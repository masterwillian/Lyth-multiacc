class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ValidationError";
        this.code = "VALIDATION_ERROR";
    }
}

function object(value, label = "payload") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError(`${label} inválido`);
    }
    return value;
}

function id(value, label = "id") {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ValidationError(`${label} inválido`);
    return parsed;
}

function text(value, { label = "texto", max = 120, allowEmpty = false } = {}) {
    if (typeof value !== "string") throw new ValidationError(`${label} inválido`);
    const normalized = value.trim();
    if (!allowEmpty && !normalized) throw new ValidationError(`${label} obrigatório`);
    if (normalized.length > max) throw new ValidationError(`${label} excede ${max} caracteres`);
    return normalized;
}

function count(value, { min = 1, max = 20 } = {}) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new ValidationError(`quantidade deve estar entre ${min} e ${max}`);
    }
    return parsed;
}

function webUrl(value, { allowBlank = false } = {}) {
    if (allowBlank && value === "about:blank") return value;
    const normalized = text(value, { label: "URL", max: 4096 });
    let parsed;
    try { parsed = new URL(normalized); } catch { throw new ValidationError("URL inválida"); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
        throw new ValidationError("Somente URLs HTTP e HTTPS são permitidas");
    }
    return parsed.href;
}

function optionalWebUrl(value) {
    if (value === null || value === undefined || value === "") return null;
    return webUrl(value);
}

function boolean(value, label = "valor") {
    if (typeof value !== "boolean") throw new ValidationError(`${label} inválido`);
    return value;
}

function stringArray(value, { label = "lista", maxItems = 100, itemMax = 4096 } = {}) {
    if (!Array.isArray(value) || value.length > maxItems) throw new ValidationError(`${label} inválida`);
    return value.map(item => text(item, { label, max: itemMax }));
}

function idArray(value, { maxItems = 1000 } = {}) {
    if (!Array.isArray(value) || value.length > maxItems) throw new ValidationError("lista de IDs inválida");
    return [...new Set(value.map(item => id(item)))];
}

module.exports = { ValidationError, object, id, text, count, webUrl, optionalWebUrl, boolean, stringArray, idArray };
