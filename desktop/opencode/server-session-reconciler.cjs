/**
 * Reads exact, already-bound Provider Session ids after a Server/host restart.
 * It never searches for a similarly named Session and never creates one.
 */
async function reconcileOpenCodeSessionBindings({ client, cwd, bindings } = {}) {
  if (!client?.getSession) throw new Error("opencode_server_session_read_unavailable");
  const directory = requiredString(cwd, "opencode_server_session_cwd_required");
  const entries = Array.isArray(bindings) ? bindings : [];
  const results = [];
  for (const binding of entries) {
    const sessionId = requiredString(binding?.sessionId, "opencode_server_logical_session_id_required");
    const providerSessionId = requiredString(binding?.providerSessionId, "opencode_server_session_id_required");
    try {
      const providerSession = await client.getSession({ cwd: directory, providerSessionId });
      results.push({ sessionId, providerSessionId, status: "available", providerSession });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({
        sessionId,
        providerSessionId,
        status: reason === "opencode_server_request_failed:404" ? "missing" : "unavailable",
        reason,
      });
    }
  }
  return results;
}

function requiredString(value, reason) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(reason);
  return text;
}

module.exports = { reconcileOpenCodeSessionBindings };
