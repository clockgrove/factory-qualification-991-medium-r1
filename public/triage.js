// Personal metadata stays independent of incident records, addresses and saved views.
export const triageStorageKey = 'incident-explorer.triage.v1';
const services = ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'];
const severities = ['critical', 'high', 'medium', 'low'];
const statuses = ['open', 'in_progress', 'resolved'];
const fields = ['id', 'title', 'service', 'severity', 'status', 'note'];
function validEntry(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).length === fields.length
    && fields.every(key => Object.hasOwn(entry, key))
    && typeof entry.id === 'string' && /^INC-\d{6}$/.test(entry.id)
    && typeof entry.title === 'string' && entry.title.length > 0
    && services.includes(entry.service) && severities.includes(entry.severity)
    && statuses.includes(entry.status) && typeof entry.note === 'string';
}
const freezeEntries = entries => Object.freeze(entries.map(entry => Object.freeze({...entry})));
export function createTriage(storage) {
  let entries = freezeEntries([]), message = '';
  const getStorage = () => typeof storage === 'function' ? storage() : storage;
  try {
    const raw = getStorage().getItem(triageStorageKey);
    if (raw !== null) {
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored) || !stored.every(validEntry)
          || new Set(stored.map(entry => entry.id)).size !== stored.length) {
        throw new SyntaxError('Malformed triage');
      }
      entries = freezeEntries(stored);
    }
  } catch (error) {
    message = error instanceof SyntaxError
      ? 'Stored triage could not be read because it is malformed. You can keep a triage list for this visit.'
      : 'Triage storage is unavailable. Your triage list will remain usable for this visit.';
  }
  function update(next) {
    entries = freezeEntries(next);
    try {
      getStorage().setItem(triageStorageKey, JSON.stringify(entries));
      message = 'Triage saved in this browser.';
    } catch {
      message = 'Triage could not be saved in this browser. Your list and notes remain usable for this visit.';
    }
    return true;
  }
  return {
    get entries() { return entries; },
    get message() { return message; },
    add(incident) {
      const entry = Object.fromEntries(fields.map(key => [key, key === 'note' ? '' : incident?.[key]]));
      if (!validEntry(entry) || entries.some(item => item.id === entry.id)) return false;
      return update([...entries, entry]);
    },
    remove(id) {
      if (!entries.some(entry => entry.id === id)) return false;
      return update(entries.filter(entry => entry.id !== id));
    },
    edit(id, note) {
      if (typeof note !== 'string' || !entries.some(entry => entry.id === id)) return false;
      return update(entries.map(entry => entry.id === id ? {...entry, note} : entry));
    }
  };
}
