import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriage, triageStorageKey} from '../../public/triage.js';

const incident = (id = 'INC-000001') => ({id, title: 'Incident <sample>', service: 'Billing', severity: 'high', status: 'open', description: 'Canonical record'});
function storage(initial = null) {
  let value = initial;
  return {getItem(key) { assert.equal(key, triageStorageKey); return value; }, setItem(key, next) { assert.equal(key, triageStorageKey); value = next; }};
}
test('triage persists added order and literal notes, deduplicates and removes notes with membership', () => {
  const local = storage(), triage = createTriage(() => local), first = incident(), second = incident('INC-000002');
  const canonical = structuredClone(first);
  assert.equal(triage.add(first), true); assert.equal(triage.add(second), true);
  const note = '<script>alert("hello")</script> & punctuation,\n雪';
  assert.equal(triage.edit(first.id, note), true);
  assert.equal(triage.add({...first, title: 'Updated recognition'}), false);
  assert.deepEqual(triage.entries.map(entry => entry.id), [first.id, second.id]);
  assert.equal(triage.entries[0].note, note); assert.equal(triage.entries[0].title, first.title);
  assert.deepEqual(first, canonical);
  assert.deepEqual(createTriage(local).entries, triage.entries);
  assert.equal(triage.remove(first.id), true);
  assert.equal(createTriage(local).entries.some(entry => entry.id === first.id), false);
  triage.add(first);
  assert.deepEqual(triage.entries.map(entry => entry.id), [second.id, first.id]);
  assert.equal(triage.entries[1].note, '');
  assert.match(triage.message, /saved in this browser/);
});
test('malformed stored values are rejected as a whole and usable visit state can replace them', () => {
  const valid = {...incident(), note: ''}; delete valid.description;
  for (const value of ['{', 'null', '{}', JSON.stringify([valid, {...valid, id: 'bad'}]), JSON.stringify([valid, valid]), JSON.stringify([{...valid, note: 5}]), JSON.stringify([{...valid, service: 'unknown'}]), JSON.stringify([{...valid, extra: true}])]) {
    const local = storage(value), triage = createTriage(local);
    assert.deepEqual(triage.entries, []); assert.match(triage.message, /malformed/);
    triage.add(incident()); triage.edit('INC-000001', '<b>literal</b>');
    assert.equal(triage.entries[0].note, '<b>literal</b>');
    assert.deepEqual(createTriage(local).entries, triage.entries);
  }
});
test('unavailable access, read and write preserve current visit membership, order and notes', () => {
  for (const unavailable of [() => { throw new Error('Unavailable accessor'); }, {getItem() { throw new Error('Read unavailable'); }, setItem() { throw new Error('Write unavailable'); }}]) {
    const triage = createTriage(unavailable);
    assert.match(triage.message, /storage is unavailable/);
    triage.add(incident()); triage.add(incident('INC-000002'));
    triage.edit('INC-000001', 'Visit note <x>');
    assert.deepEqual(triage.entries.map(entry => entry.id), ['INC-000001', 'INC-000002']);
    assert.equal(triage.entries[0].note, 'Visit note <x>');
    assert.match(triage.message, /remain usable for this visit/);
    triage.remove('INC-000002'); assert.equal(triage.entries.length, 1);
  }
});
test('a later storage failure keeps loaded state and a later successful write persists all visit changes', () => {
  const local = storage(), initial = createTriage(local); initial.add(incident());
  let fail = true;
  const triage = createTriage({getItem: key => local.getItem(key), setItem(key, value) { if (fail) throw new Error('Quota'); local.setItem(key, value); }});
  triage.edit('INC-000001', 'Unsaved literal <note>'); triage.add(incident('INC-000002'));
  assert.equal(triage.entries[0].note, 'Unsaved literal <note>'); assert.equal(triage.entries.length, 2);
  assert.match(triage.message, /could not be saved/);
  fail = false; triage.edit('INC-000002', 'Now persisted');
  assert.deepEqual(createTriage(local).entries, triage.entries);
});
test('invalid mutations cannot corrupt triage, and caller mutation cannot bypass persistence', () => {
  const triage = createTriage(storage());
  assert.equal(triage.add({...incident(), id: 'bad'}), false);
  assert.equal(triage.edit('INC-000001', 'missing'), false);
  assert.equal(triage.remove('INC-000001'), false);
  triage.add(incident());
  assert.equal(triage.edit('INC-000001', 42), false);
  assert.throws(() => { triage.entries[0].note = 'bypass'; }, TypeError);
  assert.throws(() => { triage.entries.push(incident()); }, TypeError);
  assert.equal(triage.entries[0].note, '');
});
