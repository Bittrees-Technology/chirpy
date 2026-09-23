import { test, expect, injectSyntheticWallet } from './fixtures/wallet';
import type { Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { encryptRecoveryArchive, decryptRecoveryArchive, MAX_RECOVERY_FILE_BYTES, type RecoveryData } from '../../apps/web/src/recoveryArchive';
const password = 'recovery acceptance passphrase';
const peer = '0x2222222222222222222222222222222222222222';
function archive(wallet: string): RecoveryData {
  return { version: 1, source: 'chirpy', wallet, createdAt: 1, contacts: [{ address: peer, label: 'Imported label' }],
    notes: [{ id: 'imported-note', text: 'Imported note', sentAtMs: 1 }],
    preferences: { blocked: [peer], readReceiptsDefault: true, readReceiptOverrides: { 'xmtp:production:dm': true } } };
}
async function connect(page: Page) {
  await page.goto('/'); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  const button = page.getByRole('button', { name: 'Connect wallet', exact: true });
  if (await button.isVisible()) await button.click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
}
async function upload(page: Page, data: RecoveryData, pass = password) {
  const raw = await encryptRecoveryArchive(data, password);
  await page.getByLabel('Encrypted recovery file', { exact: true }).setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
  await page.getByLabel('Restore passphrase', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Unlock and review file', exact: true }).click();
}
async function review(page: Page, data: RecoveryData) {
  await upload(page, data); await page.getByRole('heading', { name: 'Review proposed changes' }).waitFor();
}
async function records(page: Page, wallet: string) {
  return page.evaluate(wallet => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets'); const store = tx.objectStore('wallets');
      const data = store.get(wallet.toLowerCase()); const journal = store.get(`restore:${wallet.toLowerCase()}`);
      tx.oncomplete = () => { db.close(); resolve({ data: data.result, journal: journal.result,
        prefs: localStorage.getItem(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`),
        marker: localStorage.getItem(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}:recovery-pending`) }); };
      tx.onabort = () => reject(tx.error);
    };
  }), wallet);
}
async function seed(page: Page, wallet: string, contacts: RecoveryData['contacts'], notes: RecoveryData['notes']) {
  await page.evaluate(({ wallet, contacts, notes }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('chat-local-data-v1', 1);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('wallets', 'readwrite');
      tx.objectStore('wallets').put({ wallet: wallet.toLowerCase(), version: 1, revision: 1, contacts, notes });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  }), { wallet, contacts, notes });
}
async function apply(page: Page) {
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed changes saved.' })).toBeVisible();
}

test('restores reviewed data without inferring receipt consent, retains a backup and supports undo', async ({ page, walletAddress }, testInfo) => {
  await connect(page); await review(page, archive(walletAddress));
  await expect(page.getByRole('checkbox', { name: /Apply receipt preferences/ })).not.toBeChecked();
  const decline = page.getByRole('button', { name: 'Decline', exact: true });
  if (await decline.isVisible()) await decline.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Review proposed changes' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('restore-review-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await apply(page);
  const after = await records(page, walletAddress);
  expect(after.data.notes).toEqual(archive(walletAddress).notes); expect(after.journal.phase).toBe('applied');
  expect(after.marker).toBeNull(); expect(after.journal.before.contacts).toEqual([]);
  expect(JSON.parse(after.prefs)).toMatchObject({ readReceiptsDefault: false, syncAcrossDevices: false, blocked: [] });
  await page.reload(); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Undo restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restore undone.' })).toBeVisible();
  const undone = await records(page, walletAddress);
  expect(undone.data.notes).toEqual([]); expect(undone.data.contacts).toEqual([]); expect(undone.journal.phase).toBe('undone');
  expect(JSON.parse(undone.prefs).syncAcrossDevices).toBe(false);
});

