const fs = require('fs').promises;
const { createDocumentHost, splitWrite } = require('../../src/main/document-host');
const { storePageState } = require('../../src/main/page-state-store');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');

const realGuard = require('../../src/main/data-loss-guard');
const guardStub = Object.fromEntries(Object.entries(realGuard).map(([key, value]) => [key, typeof value === 'function' ? () => {} : value]));

const noop = () => {};

// The save lane a checkpoint runs through, with the backup, sidecar, Tailwind and
// data-guard work reduced to the disk result each proof inspects.
function checkpointHost({ dir, authority, write = (filePath, bytes) => fs.writeFile(filePath, bytes), live = {} }) {
  return createDocumentHost({
    ctx: { localAuthority: authority },
    baseDir: dir,
    live: { markBrowserSave: noop, broadcast: noop, notify: noop, ...live },
    store: { etags: new Map(), snapshots: new Map() },
    resolveTailwindWrite: async (name) => `${dir}/.hyperclay/tailwindcss/${name}.css`,
    canonicalForWrite: (html) => html,
    formatHtml: (html) => html,
    scopeTailwindLink: (name, html) => html,
    stripSaveToken: (bytes) => bytes,
    splitWrite,
    storePageState,
    createBackup: async () => true,
    createBackupIfExists: async () => true,
    createBinaryBackupIfExists: async () => true,
    atomicWriteFile: write,
    assertWriteContext: noop,
    assertStructureContext: noop,
    stripCopyBytes: (bytes) => bytes,
    writePageState: async () => {},
    logicalDocument: async (baseDir, name, file) => file,
    writeApiSidecar: async () => {},
    refreshDerivedArtifacts: async () => {},
    getTailwindCssName: () => null,
    compileTailwind: async () => '',
    dataGuard: { ...guardStub, provenanceForLocalSave: () => 'ui-background', runDataLossGuard: async () => {} },
    documentEtag: () => null,
    rebaseStaleSave: async () => null,
    newestVersionFiles: async () => [],
    needsAdoption: () => false,
    roomsPackage: () => require('@panphora/clayjs/server/rooms'),
    withDocument: withDocumentWrite,
    loadCheckpoint: () => require('@panphora/clayjs/server/checkpoint'),
    emit: noop,
    logger: null,
    MAX_EXTERNAL_HTML: 12 * 1024 * 1024,
    VERSIONS_DIR: '.hyperclay/versions',
    TAILWIND_DIR: '.hyperclay/tailwindcss',
  });
}

module.exports = { checkpointHost };
