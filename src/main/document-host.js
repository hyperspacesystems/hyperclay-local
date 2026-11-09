const fs = require('fs').promises;
const { calculateChecksum } = require('../sync-engine/utils');
const path = require('upath');

const KINDS = {
  'browser-save': { lane: 'save', origin: 'save' },
  'data-api': { lane: 'save', origin: 'api' },
  checkpoint: { lane: 'save', origin: 'checkpoint' },
  restore: { lane: 'replace' },
  'guard-restore': { lane: 'replace' },
  'sync-download': { lane: 'exact' },
  'external-rebase': { lane: null },
  workspace: { lane: null },
  create: { lane: null },
};

const REQUIRED_DEPS = [
  'ctx', 'baseDir', 'live', 'store', 'resolveTailwindWrite',
  'canonicalForWrite', 'formatHtml', 'scopeTailwindLink', 'stripSaveToken', 'splitWrite',
  'storePageState', 'createBackup', 'atomicWriteFile', 'assertWriteContext',
  'writeApiSidecar', 'getTailwindCssName', 'compileTailwind', 'dataGuard', 'documentEtag',
  'rebaseStaleSave', 'newestVersionFiles', 'needsAdoption', 'roomsPackage',
  'MAX_EXTERNAL_HTML', 'VERSIONS_DIR', 'TAILWIND_DIR',
];

function refused(reason) {
  return { outcome: 'refused', reason, etag: null, stored: null, content: null };
}