test('keeps conflicts by default, applies explicit replacements and exports the original backup', async ({ page, walletAddress }) => {
  await connect(page);
  const originalContact = { address: peer, label: 'Original label' };
  const originalNote = { id: 'imported-note', text: 'Original note', sentAtMs: 2 };
  await seed(page, walletAddress, [originalContact], [originalNote]);
  await review(page, archive(walletAddress));
  await expect(page.getByRole('button', { name: 'Apply reviewed changes', exact: true })).toBeDisabled();
  await page.locator('details').filter({ has: page.locator('summary', { hasText: peer }) }).locator('summary').first().click();
  await page.getByRole('checkbox', { name: 'Replace this existing value', exact: true }).check();
  await page.getByRole('checkbox', { name: /Apply receipt preferences/ }).check();
  await page.getByRole('checkbox', { name: /Add legacy blocked/ }).check();
  await apply(page);
  const state = await records(page, walletAddress);
  expect(state.data.contacts[0].label).toBe('Imported label'); expect(state.data.notes).toEqual([originalNote]);
  expect(JSON.parse(state.prefs)).toMatchObject({ readReceiptsDefault: true, blocked: [peer], syncAcrossDevices: false });
  await page.getByText('Save an encrypted copy of the pre-restore backup', { exact: true }).click();
  await page.getByLabel('Backup passphrase', { exact: true }).fill(password);
  await page.getByLabel('Confirm backup passphrase', { exact: true }).fill(password);
  const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download encrypted pre-restore backup' }).click();
  const download = await waiting; const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const backup = await decryptRecoveryArchive(Buffer.concat(chunks).toString('utf8'), password, walletAddress);
  expect(backup.contacts).toEqual([originalContact]); expect(backup.notes).toEqual([originalNote]);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Discard retained backup' }).click();
  await expect(page.getByRole('button', { name: 'Unlock and review file' })).toBeVisible();
  const final = await records(page, walletAddress); expect(final.journal).toBeUndefined(); expect(final.data).toEqual(state.data);
});

for (const failure of ['preferences', 'finalize']) test(`resumes after ${failure} failure without duplicates or false completion`, async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress));
  await page.evaluate(({ failure, wallet }) => {
    if (failure === 'preferences') {
      const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
        if (key === `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`) throw new DOMException('Full', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    } else {
      const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, ...args) {
        if (value?.phase === 'applied') throw new DOMException('Full', 'QuotaExceededError');
        return put.call(this, value, ...args);
      };
    }
  }, { failure, wallet: walletAddress });
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An unfinished restore' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed changes saved.' })).toHaveCount(0);
  const pending = await records(page, walletAddress); expect(pending.journal.phase).toBe('prepared'); expect(pending.marker).not.toBeNull();
  await page.reload(); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Resume unfinished restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed changes saved.' })).toBeVisible();
  const finished = await records(page, walletAddress); expect(finished.data.notes).toHaveLength(1);
  expect(finished.data.revision).toBe(pending.data.revision); expect(finished.marker).toBeNull(); expect(finished.journal.phase).toBe('applied');
});

test('refuses stale undo without locking or overwriting later edits', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress)); await apply(page);
  await seed(page, walletAddress, [], [{ id: 'later', text: 'Later edit', sentAtMs: 4 }]);
  const before = await records(page, walletAddress);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Undo restore', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  const after = await records(page, walletAddress); expect(after.data).toEqual(before.data); expect(after.marker).toBeNull();
  expect(after.journal).toEqual(before.journal);
});

