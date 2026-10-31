const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function sessionCache(safeStorage, directory, origin) {
  const file = path.join(directory, 'login-session.bin');
  return {
    save(token, tenant) {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const encrypted = safeStorage.encryptString(JSON.stringify({version: 1, origin, token, tenant}));
      const temporary = path.join(directory, `login-${randomUUID()}.tmp`);
      try {
        fs.mkdirSync(directory, {recursive: true});
        fs.writeFileSync(temporary, encrypted, {mode: 0o600});
        fs.renameSync(temporary, file);
        return true;
      } catch {
        try { fs.unlinkSync(temporary); } catch {}
        return false;
      }
    },
    load() {
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
        if (data.version !== 1 || data.origin !== origin || typeof data.token !== 'string' || !data.token || typeof data.tenant !== 'string' || !data.tenant) return null;
        return {token: data.token, tenant: data.tenant};
      } catch { return null; }
    },
    clear() { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
}
module.exports = {sessionCache};