function createDocumentHost(deps) {
  for (const name of REQUIRED_DEPS) {
    if (deps[name] === undefined) throw new TypeError(`createDocumentHost is missing ${name}`);
  }
  const {
    ctx, baseDir, live, resolveTailwindWrite,
    canonicalForWrite, formatHtml, scopeTailwindLink, stripSaveToken, splitWrite,
    storePageState, createBackup, atomicWriteFile, assertWriteContext,
    writeApiSidecar, getTailwindCssName, compileTailwind, documentEtag, roomsPackage, TAILWIND_DIR,
    store, rebaseStaleSave, newestVersionFiles, needsAdoption, dataGuard, MAX_EXTERNAL_HTML, VERSIONS_DIR,
  } = deps;

  async function placeBytes({ name, filePath, logical, durable, beforeRename }) {
    const stored = await storePageState(baseDir, name, logical, durable);
    try {
      await atomicWriteFile(filePath, stored, 'utf8', beforeRename, durable);
    } catch (error) {
      if (error && error.afterRename) error.indeterminate = true;
      throw error;
    }
    live.markBrowserSave(name);
    return stored;
  }

  async function refreshTailwind(content, { quiet = false } = {}) {
    const tailwindName = getTailwindCssName(content);
    if (!tailwindName) return;
    try {
      const css = await compileTailwind(content);
      const cssPath = await resolveTailwindWrite(tailwindName);
      await atomicWriteFile(cssPath, css);
      if (!quiet) console.log(`Generated Tailwind CSS: ${TAILWIND_DIR}/${tailwindName}.css`);
    } catch (e) {
      if (!quiet) console.error('compileTailwind failed (non-fatal):', e && e.message ? e.message : e);
    }
  }

  async function read(name, filePath) {
    let bytes;
    try {
      bytes = await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return { bytes, checksum: await calculateChecksum(bytes) };
  }

  async function preconditionFailed(request) {
    const { expected } = request;
    if (!expected || expected.type === 'any') return false;
    const current = await read(request.name, request.context?.target?.canonicalPath ?? request.filePath);
    if (expected.type === 'absent') return current !== null;
    if (expected.type === 'checksum') return current === null || current.checksum !== expected.value;
    throw new TypeError(`Unknown expected type: ${expected.type}`);
  }

  async function commitExact({ name, filePath, bytes, modifiedAt = null, pageRecord = null }) {
    if (modifiedAt !== null || pageRecord !== null) {
      throw new Error('sync-download modifiedAt and pageRecord are not migrated yet');
    }
    await atomicWriteFile(filePath, bytes, Buffer.isBuffer(bytes) ? null : 'utf8');
    live.markBrowserSave(name);
    return { outcome: 'committed', reason: null, etag: null, stored: bytes, content: bytes };
  }

  // The one publish sequence for a write this app makes to a live document — the
  // data-loss guard's writeBack and F1's restore both call it, so the two cannot
  // drift. Format as the save path does, version the new bytes, write atomically,
  // mark the write as ours so the watcher does not re-run the guard on it, morph
  // view-mode tabs, then refresh everything derived from the bytes. Non-fatal on
  // the derived artifacts, for the same reason the save route is: the document is
  // already written, backed up and broadcast by that point.
  // Returns the composed document, which is what the stamp describes.
  async function commitReplace({ name, filePath: requestedPath, bytes, edit = false, context = {}, hooks = {} }) {
    const { target = null, token = null } = context;
    const { beforeWrite = null } = hooks;
    let filePath = requestedPath;
    // Response-scoped root metadata (a save token, this host's own documentetag)
    // comes back from clients and from a stored version, and none of it belongs in
    // the bytes this writes: stripped here, once, so the data-loss writeBack and the
    // restore route cannot each forget it.
    const html = canonicalForWrite(stripSaveToken(bytes));
    const backupName = name.replace(/\.(html|htmlclay)$/, '');
    const formatted = formatHtml(scopeTailwindLink(name, html));
    const write = await splitWrite(baseDir, name, formatted);
    const content = write.logical;
    // An already owned helper: a caller arrives inside runDocumentWrite's boundary,
    // so this claims nothing and locks nothing of its own. With an authority it
    // proves that boundary and writes the path that boundary admitted.
    const authority = ctx.localAuthority;
    const authorityWrite = Boolean(authority && target && token);
    if (authorityWrite) {
      assertWriteContext(token, target.canonicalPath);
      filePath = target.canonicalPath;
    }
    let pageToken = null;
    let stored;
    try {
      if (authorityWrite && !edit) {
        // Explicit replacement admission, before the first backup, and held across
        // the backup and the atomic write: no frame can change the room while the
        // disk result is pending. An edit of the page (a restore stamped with the
        // record's rev) continues the room instead of replacing it, so it reserves
        // nothing and the open tabs merge the result.
        pageToken = authority.rooms.reservePageReplacement(filePath, {
          nodeId: target.identity,
          html: content,
        });
      }
      if (beforeWrite && await beforeWrite() === false) return refused('declined');
      await createBackup(baseDir, backupName, write.file);
      stored = await placeBytes({ name, filePath, logical: content });
      if (authorityWrite) {
        // The bytes are on disk: the reservation commits into the one room and the
        // authority stamps and publishes exactly what landed, once per registered
        // alias of this canonical file. That is why the old single-root broadcast
        // below is the no-authority path only.
        if (pageToken) authority.rooms.commitPage(pageToken);
        await authority.confirmKnownWrite(target, content, token, { sender: 'server-save' });
      } else {
        // Morph view-mode tabs with the persisted on-disk HTML.
        live.broadcast(name, { html: roomsPackage().splitPage(content).file, sender: 'server-save' }, { lane: 'saved' });
      }
    } finally {
      if (pageToken) authority.rooms.releasePage(pageToken);
    }
    try { await writeApiSidecar(baseDir, name, content); } catch {}
    await refreshTailwind(content, { quiet: true });
    return { outcome: 'committed', reason: null, etag: documentEtag(content), stored, content };
  }

  async function commitSave(request, { origin }) {
    const {
      name, filePath, bytes, dataLossPrev, userDriven, saveId,
      ifMatch, pageConversion, pageWrite, pageFormat,
      persistentToken = null, readIdentity = null, context = {}, hooks = {},
    } = request;
    const { target = null, token = null } = context;
    const { answer = null } = hooks;
    let content = bytes;
    // ANCILLARY DISK CONVENTION: versions dir and backups use baseName without
    // extension (matches platform's versions/{baseName}/ layout).
    // Do NOT reuse `backupName` as a liveSync channel key — liveSync keys must
    // carry the extension (Rule 1).
    const backupName = name.replace(/\.(html|htmlclay)$/, '');

    // Normalized once, and before anything is admitted or backed up: the page
    // admission below has to decide against the exact bytes this call would
    // store, and a refusal must leave no backup and no written byte behind.
    content = canonicalForWrite(formatHtml(scopeTailwindLink(name, content)));

    // The logical document keeps the page editor's merge state and is what every
    // admission, stamp, broadcast and answer below describes. Only the file part
    // reaches disk, with that state kept in its sidecar. Composing the two back
    // together makes `content` exactly what a later read of this save composes,
    // so the stamp returned here is the one the next If-Match is judged against.
    //
    // A client that never held the state — the code editor is sent the clean
    // file — saves the document without it. It is still the same document, so
    // the state its sidecar holds is put back here too. A page conversion is the
    // one save where the absence is the point, so that one is never put back.
    if (!pageConversion) {
      const rebased = await rebaseStaleSave(baseDir, name, content, newestVersionFiles);
      if (rebased) content = rebased.html;
    }
    const write = await splitWrite(baseDir, name, content, { keepState: !pageConversion });
    let fileContent = write.file;
    content = write.logical;
    // A caller that has to hand a client the document it can safely edit asks for
    // the file part here: the composed form above carries merge state that belongs
    // in the sidecar, never in a buffer somebody types into.
    if (answer) answer.html = fileContent;

    const authority = ctx.localAuthority;
    const authorityWrite = Boolean(authority && target && token);
    let pageToken = null;
    try {
      if (authorityWrite) {
        // The shared rooms package owns page authority: an initialization or a
        // conversion is admitted here, before the first backup, and its
        // reservation is held across the backup and the atomic write so no
        // frame can change the room while the disk result is pending.
        const { checkPageWriteAdmission, pageLineageLost, checkPageFormatAdmission, formatCapability, withPageFormatFloor, PAGE_FORMAT, PAGE_FORMAT_UPGRADE } = require('@panphora/clayjs/server/rooms');
        const { createDocument } = require('./page-rebase.js');
        const rooms = authority.rooms;
        const open = rooms.get(filePath);
        const room = open && String(open.nodeId) === String(target.identity) ? open : null;
        const currentHtml = dataLossPrev ?? '';
        const admission = checkPageWriteAdmission({
          currentHtml, html: content, header: pageConversion ?? null, ifMatch, room,
          pageWrite: pageWrite ?? null, createDocument,
        });
        const capability = origin === 'checkpoint' ? PAGE_FORMAT : formatCapability(pageFormat);
        const admitted = authority.admittedFormats(filePath);
        const format = checkPageFormatAdmission({ currentHtml, html: content, capability, admitted });
        content = format.html;
        fileContent = withPageFormatFloor(fileContent, format.floor);
        if (answer) answer.html = fileContent;
        if (admission === 'initial') {
          pageToken = rooms.reservePageInitial(filePath, {
            nodeId: target.identity, currentHtml, html: content, ifMatch,
            pageWrite: pageWrite ?? null, createDocument,
          });
        } else if (admission === 'conversion') {
          pageToken = rooms.reservePage(filePath, {
            nodeId: target.identity, header: pageConversion, currentHtml, html: content, ifMatch,
            pageWrite: pageWrite ?? null, createDocument,
          });
        } else if (admission === 'ordinary' && room && pageLineageLost(room, content)) {
          // The open room still holds the article this save replaces, and the
          // document being written no longer carries the page tag that bound them:
          // an outside edit or a code save replaced the page under it. Restore's
          // pattern, applied here: the room's unsaved edits become a version of
          // their own, and the room restarts on the new document instead of
          // keeping the old page store, which its next checkpoint would render
          // back over the replacement. A room whose edits cannot be kept is
          // refused, so the person can save them rather than lose them.
          if (authority.roomIsDirty(room)) {
            let kept = null;
            try {
              kept = ctx.localCheckpoint
                ? await ctx.localCheckpoint.safetyBackup(filePath, currentHtml)
                : null;
            } catch (error) {
              console.error(`Refusing a save of ${name}: the open room cannot be backed up`, error);
            }
            if (kept === null) {
              const error = new Error('Unsaved edits could not be kept. Save them before replacing this page.');
              error.code = 'unsaved-edits';
              throw error;
            }
            if (!(await createBackup(baseDir, backupName, kept))) {
              const error = new Error('Unsaved edits could not be kept. Save them before replacing this page.');
              error.code = 'unsaved-edits';
              throw error;
            }
          }
          pageToken = rooms.reservePageReplacement(filePath, {
            nodeId: target.identity, html: content,
          });
        }
        if (persistentToken) rooms.checkPersistent(persistentToken, { html: content });
        // An outside edit the room keeps (same revision or merged onto an older
        // one) waits for a tab to adopt it, and until then the room's unsaved
        // edits live only in memory: they get a recovered copy, rendered over
        // the document this write replaces.
        if (room && origin !== 'checkpoint' && !pageToken && content.includes('data-page') && needsAdoption(content)) {
          await authority.recoverUnsavedEdits(target, token);
        }
      }

      // Check if this is the first save (no versions exist yet)
      const siteVersionsDir = path.join(baseDir, VERSIONS_DIR, backupName);
      let isFirstSave = false;
      try {
        const versionFiles = await fs.readdir(siteVersionsDir);
        isFirstSave = versionFiles.length === 0;
      } catch (error) {
        // Directory doesn't exist yet, so this is the first save
        isFirstSave = true;
      }

      // The bytes already on disk, read once: the first-save backup stores their
      // file part, and a save that changed only the merge state leaves them alone.
      let existingContent = null;
      try {
        existingContent = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        // File doesn't exist yet, that's OK
      }

      // If first save, backup the existing site content first
      if (isFirstSave && existingContent !== null) {
        try {
          await createBackup(baseDir, backupName, roomsPackage().splitPage(existingContent).file);
          console.log(`Created initial backup of existing ${name}`);
        } catch (error) {
          // File doesn't exist yet, that's OK
        }
      }

      // Create backup of the new content. A save that changed only the merge
      // state leaves the file unchanged, so it writes no new version.
      if (existingContent !== fileContent) await createBackup(baseDir, backupName, fileContent);

      // Write via temp + rename: a crash or a full disk can never leave the
      // served file holding partial bytes.
      const beforeRename = readIdentity ? async () => {
        const current = await fs.stat(filePath, { bigint: true }).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!current || ['dev', 'ino', 'size', 'mtimeNs'].some(name => current[name] !== readIdentity[name])) {
          const error = new Error('Checkpoint target changed since it was read');
          error.code = 'moved-or-deleted';
          throw error;
        }
      } : null;
      // The sidecar lands before the file, and only the file part reaches disk.
      // A checkpoint is the write ClayJS is told contains a person's edits, so it
      // is the one write that must fail rather than report a rename the disk may
      // not keep.
      const durable = origin === 'checkpoint' ? { durable: true } : undefined;
      const stored = await placeBytes({ name, filePath, logical: content, durable, beforeRename });

      // Recorded from the bytes actually written, so a later conflict can tell a
      // second tab of this person's from a text editor. Set after the write, since
      // before it this would claim authorship of a save that then failed.
      // Keyed on the canonical filePath, the same key the write queue uses, so two
      // spellings of one file (an in-tree symlink, or a case-insensitive volume) can
      // never keep two separate records of who last wrote it.
      //
      // The mtime rides along with the stamp because the stamp alone cannot answer
      // the question. A file can go B -> C -> B, and once it is back at B the digest
      // matches this host's last write again, so an external editor's undo reads
      // exactly like another of this person's tabs. The mtime moved for both of those
      // writes and does not come back.
      const wroteAt = await fs.stat(filePath, { bigint: true }).catch(() => null);
      store.etags.set(filePath, {
        etag: documentEtag(content),
        mtimeNs: wroteAt ? wroteAt.mtimeNs : null,
        // Who wrote these bytes: 'save' for a tab, 'api' for a write with no tab
        // behind it. /save reads it to decide whether a conflicting stamp is
        // honestly another tab's, because a data API write is nobody's tab.
        writer: origin,
        // §6's receipt, bound here and nowhere else: this is the one moment this
        // host knows both which request's body it stored and what those stored
        // bytes stamp to. An id-less save records '' and so replaces any id
        // remembered from an earlier one, which is what keeps a remembered id from
        // outliving its own bytes when a later save happens to restore them.
        saveId
      });

      // The bytes are on disk: the page reservation commits into the one room,
      // and the authority stamps and publishes exactly what landed, once per
      // registered alias of this canonical file.
      if (pageToken) authority.rooms.commitPage(pageToken);
      if (authorityWrite) {
        await authority.confirmKnownWrite(target, content, token, {
          sender: origin === 'api' ? 'data-api' : 'server-save', persistentToken,
        });
      }

      // Morph view-mode tabs with the persisted on-disk HTML. Edit-mode tabs
      // are untouched — they sync via /live-sync/save on the live lane.
      //
      // A data API write has no tab behind it to relay its snapshot, so it has to
      // reach edit-mode tabs the way an external disk change does: the same
      // `external-change` notify the observer's _notifyExternal sends, so ClayJS
      // runs it through dirty-region protection before morphing. The saved-lane
      // broadcast stays, for the viewers. Same payload as the observer, different
      // sender — the writer here is the data API, not the file system.
      //
      // With an authority the saved lane is already published, once per alias, by
      // the confirmation above; this route is still its own publisher for a
      // no-authority caller, which is every legacy createApp(dir).
      const adopt = origin !== 'checkpoint' && content.includes('data-page') && needsAdoption(content);
      if (adopt) {
        ctx.observer?.publishExternal(
          name,
          Buffer.from(content, 'utf8'),
          `${path.basename(name)} was changed outside the editor`,
          { saved: false, continues: true }
        );
      }
      if (origin === 'api' && !adopt) {
        live.notify(name, {
          msgType: 'warning',
          msg: `${path.basename(name)} was updated through the data API`,
          action: 'reload',
          data: Buffer.byteLength(fileContent, 'utf8') <= MAX_EXTERNAL_HTML
            ? { kind: 'external-change', html: fileContent, sender: 'data-api', etag: documentEtag(content) }
            : { kind: 'external-change', sender: 'data-api' },
        });
      }
      if (!authorityWrite) {
        live.broadcast(name, { html: fileContent, sender: origin === 'api' ? 'data-api' : 'server-save' }, { lane: 'saved' });
      }
      // Refresh the per-site API data sidecar BEFORE the fallible Tailwind compile,
      // so a Tailwind failure can't skip it and leave stale API data on disk
      // (mirrors the platform ordering in node-content.js). Non-fatal: a sidecar
      // error must never fail the save.
      try {
        await writeApiSidecar(baseDir, name, content);
      } catch (e) {
        console.error('writeApiSidecar failed (non-fatal):', e && e.message ? e.message : e);
      }

      // Data-clobber guard (non-blocking, non-fatal). A browser /save is always
      // a UI save, split by the userDriven bit into ui-gestured / ui-background.
      // A data API write has no tab behind it at all, so it is judged as an
      // external edit, exactly like a write the watcher saw on disk.
      {
        const dataLossProv = origin === 'api' ? 'external' : dataGuard.provenanceForLocalSave(userDriven);
        dataGuard.runDataLossGuard({
          baseDir, name, newHtml: content, prevContent: dataLossPrev, prov: dataLossProv, live,
        }).catch(err => console.error('[data-guard] /save guard error:', err && err.message ? err.message : err));
      }

      // Generate Tailwind CSS if site uses it. `tailwindName` from
      // getTailwindCssName includes any path prefix present in the URL
      // (e.g. "blog/post"), so path.join naturally nests the CSS file. After
      // the replaceTailwindLink above, the URL is always scoped to the site's
      // folder, which mirrors the platform's
      // public-assets/tailwindcss/{username}/{path}/{baseName}.css layout.
      // Non-fatal, for the same reason as the sidecar above and the two remote
      // writers: the file is already written, backed up and broadcast by this
      // point, so a compiler error must not report the save as failed, and must
      // not skip the snapshot cache below.
      await refreshTailwind(content);

      // Record the provenance bit for platform sync. The sync engine reads it
      // when uploading, so the platform guard can split a UI save from a
      // background-script save. The snapshot beside it comes from
      // /live-sync/save, which is why this merges rather than replaces: the two
      // lanes contribute different halves of the same entry.
      {
        const prev = store.snapshots.get(name);
        store.snapshots.set(name, {
          html: prev ? prev.html : null,
          userDriven,
          timestamp: Date.now()
        });
      }
      return { outcome: 'committed', reason: null, etag: documentEtag(content), stored, content };
    } finally {
      if (pageToken) authority.rooms.releasePage(pageToken);
    }
  }

  const LANES = {
    exact: commitExact,
    replace: commitReplace,
    save: commitSave,
  };

  async function commit(request) {
    if (!request || !Object.hasOwn(KINDS, request.kind)) {
      throw new TypeError(`Unknown document write kind: ${request && request.kind}`);
    }
    const policy = KINDS[request.kind];
    const lane = LANES[policy.lane];
    if (!lane) throw new Error(`Document write kind ${request.kind} is not migrated yet`);
    if (await preconditionFailed(request)) return refused('changed');
    try {
      return await lane(request, policy);
    } catch (error) {
      if (error && error.indeterminate) {
        return { outcome: 'indeterminate', reason: null, etag: null, stored: null, content: null, error };
      }
      throw error;
    }
  }

  return { commit, read };
}

module.exports = { createDocumentHost };