test('rejects wrong wallets, damaged files and oversized files before storing a journal', async ({ page, walletAddress }) => {
  await connect(page); const before = await records(page, walletAddress);
  await upload(page, archive(peer));
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  await page.getByLabel('Encrypted recovery file', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.getByLabel('Restore passphrase', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock and review file' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  await page.getByLabel('Encrypted recovery file', { exact: true }).setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(MAX_RECOVERY_FILE_BYTES + 1) });
  await page.getByLabel('Restore passphrase', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock and review file' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  expect(await records(page, walletAddress)).toEqual(before);
});

test('two tabs cannot apply competing reviews over each other', async ({ browser }) => {
  const context = await browser.newContext(); const wallet = await injectSyntheticWallet(context, generatePrivateKey());
  const one = await context.newPage(); const two = await context.newPage();
  try {
    await connect(one); await connect(two); await review(one, archive(wallet));
    const second = archive(wallet); second.notes = [{ id: 'other', text: 'Other tab', sentAtMs: 1 }];
    await review(two, second);
    await Promise.all([one.getByRole('button', { name: 'Apply reviewed changes' }).click(), two.getByRole('button', { name: 'Apply reviewed changes' }).click()]);
    await expect.poll(async () => (await records(one, wallet)).journal?.phase).toBe('applied');
    const state = await records(one, wallet); expect(state.data.notes).toHaveLength(1);
    expect(state.journal.before.notes).toEqual([]); expect(state.journal.after.notes).toEqual(state.data.notes); expect(state.marker).toBeNull();
  } finally { await context.close(); }
});

test('cancels an apply queued behind another tab when the wallet disconnects', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress));
  const before = await records(page, walletAddress);
  await page.evaluate(wallet => new Promise<void>(resolve => {
    void navigator.locks.request(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}:write`, () => new Promise<void>(release => {
      (window as any).__releaseRecoveryLock = release; resolve();
    }));
  }), walletAddress);
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Checking recovery…' })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(() => (window as any).__releaseRecoveryLock());
  expect(await records(page, walletAddress)).toEqual(before);
});

test('preserves originals when the backup transaction cannot commit', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress)); const before = await records(page, walletAddress);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, ...args) {
      if (value?.phase === 'prepared') throw new DOMException('Full', 'QuotaExceededError');
      return put.call(this, value, ...args);
    };
  });
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  expect(await records(page, walletAddress)).toEqual(before);
});

test('resumes an interrupted undo without deleting later data or repeating revisions', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress)); await apply(page);
  await page.evaluate(wallet => {
    const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key === `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`) throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, walletAddress);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Undo restore', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An unfinished restore' })).toBeVisible();
  const partial = await records(page, walletAddress); expect(partial.journal.phase).toBe('undoing');
  await page.reload(); await page.locator('.nav-item', { hasText: 'Settings' }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Resume unfinished restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restore undone.' })).toBeVisible();
  const final = await records(page, walletAddress); expect(final.journal.phase).toBe('undone');
  expect(final.data.notes).toEqual([]); expect(final.data.revision).toBe(partial.data.revision); expect(final.marker).toBeNull();
});

test('can explicitly stop a conflicted pending restore while retaining current data and backup', async ({ page, walletAddress }) => {
  await connect(page); await review(page, archive(walletAddress));
  await page.evaluate(wallet => {
    const set = Storage.prototype.setItem; (window as any).__restoreSetItem = set;
    Storage.prototype.setItem = function(key, value) {
      if (key === `chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`) throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, walletAddress);
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An unfinished restore' })).toBeVisible();
  await page.evaluate(wallet => {
    Storage.prototype.setItem = (window as any).__restoreSetItem;
    localStorage.setItem(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}`, JSON.stringify({ readReceiptsDefault: false, readReceiptOverrides: {}, blocked: [], syncAcrossDevices: false, updatedAt: 999 }));
  }, walletAddress);
  const before = await records(page, walletAddress);
  await page.getByRole('button', { name: 'Resume unfinished restore' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Recovery could not be completed' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Keep current data and stop restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'import is not marked complete' })).toBeVisible();
  const after = await records(page, walletAddress);
  expect(after.data).toEqual(before.data); expect(after.prefs).toBe(before.prefs);
  expect(after.journal.before).toEqual(before.journal.before); expect(after.journal.phase).toBe('abandoned'); expect(after.marker).toBeNull();
});

const profileKey = (wallet: string) => `chat:walletProfile:v1:${wallet.toLowerCase()}`;
const nameChoice = (page: Page) => page.getByRole('checkbox', { name: 'Restore my private display-name choice on this device', exact: true });
async function setName(page: Page, wallet: string, value: string) {
  await page.getByLabel('Display name', { exact: true }).fill(value);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), profileKey(wallet))).toBe(JSON.stringify(value));
}
function nameArchive(wallet: string, localDisplayName: string | null): RecoveryData {
  return { ...archive(wallet), version: 2, localDisplayName, contacts: [], notes: [] };
}
for (const incoming of [null, '', 'Imported private name']) test(`reviews and restores private name ${JSON.stringify(incoming)} with exact backup and undo`, async ({ page, walletAddress }, testInfo) => {
  await connect(page); await setName(page, walletAddress, 'Original private name');
  let profileWrites = 0; page.on('request', req => { if (req.url().includes('/api/profile') && req.method() !== 'GET') profileWrites++; });
  await review(page, nameArchive(walletAddress, incoming));
  await expect(nameChoice(page)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Apply reviewed changes' })).toBeDisabled();
  await nameChoice(page).check();
  if (incoming === 'Imported private name') {
    const decline = page.getByRole('button', { name: 'Decline', exact: true }); if (await decline.isVisible()) await decline.click();
    await page.setViewportSize({width:390,height:844});await page.locator('.recovery-label-review').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('private-name-review-mobile.png')});
  }
  await apply(page);
  expect(await page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe(incoming === null ? null : JSON.stringify(incoming));
  const saved=await records(page,walletAddress);expect(saved.journal).toMatchObject({version:2,labelChange:{before:'"Original private name"',after:incoming===null?null:JSON.stringify(incoming)}});
  if (incoming !== null) await expect(page.getByLabel('Display name',{exact:true})).toHaveValue(incoming);
  if (incoming === 'Imported private name') {
    await page.getByText('Save an encrypted copy of the pre-restore backup',{exact:true}).click();
    await page.getByLabel('Backup passphrase',{exact:true}).fill(password);await page.getByLabel('Confirm backup passphrase',{exact:true}).fill(password);
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download encrypted pre-restore backup'}).click();
    const stream=await(await pending).createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));
    expect(await decryptRecoveryArchive(Buffer.concat(chunks).toString('utf8'),password,walletAddress)).toMatchObject({version:2,localDisplayName:'Original private name'});
  }
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Undo restore',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Restore undone.'})).toBeVisible();
  await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Original private name');
  expect(await page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe('"Original private name"');expect(profileWrites).toBe(0);
});

