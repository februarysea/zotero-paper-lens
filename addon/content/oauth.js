/* OpenAI OSS OAuth: fixed endpoints, PKCE, bounded HTTP and verified OIDC identity. */
var PaperLensOAuth = (function () {
  "use strict";
  const ISSUER = "https://auth.openai.com";
  const RESOURCE = "https://api.openai.com/v1";
  const AUTHORIZE = ISSUER + "/api/accounts/authorize";
  const TOKEN = ISSUER + "/api/accounts/oauth/token";
  const DISCOVERY = ISSUER + "/.well-known/openid-configuration";
  const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const PLAN_SCOPE = "chatgpt.tokens.use.direct";
  const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired",
    "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
  function authError(code, status) {
    return Object.assign(new Error(code), { code, ...(Number.isInteger(status) ? { status } : {}) });
  }
  const issuedClient = (value) => typeof value === "string" && value !== "dynamic_agent_client"
    && /^[A-Za-z0-9._-]{1,256}$/.test(value);
  function trustedURL(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw authError("AUTH_DISCOVERY_INVALID"); }
    if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash) {
      throw authError("AUTH_DISCOVERY_INVALID");
    }
    return url.href;
  }
  function base64url(bytes, encode) {
    return encode(Array.from(bytes, x => String.fromCharCode(x)).join(""))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function decode64(value, decode) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 65536) {
      throw authError("AUTH_IDENTITY_INVALID");
    }
    try {
      const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
      return Uint8Array.from(decode(padded), x => x.charCodeAt(0));
    } catch (_) { throw authError("AUTH_IDENTITY_INVALID"); }
  }
  function randomValue(cryptoImpl, encode, size = 32) {
    return base64url(cryptoImpl.getRandomValues(new Uint8Array(size)), encode);
  }
  async function pkce(cryptoImpl, encode, Encoder = TextEncoder) {
    const verifier = randomValue(cryptoImpl, encode);
    const digest = await cryptoImpl.subtle.digest("SHA-256", new Encoder().encode(verifier));
    return { verifier, challenge: base64url(new Uint8Array(digest), encode) };
  }
  function abortable(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(authError("AUTH_NETWORK")); };
      if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function readJSON(response, { limit = 1048576, signal, Decoder = TextDecoder } = {}) {
    try {
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new Decoder("utf-8", { fatal: true });
        let size = 0; text = "";
        try {
          while (true) {
            if (signal?.aborted) throw authError("AUTH_NETWORK");
            const { value, done } = await abortable(reader.read(), signal);
            if (done) { text += decoder.decode(); break; }
            size += value.byteLength;
            if (size > limit) throw authError("AUTH_RESPONSE_INVALID");
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
          try { reader.releaseLock(); } catch (_) {}
        }
      } else {
        text = await abortable(response.text(), signal);
        if (text.length > limit) throw authError("AUTH_RESPONSE_INVALID");
      }
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw authError("AUTH_RESPONSE_INVALID");
      return value;
    } catch (error) {
      if (["AUTH_NETWORK", "AUTH_RESPONSE_INVALID"].includes(error.code)) throw error;
      throw authError(signal?.aborted ? "AUTH_NETWORK" : "AUTH_RESPONSE_INVALID");
    }
  }
  async function verifyIDToken(token, { clientID, nonce, subject, metadata, jwks,
    cryptoImpl, decode, now = Date.now, Encoder = TextEncoder, Decoder = TextDecoder }) {
    try {
      if (typeof token !== "string" || token.length > 65536) throw authError("AUTH_IDENTITY_INVALID");
      const segments = token.split(".");
      if (segments.length !== 3) throw authError("AUTH_IDENTITY_INVALID");
      const decoder = new Decoder("utf-8", { fatal: true });
      const header = JSON.parse(decoder.decode(decode64(segments[0], decode)));
      const claims = JSON.parse(decoder.decode(decode64(segments[1], decode)));
      if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256
        || header.crit || header.jku || header.jwk || header.x5u
        || !claims || typeof claims !== "object" || Array.isArray(claims)) throw authError("AUTH_IDENTITY_INVALID");
      const keys = jwks?.keys;
      if (!Array.isArray(keys) || keys.length > 100) throw authError("AUTH_IDENTITY_INVALID");
      const matches = keys.filter(x => x?.kid === header.kid);
      if (matches.length !== 1) throw authError("AUTH_IDENTITY_INVALID");
      const jwk = matches[0];
      if (jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256") || (jwk.use && jwk.use !== "sig")
        || jwk.d || (jwk.key_ops && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")))
        || decode64(jwk.n, decode).length < 256) throw authError("AUTH_IDENTITY_INVALID");
      const publicKey = await cryptoImpl.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const valid = await cryptoImpl.subtle.verify("RSASSA-PKCS1-v1_5", publicKey,
        decode64(segments[2], decode), new Encoder().encode(segments[0] + "." + segments[1]));
      const seconds = now() / 1000;
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (!valid || claims.iss !== metadata.issuer || !Array.isArray(audiences) || !audiences.includes(clientID)
        || (audiences.length > 1 && claims.azp !== clientID) || (claims.azp && claims.azp !== clientID)
        || !Number.isInteger(claims.exp) || claims.exp <= seconds - 30
        || !Number.isInteger(claims.iat) || claims.iat > seconds + 30
        || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 30))
        || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256
        || (nonce !== undefined && claims.nonce !== nonce) || (subject && claims.sub !== subject)) {
        throw authError("AUTH_IDENTITY_INVALID");
      }
      return { subject: claims.sub, issuer: claims.iss,
        email: typeof claims.email === "string" && claims.email.length <= 320
          && !/[\u0000-\u001F\u007F]/.test(claims.email) ? claims.email : "" };
    } catch (_) { throw authError("AUTH_IDENTITY_INVALID"); }
  }
  function callback(query, expectedState, clientID) {
    for (const key of ["state", "code", "error", "client_id"]) {
      if (query.getAll(key).length > 1) throw authError("AUTH_CALLBACK_INVALID");
    }
    if (query.get("state") !== expectedState) throw authError("AUTH_CALLBACK_INVALID");
    if (query.get("error")) throw authError(query.get("error") === "access_denied" ? "AUTH_DECLINED" : "AUTH_CALLBACK_INVALID");
    const code = query.get("code"), supplied = query.get("client_id");
    if (!code || code.length > 4096 || /[\u0000-\u0020\u007F]/.test(code)
      || (!clientID && !issuedClient(supplied)) || (supplied && clientID && supplied !== clientID)) {
      throw authError("AUTH_CALLBACK_INVALID");
    }
    return { code, clientID: clientID || supplied };
  }
  function validateMetadata(data) {
    if (data.issuer !== ISSUER || data.authorization_endpoint !== AUTHORIZE || data.token_endpoint !== TOKEN) {
      throw authError("AUTH_DISCOVERY_INVALID");
    }
    return { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN,
      jwks_uri: trustedURL(data.jwks_uri), revocation_endpoint: data.revocation_endpoint ? trustedURL(data.revocation_endpoint) : null };
  }
  return { ISSUER, RESOURCE, AUTHORIZE, TOKEN, DISCOVERY, SCOPES, PLAN_SCOPE, TERMINAL_REFRESH,
    authError, issuedClient, pkce, randomValue, abortable, readJSON, verifyIDToken, callback, validateMetadata };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensOAuth;
