function isCanonicalWorkspaceSessionId(sessionId) {
  const parts = String(sessionId ?? "").split(":");
  return [4, 5].includes(parts.length) && parts.every((part) => /^[a-z0-9-]+$/i.test(part));
}

function taskIdFromWorkspaceSessionId(sessionId) {
  const parts = String(sessionId ?? "").split(":");
  return parts.length >= 3 ? parts[2] : undefined;
}

module.exports = { isCanonicalWorkspaceSessionId, taskIdFromWorkspaceSessionId };