test('keeps the private name when importing legacy data or declining a v2 name choice', async ({page,walletAddress})=>{
  await connect(page);await setName(page,walletAddress,'Keep this name');
  await review(page,archive(walletAddress));await expect(nameChoice(page)).toHaveCount(0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await review(page,{...archive(walletAddress),version:2,localDisplayName:'Do not restore'});
  await expect(nameChoice(page)).not.toBeChecked();await apply(page);
  await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Keep this name');
  const state=await records(page,walletAddress);expect(state.journal.version).toBe(1);expect(state.journal).not.toHaveProperty('labelChange');
});

test('preserves a name changed in another tab after review and refuses stale undo', async ({browser})=>{
  const context=await browser.newContext();const walletAddress=await injectSyntheticWallet(context);const page=await context.newPage();
  try {
  await connect(page);await setName(page,walletAddress,'Original');await review(page,nameArchive(walletAddress,'Imported'));await nameChoice(page).check();
  const other=await context.newPage();await connect(other);await setName(other,walletAddress,'Later');
  await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Later');
  await page.getByRole('button',{name:'Apply reviewed changes'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Recovery could not be completed'})).toBeVisible();
  expect((await records(page,walletAddress)).journal).toBeUndefined();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await review(page,nameArchive(walletAddress,'Imported'));await nameChoice(page).check();await apply(page);
  await setName(other,walletAddress,'Later after restore');
  const before=await records(page,walletAddress);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Undo restore'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Recovery could not be completed'})).toBeVisible();
  expect(await records(page,walletAddress)).toEqual(before);await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Later after restore');
  } finally { await context.close(); }
});

