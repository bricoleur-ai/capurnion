"use strict";
// Browser storage simulation. CryptoKey cloning and cryptography use Node's
// native implementation; this does not substitute for a live Chrome check.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const webcrypto = require("node:crypto").webcrypto;
const root = path.join(__dirname, "..");
function indexedDatabase() {
  const databases = new Map();
  let failWrite = false;
  return {
    failNextWrite() { failWrite = true; },
    databases,
    open(name) {
      const request = {};
      setImmediate(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {close() {}, createObjectStore(store) { stores.set(store, new Map()); },
          transaction(storeName, mode) {
            const target = stores.get(storeName), working = new Map(target);
            const tx = {objectStore: () => store, abort() { aborted = true; setImmediate(() => tx.onabort?.()); }};
            let pending = 0, aborted = false, completion;
            function complete() {
              clearImmediate(completion);
              completion = setImmediate(() => {
                if (pending || aborted) return;
                if (mode === "readwrite") {
                  target.clear(); working.forEach((value, key) => target.set(key, value));
                }
                tx.oncomplete?.();
              });
            }
            function action(operation, request = {}) {
              pending++; clearImmediate(completion);
              setImmediate(() => {
                try {
                  if (failWrite && mode === "readwrite") { failWrite = false; throw new Error("Simulated IndexedDB failure"); }
                  request.result = operation(); request.onsuccess?.();
                } catch (error) { aborted = true; request.error = error; request.onerror?.(); tx.onerror?.(); }
                pending--; complete();
              });
              return request;
            }
            const store = {
              get(key) { return action(() => structuredClone(working.get(key))); },
              put(value) { return action(() => working.set(value.id, structuredClone(value))); },
              openCursor() {
                const request = {}, keys = [...working.keys()];
                const next = () => action(() => {
                  const key = keys.shift();
                  return key === undefined ? null : {key, delete() { return action(() => working.delete(key)); }, continue: next};
                }, request);
                next(); return request;
              },
            };
            complete(); return tx;
          },
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}
function backend() {
  const records = {}, listeners = [], indexedDB = indexedDatabase();
  let queue = Promise.resolve(), failWrite = false;
  return {records, listeners, indexedDB,
    failNextWrite() { failWrite = true; },
    locks: {request(name, fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }},
    async get(key) { return {[key]: structuredClone(records[key])}; },
    async set(values) {
      if (failWrite) { failWrite = false; throw new Error("Simulated storage write failure"); }
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = {oldValue: structuredClone(records[key]), newValue: structuredClone(value)};
        records[key] = structuredClone(value);
      }
      listeners.forEach(fn => fn(changes, "local"));
    },
  };
}
function worker(store, enabled = true) {
  const context = vm.createContext({crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    indexedDB: store.indexedDB, CAPURNION_RULES: {vault: {enabled}},
    chrome: {storage: {local: {get: store.get, set: store.set, async setAccessLevel() {}}}}});
  for (const file of ["vault.js", "vault-device-key.js", "vault-runtime.js"])
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  return {vault: context.CAPURNION_VAULT, keys: context.CAPURNION_VAULT_KEYS, access: context.CAPURNION_VAULT_ACCESS, context};
}
module.exports = {backend, worker};
