/* Paper Lens owns its OAuth registration and protected credentials, independent of Codex. */
var PaperLensAuth = (function () {
  "use strict";
  const OAuth = typeof PaperLensOAuth !== "undefined" ? PaperLensOAuth : require("./oauth.js");
  const { authError } = OAuth;
  const nonempty = value => typeof value === "string" && !!value.trim() && value.length <= 65536;
  const copy = value => JSON.parse(JSON.stringify(value));
  function emptyStore() { return { version: 1, hostID: null, activeID: null, registrations: [] }; }
  function validateStore(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.registrations) || value.registrations.length > 30
      || (value.hostID !== null && !/^urn:uuid:[a-f0-9-]{36}$/i.test(value.hostID || ""))) throw authError("AUTH_FILE_INVALID");
    const ids = new Set(), clients = new Set();
    const registrations = value.registrations.map(item => {
      if (!item || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id || "") || ids.has(item.id)
        || !OAuth.issuedClient(item.clientID) || clients.has(item.clientID)
        || (item.subject !== null && (!nonempty(item.subject) || item.subject.length > 256))
        || typeof item.email !== "string" || item.email.length > 320 || /[\u0000-\u001F\u007F]/.test(item.email)) throw authError("AUTH_FILE_INVALID");
      ids.add(item.id); clients.add(item.clientID);
      let tokens = null;
      if (item.tokens) {
        const t = item.tokens;
        if (!item.subject || !nonempty(t.accessToken) || !nonempty(t.idToken)
          || (t.refreshToken !== null && !nonempty(t.refreshToken))
          || !Number.isFinite(t.expiresAt) || t.expiresAt <= 0
          || !Array.isArray(t.scopes) || t.scopes.length > 30
          || t.scopes.some(x => typeof x !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(x))) throw authError("AUTH_FILE_INVALID");
        tokens = { accessToken: t.accessToken, idToken: t.idToken, refreshToken: t.refreshToken,
          expiresAt: t.expiresAt, scopes: [...t.scopes] };
      }
      return { id: item.id, clientID: item.clientID, subject: item.subject, email: item.email, tokens };
    });
    if (value.activeID !== null && !ids.has(value.activeID)) throw authError("AUTH_FILE_INVALID");
    return { version: 1, hostID: value.hostID, activeID: value.activeID, registrations };
  }
  class AuthProvider {
    constructor({ store, cryptoImpl, encode, decode, fetchImpl, listen, openBrowser,
      now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
      Object.assign(this, { store, crypto: cryptoImpl, encode, decode, fetch: fetchImpl, listen, openBrowser, now, setTimer, clearTimer });
      this.data = null; this.loading = null; this.writes = Promise.resolve();
      this.refreshing = new Map(); this.lastTokens = new Map(); this.controllers = new Set();
      this.pending = null; this.disposed = false; this.blocked = new Set(); this.metadata = null;
    }
    alive() { if (this.disposed) throw authError("AUTH_CANCELLED"); }
    async load() {
      this.alive();
      if (!this.data) {
        if (!this.loading) this.loading = this.store.read().then(value => {
          this.alive(); this.data = value ? validateStore(value) : emptyStore();
        }).finally(() => { this.loading = null; });
        await this.loading;
      }
      return this.data;
    }
    async mutate(change) {
      const operation = this.writes.then(async () => {
        const next = copy(await this.load());
        const result = change(next);
        this.alive();
        const validated = validateStore(next);
        await this.store.write(validated);
        this.alive(); this.data = validated;
        return result;
      });
      this.writes = operation.catch(() => {});
      return operation;
    }
    async json(url, init = {}, { token = false, timeoutMs = 20000, empty = false } = {}) {
      this.alive();
      const controller = new AbortController(); this.controllers.add(controller);
      const timer = this.setTimer(() => controller.abort(), timeoutMs);
      try {
        const response = await OAuth.abortable(this.fetch(url, { ...init, credentials: "omit", redirect: "error", signal: controller.signal }), controller.signal);
        if (empty && response.ok) return {};
        let payload;
        try { payload = await OAuth.readJSON(response, { signal: controller.signal }); }
        catch (error) { if (!response.ok) throw authError(token ? "AUTH_TOKEN_FAILED" : "AUTH_NETWORK", response.status); throw error; }
        if (!response.ok) {
          const known = token && (OAuth.TERMINAL_REFRESH.has(payload.error) || payload.error === "invalid_client");
          const error = authError(token ? "AUTH_TOKEN_FAILED" : "AUTH_NETWORK", response.status);
          if (known) error.oauthCode = payload.error;
          throw error;
        }
        this.alive(); return payload;
      } catch (error) {
        if (["AUTH_NETWORK", "AUTH_RESPONSE_INVALID", "AUTH_TOKEN_FAILED", "AUTH_CANCELLED"].includes(error.code)) throw error;
        throw authError(this.disposed ? "AUTH_CANCELLED" : "AUTH_NETWORK");
      } finally { this.clearTimer(timer); this.controllers.delete(controller); }
    }
    async discovery() {
      if (!this.metadata) this.metadata = OAuth.validateMetadata(await this.json(OAuth.DISCOVERY));
      return this.metadata;
    }
    async identity(idToken, args) {
      const metadata = await this.discovery();
      const jwks = await this.json(metadata.jwks_uri);
      return OAuth.verifyIDToken(idToken, { ...args, metadata, jwks, cryptoImpl: this.crypto,
        decode: this.decode, now: this.now });
    }
    tokenData(payload, previous) {
      if (!nonempty(payload.access_token) || typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer"
        || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || payload.expires_in > 86400
        || (payload.refresh_token !== undefined && !nonempty(payload.refresh_token))
        || (payload.id_token !== undefined && !nonempty(payload.id_token))
        || (payload.scope !== undefined && (typeof payload.scope !== "string" || payload.scope.length > 4096))) throw authError("AUTH_RESPONSE_INVALID");
      const scopes = payload.scope === undefined ? previous?.scopes : payload.scope.trim().split(/\s+/).filter(Boolean);
      if (!scopes || scopes.length > 30 || scopes.some(x => !/^[A-Za-z0-9._:-]{1,128}$/.test(x))) throw authError("AUTH_RESPONSE_INVALID");
      return { accessToken: payload.access_token, refreshToken: payload.refresh_token || previous?.refreshToken || null,
        idToken: payload.id_token || previous?.idToken, expiresAt: this.now() + payload.expires_in * 1000, scopes: [...new Set(scopes)] };
    }
    async getState() {
      const data = await this.load();
      const accounts = data.registrations.map((item, index) => ({ id: item.id,
        label: (item.email || "ChatGPT") + " · " + (index + 1),
        connected: !!item.tokens, planEnabled: !!item.tokens?.scopes.includes(OAuth.PLAN_SCOPE) }));
      const active = accounts.find(x => x.id === data.activeID);
      return { accounts, activeID: data.activeID, connected: !!active?.connected,
        planEnabled: !!active?.planEnabled, signingIn: !!this.pending };
    }
    async signIn(accountID = null) {
      this.alive();
      if (this.pending) throw authError("AUTH_BUSY");
      const attempt = { listener: null, cancelled: false }; this.pending = attempt;
      const live = () => { this.alive(); if (attempt.cancelled || this.pending !== attempt) throw authError("AUTH_CANCELLED"); };
      try {
        const data = await this.load(); live();
        const selected = accountID ? data.registrations.find(x => x.id === accountID) : null;
        if (accountID && !selected) throw authError("AUTH_ACCOUNT_CHANGED");
        if (!selected && data.registrations.length >= 30) throw authError("AUTH_ACCOUNT_LIMIT");
        await this.discovery(); live();
        let hostID = data.hostID;
        if (!hostID) {
          hostID = "urn:uuid:" + this.crypto.randomUUID();
          await this.mutate(next => { next.hostID ||= hostID; hostID = next.hostID; }); live();
        }
        const state = OAuth.randomValue(this.crypto, this.encode), nonce = OAuth.randomValue(this.crypto, this.encode);
        const { verifier, challenge } = await OAuth.pkce(this.crypto, this.encode); live();
        const listener = await this.listen({ state }); attempt.listener = listener; live();
        const url = new URL(OAuth.AUTHORIZE);
        const parameters = { client_id: selected?.clientID || "dynamic_agent_client", ext_agent_host_id: hostID,
          response_type: "code", redirect_uri: listener.redirectURI, scope: OAuth.SCOPES,
          resource: OAuth.RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: challenge };
        if (!selected) parameters.agent_name_hint = "Paper Lens";
        // Optional identity hints are omitted to keep credentials out of launch URLs.
        if (selected?.tokens && !selected.tokens.scopes.includes(OAuth.PLAN_SCOPE)) parameters.prompt = "consent";
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
        await this.openBrowser(url.href); live();
        const query = await listener.result; live();
        const authorization = OAuth.callback(query, state, selected?.clientID);
        let registrationID = selected?.id;
        if (!registrationID) {
          registrationID = this.crypto.randomUUID();
          // Retain an issued registration even if the authorization code expires.
          await this.mutate(next => {
            if (next.registrations.some(x => x.clientID === authorization.clientID)) throw authError("AUTH_CALLBACK_INVALID");
            next.registrations.push({ id: registrationID, clientID: authorization.clientID, subject: null, email: "", tokens: null });
          }); live();
        }
        const payload = await this.json(OAuth.TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", client_id: authorization.clientID,
            code: authorization.code, code_verifier: verifier, redirect_uri: listener.redirectURI, resource: OAuth.RESOURCE }).toString() }, { token: true });
        live();
        const identity = await this.identity(payload.id_token, { clientID: authorization.clientID, nonce, subject: selected?.subject }); live();
        const tokens = this.tokenData(payload);
        await this.mutate(next => {
          live(); const item = next.registrations.find(x => x.id === registrationID);
          if (!item || item.clientID !== authorization.clientID) throw authError("AUTH_ACCOUNT_CHANGED");
          item.subject = identity.subject; item.email = identity.email; item.tokens = tokens;
          next.activeID = item.id;
        });
        if (this.pending === attempt) this.pending = null;
        return this.getState();
      } finally {
        attempt.listener?.close();
        if (this.pending === attempt) this.pending = null;
      }
    }
    cancelSignIn() {
      if (this.pending) { this.pending.cancelled = true; this.pending.listener?.close(); this.pending = null; }
    }
    async switchAccount(id) {
      if (this.pending) throw authError("AUTH_BUSY");
      await this.mutate(next => {
        if (!next.registrations.some(x => x.id === id)) throw authError("AUTH_ACCOUNT_CHANGED");
        next.activeID = id;
      });
      return this.getState();
    }
    async getCredentials({ forceRefresh = false, accountKey } = {}) {
      const data = await this.load();
      const item = data.registrations.find(x => x.id === data.activeID);
      if (!item?.tokens) throw authError("AUTH_MISSING");
      if ((accountKey && item.id !== accountKey) || this.blocked.has(item.id)) throw authError("AUTH_ACCOUNT_CHANGED");
      if (!item.tokens.scopes.includes(OAuth.PLAN_SCOPE)) throw authError("AUTH_PLAN_DISABLED");
      const changed = this.lastTokens.has(item.id) && this.lastTokens.get(item.id) !== item.tokens.accessToken;
      if ((forceRefresh && !changed) || item.tokens.expiresAt <= this.now() + 60000) {
        if (!this.refreshing.has(item.id)) {
          const promise = this.refresh(item.id, item.tokens.accessToken).finally(() => this.refreshing.delete(item.id));
          this.refreshing.set(item.id, promise);
        }
        await this.refreshing.get(item.id);
      }
      this.alive();
      const latest = this.data.registrations.find(x => x.id === item.id);
      if (this.data.activeID !== item.id || this.blocked.has(item.id)) throw authError("AUTH_ACCOUNT_CHANGED");
      if (!latest?.tokens) throw authError("AUTH_EXPIRED");
      if (!latest.tokens.scopes.includes(OAuth.PLAN_SCOPE)) throw authError("AUTH_PLAN_DISABLED");
      this.lastTokens.set(item.id, latest.tokens.accessToken);
      return { accessToken: latest.tokens.accessToken, accountKey: item.id };
    }
    async refresh(id, stale) {
      const item = (await this.load()).registrations.find(x => x.id === id);
      if (!item?.tokens) throw authError("AUTH_EXPIRED");
      if (item.tokens.accessToken !== stale) return;
      if (!item.tokens.refreshToken) throw authError("AUTH_EXPIRED");
      const original = copy(item);
      let payload;
      try {
        payload = await this.json(OAuth.TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: original.clientID,
            refresh_token: original.tokens.refreshToken, resource: OAuth.RESOURCE }).toString() }, { token: true });
      } catch (error) {
        if (OAuth.TERMINAL_REFRESH.has(error.oauthCode)) {
          await this.mutate(next => {
            const latest = next.registrations.find(x => x.id === id);
            if (latest?.tokens?.refreshToken === original.tokens.refreshToken) latest.tokens = null;
          });
          throw authError("AUTH_EXPIRED");
        }
        if (error.oauthCode === "invalid_client") throw authError("AUTH_CLIENT_INVALID");
        throw error;
      }
      if (payload.id_token) await this.identity(payload.id_token, { clientID: original.clientID, subject: original.subject });
      const tokens = this.tokenData(payload, original.tokens);
      await this.mutate(next => {
        const latest = next.registrations.find(x => x.id === id);
        if (latest?.tokens?.refreshToken === original.tokens.refreshToken && latest.tokens.accessToken === stale) latest.tokens = tokens;
      });
    }
    async signOut() {
      this.cancelSignIn();
      const data = await this.load(), id = data.activeID;
      if (!id) return { remoteRevoked: true };
      this.blocked.add(id);
      try {
        try { await this.refreshing.get(id); } catch (_) {}
        const item = this.data.registrations.find(x => x.id === id);
        let remoteRevoked = !item?.tokens?.refreshToken;
        if (!remoteRevoked) {
          try {
            const metadata = await this.discovery();
            if (!metadata.revocation_endpoint) throw authError("AUTH_DISCOVERY_INVALID");
            const init = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: item.tokens.refreshToken, token_type_hint: "refresh_token", client_id: item.clientID }).toString() };
            for (let attempt = 0; attempt < 2; attempt++) {
              try { await this.json(metadata.revocation_endpoint, init, { empty: true, timeoutMs: 8000 }); remoteRevoked = true; break; }
              catch (error) { if (error.status && error.status < 500) break; }
            }
          } catch (_) {}
        }
        await this.mutate(next => { const selected = next.registrations.find(x => x.id === id); if (selected) selected.tokens = null; });
        this.lastTokens.delete(id);
        return { remoteRevoked };
      } finally { this.blocked.delete(id); }
    }
    async dispose() {
      this.cancelSignIn(); this.disposed = true;
      for (const controller of this.controllers) controller.abort();
      await this.writes;
    }
  }
  function createFileStore({ IOUtils, PathUtils }) {
    const directory = PathUtils.join(PathUtils.profileDir, "paper-lens");
    const path = PathUtils.join(directory, "auth.json");
    return {
      async read() {
        let info;
        try { info = await IOUtils.stat(path); }
        catch (error) {
          if (error.name === "NotFoundError" || error.code === "ENOENT" || error.name === "NS_ERROR_FILE_NOT_FOUND") return null;
          throw authError("AUTH_FILE_INVALID");
        }
        if (info.type !== "regular" || !Number.isFinite(info.size) || info.size > 524288 || info.size < 0) throw authError("AUTH_FILE_INVALID");
        try {
          const text = await IOUtils.readUTF8(path);
          if (text.length > 524288) throw authError("AUTH_FILE_INVALID");
          return JSON.parse(text);
        } catch (_) { throw authError("AUTH_FILE_INVALID"); }
      },
      async write(data) {
        try {
          await IOUtils.makeDirectory(directory, { permissions: 0o700, ignoreExisting: true });
          await IOUtils.setPermissions(directory, 0o700);
          await IOUtils.writeUTF8(path, JSON.stringify(data) + "\n", { tmpPath: path + ".tmp", permissions: 0o600 });
          await IOUtils.setPermissions(path, 0o600);
        } catch (_) { throw authError("AUTH_SAVE_FAILED"); }
      },
    };
  }
  function createAuthProvider({ IOUtils, PathUtils, cryptoImpl, fetchImpl, encode, decode, listen, openBrowser }) {
    return new AuthProvider({ store: createFileStore({ IOUtils, PathUtils }), cryptoImpl, fetchImpl, encode, decode, listen, openBrowser });
  }
  return { AuthProvider, createAuthProvider, createFileStore, validateStore };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensAuth;