test('resumes failed name storage and prevents edits while restoration is pending',async({page,walletAddress})=>{
  await connect(page);await setName(page,walletAddress,'Original');await review(page,nameArchive(walletAddress,'Imported'));await nameChoice(page).check();
  await page.evaluate(key=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Full','QuotaExceededError');return set.call(this,k,v);};},profileKey(walletAddress));
  await page.getByRole('button',{name:'Apply reviewed changes'}).click();
  await expect(page.getByRole('alert').filter({hasText:'An unfinished restore'})).toBeVisible();
  const partial=await records(page,walletAddress);expect(partial.journal.phase).toBe('prepared');
  await page.reload();await page.locator('.nav-item',{hasText:'Settings'}).click();
  await page.getByLabel('Display name',{exact:true}).fill('Cannot replace pending name');
  await expect(page.getByText('Your display name could not be saved.',{exact:false})).toBeVisible();
  expect(await page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe('"Original"');
  await page.getByRole('button',{name:'Resume unfinished restore'}).click();
  await expect(page.getByRole('status').filter({hasText:'Reviewed changes saved.'})).toBeVisible();
  await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Imported');
  const completed=await records(page,walletAddress);expect(completed.data.revision).toBe(partial.data.revision);expect(completed.marker).toBeNull();
});

test('a name edit queued behind a lock is cancelled when the wallet disconnects',async({page,walletAddress})=>{
  await connect(page);await setName(page,walletAddress,'Keep');
  await page.evaluate(wallet=>new Promise<void>(ready=>{void navigator.locks.request(`chat:settingsPrefs:v1:wallet:${wallet.toLowerCase()}:write`,()=>new Promise<void>(release=>{(window as any).__releaseNameLock=release;ready();}));}),walletAddress);
  await page.getByLabel('Display name',{exact:true}).fill('Do not save after disconnect');
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.evaluate(()=>(window as any).__releaseNameLock());
  await expect.poll(async()=>await page.evaluate(()=>navigator.locks.query().then(result=>result.pending.length+result.held.length))).toBe(0);
  expect(await page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe('"Keep"');
});

for (const original of [null, '']) test(`resumes name undo to original ${JSON.stringify(original)} without changing its meaning`,async({page,walletAddress})=>{
  await connect(page);
  if(original===''){await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('test.eth');await setName(page,walletAddress,'');}
  await review(page,nameArchive(walletAddress,'Imported'));await nameChoice(page).check();await apply(page);
  await page.evaluate(({key,remove})=>{
    if(remove){const fn=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k===key)throw new DOMException('Blocked','SecurityError');return fn.call(this,k);};}
    else{const fn=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Full','QuotaExceededError');return fn.call(this,k,v);};}
  },{key:profileKey(walletAddress),remove:original===null});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Undo restore'}).click();
  await expect(page.getByRole('alert').filter({hasText:'An unfinished restore'})).toBeVisible();
  const pending=await records(page,walletAddress);expect(pending.journal.phase).toBe('undoing');
  await page.reload();await page.locator('.nav-item',{hasText:'Settings'}).click();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Resume unfinished restore'}).click();
  await expect(page.getByRole('status').filter({hasText:'Restore undone.'})).toBeVisible();
  expect(await page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe(original===null?null:'""');
  await expect(page.getByLabel('Display name',{exact:true})).toHaveValue(original===null?'test.eth':'');
  const completed=await records(page,walletAddress);expect(completed.data.revision).toBe(pending.data.revision);expect(completed.marker).toBeNull();
});

test('keeps every character when typing a private name through coordinated saves',async({page,walletAddress})=>{
  await connect(page);const input=page.getByLabel('Display name',{exact:true});await expect(input).toHaveValue('test.eth');
  await input.fill('');await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe('""');
  await input.pressSequentially('Private name 123');
  await expect(input).toHaveValue('Private name 123');
  await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),profileKey(walletAddress))).toBe('"Private name 123"');
});
