import { DEVELOPMENT, appUrl } from './runtime/environment.mjs';
import { withRuntime } from './runtime/runtime.mjs';
import { request, withDevice } from './device/transport.mjs';
import { readDesfire } from './device/desfire-reader.mjs';
import { applyHfDefaults, needsHfDefaults, hfDocument, blankNfcv } from './documents/hf-image.mjs';
import { readHf, scanNfc } from './device/hf-reader.mjs';
import { ask, download } from './ui/dialogs.mjs';
import { scanLf } from './device/lf-reader.mjs';
import { inspectLfChip } from './device/lf-program.mjs';
import { blankLf } from './documents/lf.mjs';
import { readType2 } from './device/type2-reader.mjs';
import { inspectClassic } from './device/classic-inspect.mjs';
import { runAutoPwn } from './recovery/autopwn.mjs';
import { Device, hex } from './device/device.mjs';
import {
  copyToTag,
  changeTagUid,
  writeClassicChanges,
  writeType2Changes,
  maintainTag
} from './ui/tag-write.mjs';
import { classicReadSnapshot } from './documents/classic-write.mjs';
import { classicDictionaryKeys } from './documents/classic-document-keys.mjs';
import { $, BLE_PAUSED_TYPES, deviceViews } from './ui/device-view.mjs';
import { offlineView } from './ui/offline.mjs';
import { rememberedKeysView } from './ui/remembered-keys.mjs';
import { decodeSlot } from './device/slots.mjs';
import {
  blankClassic,
  blankType2,
  classicSelector,
  exportNfc,
  importNfc,
  exportMct,
  importMct,
  inspectMct,
  parseHex,
  restoreDraft,
  serializeDraft,
  applyType2Defaults,
  needsType2Defaults
} from './documents/workspace.mjs';
import { SlotDevice } from './device/slots.mjs';
import { slotView } from './ui/slots.mjs';
import { studioView, hfDetails } from './ui/studio.mjs';
import { createView } from './ui/create.mjs';
import { writeSt25tb } from './ui/st25tb-write.mjs';
import {
  be32,
  decodeSlotImage,
  encodeSlotImage,
  family,
  nickname,
  typeName
} from './documents/slot-image.mjs';

const state = {
  document: null,
  controller: null,
  connected: false,
  deviceInfo: null,
  transport: null,
  cleanDocument: null
};
let toastTimer;
let draftTimer;
let activeView;
const rememberedKeys = rememberedKeysView();
const {
  controls: studioControls,
  render,
  renderMemory,
  isDirty,
  isEmulating,
  renderDocumentKeys,
  clearFeedback,
  startReadTime,
  finishReadTime
} = studioView(state, {
  saveDraft,
  renderRecents,
  onLfFormat: newLfDocument
});
const recents = [];
let slotImportTarget;
let pendingMct;
let scanTechnology = 'nfc';
const DRAFT = 'chameleon-studio-v1';
const DICTIONARY = 'chameleon-dictionary-v1';
// NXP ICODE SLIX-L privacy password used by every Toniebox figure, in RF order.
const TONIE_PRIVACY_PASSWORD = [0x7f, 0xfd, 0x6e, 0x5b];
// Keep retrying the unlock so the figure can just be held against the antenna.
const TONIE_SCAN_ATTEMPTS = 100;
const TONIE_SCAN_INTERVAL_MS = 150;

function controls() {
  studioControls();
  rememberedKeys.setBusy(!!state.controller);
}

/** @param {{ label: string, run: () => unknown }} [action] One follow-up the message offers. */
function notify(message, error = false, action) {
  clearTimeout(toastTimer);
  const toast = $('toast');
  toast.replaceChildren(message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.onclick = () => {
      hideToast();
      action.run();
    };
    toast.append(button);
  }
  toast.className = `toast visible${error ? ' error' : ''}${action ? ' actionable' : ''}`;
  toastTimer = setTimeout(hideToast, action ? 10000 : 5000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').classList.remove('visible');
  // A hidden toast must not leave a focusable action behind.
  $('toast').querySelector('.toast-action')?.remove();
}

const views = deviceViews({
  notify,
  canConnect: () => !state.controller,
  async onFirmwareUpdate(transport, beforeDfu) {
    let unverified = false;
    await physicalTask(async (signal) => {
      const { bleFirmwareUpdate } = await import(appUrl('ble-update.mjs'));
      unverified = await bleFirmwareUpdate({
        transport,
        signal,
        beforeDfu,
        // The update owns the device until it closes: verification reconnects inside it.
        reconnect: (signal) => views.connect(true, signal)
      });
    });
    if (unverified) {
      notify('Update transferred. Reconnect Bluetooth to verify the firmware.', false, {
        label: 'Reconnect',
        run: views.connect
      });
    }
  },
  open: () => view('device'),
  onConnection(value, info, detail) {
    state.connected = value;
    state.deviceInfo = info;
    state.transport = value ? detail : null;
    if (!value && detail !== 'error') {
      slots.disconnected();
    }
    controls();
  }
});

const offline = offlineView(() => !!state.controller);

const slots = slotView({
  run: workspaceTask,
  open: openSlot,
  add: addSlot,
  notify,
  afterChange: () => views.refresh()
});

const creation = createView(newDocument, () => state.controller?.abort());

function view(name) {
  if (!['scan', 'studio', 'slots', 'device'].includes(name)) {
    name = 'scan';
  }
  if (activeView !== name) {
    window.scrollTo(0, 0);
    activeView = name;
  }
  document.querySelectorAll('[data-view]').forEach((section) => {
    section.hidden = section.dataset.view !== name;
  });
  document.querySelectorAll('nav .nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.viewTarget === name);
    if (button.dataset.viewTarget === name) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });

  const hash = name === 'scan' ? '' : `#${name}`;
  if (location.hash !== hash) {
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }
  if (name === 'device') {
    views.refresh();
    offline.refresh();
    rememberedKeys.refresh();
  }
  if (name === 'slots') {
    // Without a device, the Slots page explains how to connect instead.
    slots.refresh().catch((error) => state.connected && notify(error.message, true));
  }
}

function rememberDocument() {
  if (!state.document) {
    return;
  }

  const snapshot = serializeDraft(state.document);
  const index = recents.findIndex((entry) => entry.snapshot === snapshot);
  if (index >= 0) {
    recents.splice(index, 1);
  }
  recents.unshift({ name: state.document.name, snapshot });
  recents.splice(6);
}

function renderRecents() {
  $('recents-section').hidden = !recents.length;
  $('recents').replaceChildren(
    ...recents.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent';

      const text = document.createElement('span');
      const name = document.createElement('strong');
      const hint = document.createElement('small');
      name.textContent = entry.name;
      hint.textContent = 'Draft copy · open in Studio';
      text.append(name, hint);
      button.append(text);

      button.onclick = () =>
        workspaceTask(async (signal) => {
          const next = await restoreDraft(entry.snapshot, signal);
          if (!next) {
            throw new Error('This recent document could not be restored');
          }
          openDocument(next, 'Recent draft opened · device slots are unchanged');
        });

      return button;
    })
  );
}

function openDocument(next, message) {
  rememberDocument();
  state.document = next;
  clearFeedback();
  markClean();
  render();
  saveDraft();
  view('studio');
  $('status').textContent = message;
}

function markClean() {
  state.cleanDocument = state.document ? serializeDraft(state.document) : null;
}

function saveDraft() {
  if (draftTimer) {
    return;
  }
  draftTimer = setTimeout(persistDraft, 250);
}

function persistDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;

  try {
    if (state.document) {
      localStorage.setItem(
        DRAFT,
        JSON.stringify({ ...JSON.parse(serializeDraft(state.document)), cleanDocument: state.cleanDocument })
      );
      if (!state.document.slot) {
        $('studio-target').textContent = 'Draft · saved in this browser';
      }
    }
  } catch {
    $('studio-target').textContent = 'Draft · browser storage unavailable';
  }
}

async function restoreBrowserDraft(signal) {
  try {
    const saved = localStorage.getItem(DRAFT);
    const stored = JSON.parse(saved || 'null');
    state.document = await restoreDraft(saved, signal);
    if (state.document) {
      $('status').textContent = state.document.warnings?.length
        ? state.document.warnings.join(' · ')
        : 'Restored browser draft · device state has not been changed';
    }
    state.cleanDocument = state.document ? serializeDraft(state.document) : null;
    if (state.document && stored?.cleanDocument) {
      // Restore adds defaults and normalizes card fields. Compare both snapshots
      // in that same form, retaining edits made before a reload.
      const baseline = stored.cleanDocument;
      const clean =
        stored.document && serializeDraft(stored.document) === baseline
          ? state.document
          : await restoreDraft(baseline, signal);
      state.cleanDocument = clean ? serializeDraft(clean) : baseline;
    }
    render();
  } catch {
    notify('The browser draft could not be restored.', true);
  }
}

window.addEventListener('pagehide', () => {
  offline.pause();
  persistDraft();
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    offline.start();
  }
});

function updateClassic(next) {
  if (!state.document) {
    return;
  }
  if (next.card) {
    state.document.card = next.card;
  }
  if (next.geometry) {
    state.document.geometry = next.geometry;
    state.document.kind = 'classic';
    state.document.unitBytes = 16;
    state.document.type = { 20: 1000, 64: 1001, 128: 1002, 256: 1003 }[next.geometry.blocks];
    state.document.emulator = undefined;
    $('studio-family').textContent = next.geometry.name;
  }
  if (next.summary) {
    state.document.recoveredKeys = next.summary.mapping;
    renderDocumentKeys();
    saveDraft();
  }

  const memoryChanged =
    next.memory?.length &&
    (next.memory.length !== state.document.memory.length ||
      next.memory.some((bytes, blockIndex) => {
        const previous = state.document.memory[blockIndex];
        if (!bytes) {
          return previous !== null;
        }

        return !previous || bytes.some((byte, byteIndex) => byte !== previous[byteIndex]);
      }));
  if (memoryChanged) {
    state.document.memory = next.memory.map((block) => (block ? [...block] : null));
    renderMemory();
    saveDraft();
  }
  if (next.phase) {
    $('status').textContent = next.phase;
  }
  controls();
}

async function canReplace(closing = false) {
  if (state.controller) {
    return false;
  }
  if (!isDirty()) {
    return true;
  }
  return (
    (await ask({
      title: closing ? 'Close this document?' : 'Replace the open document?',
      message: closing
        ? 'Export your changes first to keep a separate copy. This document will remain in Recent for this session.'
        : 'Export it first if you want to keep a separate copy.',
      confirmLabel: closing ? 'Close document' : 'Replace'
    })) && !state.controller
  );
}

async function workspaceTask(work) {
  if (state.controller) {
    return;
  }

  clearFeedback();
  state.controller = new AbortController();
  offline.pause();
  controls();

  try {
    await work(state.controller.signal);
  } catch (error) {
    if (!state.controller.signal.aborted) {
      notify(error.message, true);
    } else {
      $('status').textContent =
        'Stopped · completed device transactions are kept; refresh slots before retrying a save';
    }
  } finally {
    state.controller = null;
    offline.start();
    controls();
  }
}

async function physicalTask(work) {
  if (state.controller) {
    return;
  }

  clearFeedback();
  state.controller = new AbortController();
  offline.pause();
  controls();

  try {
    await work(state.controller.signal);
  } catch (error) {
    $('status').textContent = error.message;
    notify(error.message, true);
  } finally {
    state.controller = null;
    offline.start();
    renderDocumentKeys();
    saveDraft();
    controls();
  }
}

function reportStatus(message) {
  $('status').textContent = message;
}

$('copy-tag').onclick = () =>
  physicalTask(async (signal) => {
    const source = state.document;
    const written = await copyToTag(source, signal, reportStatus);
    if (source.kind === 'lf' && written !== undefined) {
      notify(written ? 'RFID programmed and verified' : 'Tag already matches');
    }
  });

$('write-changes').onclick = () =>
  physicalTask(async (signal) => {
    const st25tb = state.document.kind === 'st25tb';
    let write = writeClassicChanges;
    if (st25tb) {
      write = writeSt25tb;
    } else if (state.document.kind === 'type2') {
      write = writeType2Changes;
    }
    try {
      const written = await write(state.document, signal, reportStatus);
      if (written) {
        notify('Changes written and verified');
      } else if (written === false) {
        notify('Tag already matches');
      }
    } finally {
      if (st25tb) {
        render();
      }
    }
  });

async function maintain(format, signal) {
  const source = state.document;
  const clean = !isDirty();
  try {
    if (await maintainTag(format, source, signal, reportStatus)) {
      notify(format ? 'Factory format verified' : 'Repair verified');
    }
  } finally {
    // Invalidating physical credentials is not an edit to the open document.
    if (clean && state.document === source) {
      markClean();
    }
  }
}

$('repair-tag').onclick = () => physicalTask((signal) => maintain(false, signal));
$('format-tag').onclick = () => physicalTask((signal) => maintain(true, signal));
$('scan-repair').onclick = () => {
  closeScanDialog();
  physicalTask((signal) => maintain(false, signal));
};

$('change-uid').onclick = () =>
  physicalTask((signal) =>
    changeTagUid(
      signal,
      (message) => {
        reportStatus(message);
        if (message.startsWith('UID changed')) {
          notify(message);
        }
      },
      state.document
    )
  );

async function openSlot(index, sense, place) {
  if (state.controller) {
    return;
  }
  if (
    state.document?.slot?.index === index &&
    state.document.slot.sense === sense &&
    state.document.slot.revision === place.revision
  ) {
    view('studio');
    return;
  }
  if (!(await canReplace())) {
    return;
  }
  await workspaceTask(async (signal) => {
    const device = new SlotDevice(signal);
    await withDevice(device, async () => {
      await device.begin();
      const document = await device.load(index, sense, place.name || typeName(place.type), place.revision);
      if (document.kind === 'classic') {
        document.geometry = await withRuntime(
          (call) => call({ op: 'classic_geometry', sak: classicSelector(document) }),
          signal
        );
      }
      document.slot = { index, sense, enabled: place.enabled, revision: document.revision };
      openDocument(document, 'Loaded from slot · edits remain in Studio until saved');
    });
  });
}

function addSlot(slot, sense) {
  if (state.controller) {
    return;
  }
  slotImportTarget = { slot, sense };
  $('dump-file').click();
}

async function saveToSlot(activate = false) {
  if (!state.document || state.controller || (activate && isEmulating())) {
    return;
  }
  await workspaceTask(async (signal) => {
    const sense = state.document.kind === 'lf' ? 1 : 2;
    let selected;
    if (state.document.slot?.sense === sense) {
      selected = await slots.choose(sense, state.document.slot.index);
    } else {
      selected = await slots.choose(sense);
    }
    if (!selected) {
      return;
    }
    if (
      !state.document.slot &&
      selected.place.type &&
      !(await ask({
        title: `Replace slot ${selected.slot + 1} ${sense === 2 ? 'NFC' : 'RFID'}?`,
        message: 'The other frequency is kept.',
        confirmLabel: 'Replace'
      }))
    ) {
      return;
    }

    const name = await ask({
      title: `Name on slot ${selected.slot + 1}`,
      message: ['32 UTF-8 bytes maximum.', ...(state.document.warnings || [])].join(' '),
      initial: state.document.name,
      confirmLabel: 'Save'
    });
    if (name === null) {
      return;
    }

    nickname(name);
    const device = new SlotDevice(signal);
    await withDevice(device, async () => {
      await device.begin();
      const enabled = activate || (state.document.slot?.enabled ?? true);
      const revision = state.document.slot?.revision ?? selected.place.revision;
      const saved = await device.save(selected.slot, sense, state.document, name.trim(), revision, enabled);
      state.document.name = name.trim();
      state.document.slot = { index: selected.slot, sense, enabled, revision: saved.revision };
      markClean();
      if (activate) {
        const row = decodeSlot(await request(`/api/slot/${selected.slot}`));
        await device.action('activate', [selected.slot, ...be32(row.hf.revision), ...be32(row.lf.revision)]);
        // Selection can change the live-buffer component of the fingerprint.
        const active = decodeSlot(await request(`/api/slot/${selected.slot}`));
        state.document.slot.revision = active[sense === 2 ? 'hf' : 'lf'].revision;
      }
      render();
      saveDraft();
      const paused = activate && views.bluetooth() && BLE_PAUSED_TYPES.includes(state.document.type);
      $('status').textContent = activate
        ? `Slot ${selected.slot + 1} saved and selected for emulation`
        : `Saved and verified on slot ${selected.slot + 1}`;
      if (paused) {
        $('status').textContent =
          `Slot ${selected.slot + 1} saved · emulation starts once Bluetooth disconnects`;
      }
      notify(
        $('status').textContent,
        false,
        paused ? { label: 'Disconnect', run: () => views.disconnect() } : undefined
      );
    });
  });
  await views.refresh();
}

let scanDialogCloseTimer;

function openScanDialog() {
  clearTimeout(scanDialogCloseTimer);
  delete $('scan-dialog').dataset.closing;
  $('scan-dialog').showModal();
}

function closeScanDialog() {
  const dialog = $('scan-dialog');
  if (!dialog.open || dialog.dataset.closing) {
    return;
  }
  // Keep the native modal visible while it slides out, including on WebKit.
  dialog.dataset.closing = 'true';
  scanDialogCloseTimer = setTimeout(
    () => {
      dialog.close();
      delete dialog.dataset.closing;
    },
    matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 340
  );
}

async function scan() {
  if (state.controller) {
    return;
  }

  const technology = scanTechnology;
  state.controller = new AbortController();
  offline.pause();
  controls();

  const device = new Device(state.controller.signal);
  $('scan-title').textContent = 'Scanning';
  $('scan-help').textContent =
    technology === 'rfid'
      ? 'Hold the RFID tag near the device antenna.'
      : 'Hold the NFC tag near the device antenna.';
  $('scan-result').textContent = '';
  $('scan-repair').hidden = true;
  $('scan-dialog').dataset.state = 'scanning';
  openScanDialog();
  startReadTime();
  $('read-elapsed').hidden = true;
  let card;
  let opened = false;

  try {
    let scanned;
    let pass = 0;
    await device.reserve();
    while (!state.controller.signal.aborted) {
      try {
        if (technology === 'rfid') {
          scanned = await scanLf(device);
          card = scanned.card;
        } else {
          // Cold cards may miss short WUPA polling. Start with the historical
          // retry window, then retain it every fifth pass while waiting.
          card = await scanNfc(device, undefined, pass++ % 5 !== 0);
          device.card = card;
          if (card.protocol) {
            scanned = hfDocument(card);
          }
        }
        break;
      } catch (error) {
        if (error.status !== (technology === 'rfid' ? 0x41 : 1)) {
          throw error;
        }
      }
    }
    if (state.controller.signal.aborted) {
      return;
    }

    const classic = !scanned && [8, 9, 16, 24].includes(card.sak & ~0x20);
    rememberDocument();
    state.document = scanned || {
      name: `Tag-${hex(card.uid)}`,
      kind: 'identity',
      card,
      memory: [],
      warnings: !classic && card.sak !== 0 ? ['Memory reading is unsupported for this tag'] : []
    };

    let status = 'Identity captured · memory reading is unsupported for this tag';
    if (card.protocol) {
      if (scanned.memory.length) {
        status = 'Identity captured · reading supported memory…';
      }
    } else if (scanned) {
      status = '';
    } else if (classic) {
      status = 'Checking Classic capabilities…';
    } else if (card.sak === 0) {
      status = 'Detecting Type 2 model…';
    }
    $('status').textContent = status;
    render();
    saveDraft();
    $('scan-dialog').dataset.state = 'detected';
    closeScanDialog();
    opened = true;
    $('read-elapsed').hidden = false;
    view('studio');
    if (scanned?.kind === 'lf' && scanned.memory.length) {
      $('status').textContent = 'ID captured · checking the physical chip…';
      try {
        scanned.lf.chip ??= await inspectLfChip(device);
        $('status').textContent = '';
      } catch (error) {
        scanned.lf.chip = null;
        $('status').textContent = `ID captured · chip check unavailable: ${error.message}`;
      }
      render();
      saveDraft();
    }
    if (card.protocol && scanned.memory.length) {
      await readHf(device, scanned, updateHf);
    }
    if (!scanned && card.sak & 0x20) {
      await readDesfire(device, card, updateDesfire);
    }
    if (classic) {
      const observation = await inspectClassic(
        device,
        card,
        (message) => {
          $('status').textContent = message;
        },
        { modelEvidence: true }
      );
      if (observation.ats) {
        card.ats = observation.ats;
      }
      if (observation.type === 1002) {
        const geometry = await withRuntime(
          (call) => call({ op: 'classic_geometry', sak: 16 }),
          state.controller.signal
        );
        updateClassic({ card, geometry, memory: Array(geometry.blocks).fill(null) });
      }
      state.document.classicObservation = observation;
      $('status').textContent = 'Tag identified · Memory not read';
      render();
      saveDraft();
    }
    if (!scanned && card.sak === 0) {
      await readType2(device, card, 'auto', updateType2);
    }
  } catch (error) {
    if (!state.controller.signal.aborted) {
      if (opened) {
        if (state.document.kind === 'identity' && card.sak === 0) {
          $('status').textContent =
            `Type 2 read unavailable: ${error.message}. If the model is unidentified, choose a manual profile only when you know it.`;
          state.document.warnings = [$('status').textContent];
          saveDraft();
        } else if (state.document.kind === 'type2') {
          $('status').textContent = `Type 2 read interrupted: ${error.message} · completed pages retained`;
        } else {
          $('status').textContent = error.message;
        }
        notify(error.message, true);
      } else {
        $('scan-dialog').dataset.state = 'error';
        $('scan-title').textContent = 'Scan unavailable';
        $('scan-result').textContent = error.message;
        $('scan-repair').hidden = technology !== 'nfc';
      }
    }
  } finally {
    try {
      await device.end();
    } catch (error) {
      notify(`Cleanup unconfirmed: ${error.message}`, true);
    }
    if (state.controller.signal.aborted && opened) {
      if (state.document.kind === 'identity') {
        $('status').textContent = 'Read stopped · identity retained';
      } else if (state.document.kind === 'type2') {
        $('status').textContent = 'Read stopped · completed pages retained';
      } else if (state.document.card.protocol) {
        $('status').textContent = 'Read stopped · returned blocks retained';
      }
    }
    if (opened) {
      finishReadTime();
      markClean();
      saveDraft();
    } else {
      clearFeedback();
    }
    state.controller = null;
    offline.start();
    controls();
    await views.refresh();
  }
}

function setScanTechnology(technology) {
  scanTechnology = technology;
  document.querySelectorAll('[data-scan-mode]').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.scanMode === technology));
  });
}

document.querySelectorAll('[data-scan-mode]').forEach((button) => {
  button.onclick = () => {
    if (!state.controller) {
      setScanTechnology(button.dataset.scanMode);
    }
  };
});

$('scan').onclick = () => scan().catch((error) => notify(error.message, true));

$('cancel-scan').onclick = () => {
  state.controller?.abort();
  closeScanDialog();
};

$('scan-dialog').oncancel = (event) => {
  event.preventDefault();
  $('cancel-scan').click();
};

async function recoverClassic(device, expectedUid, initialCard) {
  $('keys').replaceChildren();
  $('progress').value = 0;
  const document = state.document;
  const knownKeys = classicDictionaryKeys(document);
  delete document.classicRead;
  let reading;
  try {
    await runAutoPwn({
      dictionary: [$('dictionary').value, ...knownKeys].join('\n'),
      signal: device.signal,
      device,
      initialCard,
      expectedUid,
      expectedModel:
        document.kind === 'classic' && document.type
          ? { type: document.type, card: document.card }
          : undefined,
      onUpdate(next) {
        if (next.geometry) {
          reading = next;
          updateClassic(next);
        } else {
          // A selection error may report another card before memory is replaced.
          updateClassic({ phase: next.phase });
        }
      }
    });
  } finally {
    rememberedKeys.refresh();
    if (reading) {
      // Physical observations belong to this document session, never to an exported draft.
      document.classicRead = classicReadSnapshot(reading);
      markClean();
    }
  }
}

async function readClassicMemory() {
  if (state.controller || !state.document) {
    return;
  }
  if (
    state.document.memory.some(Boolean) &&
    !(await ask({
      title: 'Read fresh memory?',
      message: 'Recovery replaces the open memory. Export your edits first if you want to keep them.',
      confirmLabel: 'Recover'
    }))
  ) {
    return;
  }

  const expectedUid = hex(state.document.card.uid);
  startReadTime();

  state.controller = new AbortController();
  offline.pause();
  controls();

  const device = new Device(state.controller.signal);

  try {
    await recoverClassic(device, expectedUid);
  } catch (error) {
    $('status').textContent = error.message;
    notify(error.message, true);
  } finally {
    finishReadTime();
    saveDraft();
    state.controller = null;
    offline.start();
    controls();
    await views.refresh();
  }
}

function updateType2(next, phase) {
  if (state.document !== next) {
    state.document = next;
    render();
  } else {
    renderMemory();
    controls();
  }
  $('status').textContent = phase;
  saveDraft();
}

function updateHf(next, message) {
  if (state.document !== next) {
    state.document = next;
    render();
  } else {
    renderMemory();
    controls();
  }
  $('status').textContent = message;
  $('hf-details').textContent = hfDetails(next);
  saveDraft();
}

$('hf-defaults').onclick = async () => {
  if (state.controller || !needsHfDefaults(state.document)) {
    return;
  }
  let chipId;
  if (state.document.kind === 'st25tb') {
    const value = await ask({
      title: 'Choose emulator Chip ID',
      message: 'The Flipper file does not contain this one-byte inventory identifier. Enter two hex digits.',
      initial: '5A',
      confirmLabel: 'Use Chip ID'
    });
    if (value === null) {
      return;
    }
    try {
      [chipId] = parseHex(value, 1);
    } catch (error) {
      notify(error.message, true);
      return;
    }
  } else if (
    !(await ask({
      title: 'Use emulator defaults?',
      message:
        'Unknown locks become unlocked. Hidden passwords and unread security metadata become zero. The original capture stays unchanged. These defaults do not reproduce unknown protection state.',
      confirmLabel: 'Apply defaults'
    }))
  ) {
    return;
  }
  applyHfDefaults(state.document, chipId);
  clearFeedback();
  $('status').textContent = '';
  render();
  saveDraft();
  notify('Emulator defaults applied');
};

function updateDesfire(doc, phase) {
  if (state.document?.kind === 'desfire') {
    doc.name = state.document.name;
  }
  state.document = doc;
  render();
  $('status').textContent = phase;
  saveDraft();
}

async function readDesfireMemory() {
  await workspaceTask(async (signal) => {
    const device = new Device(signal);
    startReadTime();
    try {
      await withDevice(device, async () => {
        await device.reserve();
        await readDesfire(device, state.document.card, updateDesfire);
      });
    } finally {
      finishReadTime();
    }
  });
}

async function readHfMemory(password = null) {
  if (state.controller || !state.document) {
    return;
  }
  if (
    state.document.memory.some(Boolean) &&
    !(await ask({
      title: 'Read fresh memory?',
      message: 'This replaces the open memory. Export your edits first if you want to keep them.',
      confirmLabel: 'Read'
    }))
  ) {
    return;
  }
  await workspaceTask(async (signal) => {
    const device = new Device(signal);
    startReadTime();
    try {
      await withDevice(device, async () => {
        await device.reserve();
        device.nfcvPassword = password;
        await readHf(device, state.document, updateHf);
      });
    } finally {
      finishReadTime();
    }
  });
}

async function readType2Memory() {
  if (state.controller || !state.document) {
    return;
  }
  if (
    state.document.memory.some(Boolean) &&
    !(await ask({
      title: 'Read fresh Type 2 memory?',
      message: 'Export your edits first to keep them.',
      confirmLabel: 'Read'
    }))
  ) {
    return;
  }

  const expectedUid = hex(state.document.card.uid);

  const profile = $('type2-profile').value;
  if (
    profile !== 'auto' &&
    !(await ask({
      title: 'Use the selected profile?',
      message:
        'This assumes the chosen model and uses its emulator version. Hidden credentials stay unknown.',
      confirmLabel: 'Read'
    }))
  ) {
    return;
  }
  await workspaceTask(async (signal) => {
    const device = new Device(signal);
    startReadTime();
    try {
      await withDevice(device, async () => {
        const card = await device.begin();
        if (hex(card.uid) !== expectedUid) {
          throw new Error('The tag UID changed. Scan the current tag before reading.');
        }
        await readType2(device, card, profile, updateType2);
      });
    } finally {
      finishReadTime();
    }
  });
  await views.refresh();
}

$('type2-defaults').onclick = async () => {
  if (state.controller || !needsType2Defaults(state.document)) {
    return;
  }
  if (
    !(await ask({
      title: 'Fill missing emulator data?',
      message:
        'Missing credentials and metadata will use default values. Unread user pages will remain unknown.',
      warning: 'Authentication and originality checks may fail.',
      confirmLabel: 'Apply defaults'
    }))
  ) {
    return;
  }
  applyType2Defaults(state.document);
  clearFeedback();
  $('status').textContent = '';
  render();
  saveDraft();
  notify('Emulator defaults applied');
};

$('stop').onclick = () => {
  state.controller?.abort();
  $('stop').disabled = true;
  $('status').textContent = 'Stopping after the current bounded device action…';
};

$('export').onclick = async () => {
  await workspaceTask(async (signal) => {
    download(await exportNfc(state.document, signal), `${state.document.name}.nfc`);
  });
};

for (const id of ['export-json', 'export-document']) {
  $(id).onclick = () => {
    try {
      download(
        state.document.kind === 'desfire'
          ? JSON.stringify(state.document.capture, null, 2)
          : serializeDraft(state.document),
        `${state.document.name}.json`,
        'application/json'
      );
    } catch (error) {
      notify(error.message, true);
    }
  };
}

$('export-mct').onclick = () =>
  workspaceTask(async (signal) => {
    download(await exportMct(state.document, signal), `${state.document.name}.mct`);
  });

for (const id of ['export-keys', 'keys-export']) {
  $(id).onclick = () => {
    try {
      const doc = state.document;
      const name = doc.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'classic';
      const uid = hex(doc.card.uid);
      const filename = name.toUpperCase().endsWith(uid) ? name : `${name}-${uid}`;
      download(classicDictionaryKeys(doc).join('\n') + '\n', `${filename}.dic`);
      if (id === 'export-keys') {
        $('export-menu').querySelector('summary').focus();
      }
    } catch (error) {
      notify(error.message, true);
    }
  };
}

$('save-slot').onclick = () => saveToSlot(false);

$('emulate').onclick = () => saveToSlot(true);

async function clearDocument() {
  if (!(await canReplace(true))) {
    return;
  }

  rememberDocument();
  clearTimeout(draftTimer);
  draftTimer = null;
  state.document = null;
  clearFeedback();

  try {
    localStorage.removeItem(DRAFT);
  } catch {
    /* Storage is optional. */
  }
  render();
}

$('studio-new').onclick = () => creation.open();
$('create').onclick = () => creation.open();

async function newDocument(type, uid) {
  if (!(await canReplace())) {
    return;
  }
  let next;
  await workspaceTask(async (signal) => {
    try {
      switch (family(type)) {
        case 'classic':
          next = await blankClassic(classicSelector({ type }), uid, signal);
          break;
        case 'type2':
          next = await blankType2(type, uid, signal);
          break;
        case 'lf':
          next = blankLf(type);
          break;
        case 'nfcv':
          next = blankNfcv(type, uid);
          break;
        default:
          throw new Error('This model cannot be created');
      }
      signal.throwIfAborted();
      openDocument(next, 'New draft · nothing written to a tag or slot');
      creation.close();
    } catch (error) {
      if (!signal.aborted) {
        creation.showError(error.message);
      }
    }
  });
  if (next?.kind === 'lf' && state.document === next) {
    $('lf-fields').querySelector('input')?.focus();
  }
  return !!next && state.document === next;
}

async function newLfDocument(type) {
  if (state.controller) {
    return;
  }
  if (state.document?.kind === 'lf' && isDirty()) {
    if (
      !(await ask({
        title: 'Change RFID format?',
        message: 'The current ID will be cleared. A copy of this document stays in Recent for this session.',
        confirmLabel: 'Change format'
      }))
    ) {
      return;
    }
  } else if (!(await canReplace())) {
    return;
  }
  await workspaceTask(async () => {
    openDocument(blankLf(type), 'Choose a format and enter an ID · nothing written');
  });
  $('lf-fields').querySelector('input')?.focus();
}

$('import').onclick = () => {
  slotImportTarget = null;
  $('dump-file').click();
};

async function importFile(file, target = null) {
  try {
    if (!file || state.controller) {
      return;
    }
    if (file.size > 100000) {
      throw new Error('Dump file exceeds 100 KB');
    }

    let imported;
    await workspaceTask(async (signal) => {
      const name = file.name.replace(/\.(nfc|cu|mct)$/i, '');
      if (/\.mct$/i.test(file.name)) {
        const text = await file.text();
        const dump = await inspectMct(text, signal);
        const lastSector = Math.max(...dump.sectors);
        let sak = 24;
        if (lastSector < 5) {
          sak = 9;
        } else if (lastSector < 16) {
          sak = 8;
        } else if (lastSector < 32) {
          sak = 16;
        }
        $('mct-type').value = String(sak);
        const first = dump.memory[0].slice(0, 4);
        $('mct-uid').value = first.every((byte) => byte !== null) ? hex(first) : '';
        pendingMct = { text, name, target };
        $('mct-dialog').returnValue = '';
        $('mct-dialog').showModal();
        return;
      }

      if (/\.json$/i.test(file.name)) {
        imported = await restoreDraft(await file.text(), signal);
      } else if (/\.cu$/i.test(file.name)) {
        imported = decodeSlotImage(new Uint8Array(await file.arrayBuffer()), name);
      } else {
        imported = await importNfc(await file.text(), name, signal);
      }
      if (!imported) {
        throw new Error('Unsupported or empty browser draft');
      }
      if (signal.aborted) {
        imported = null;
      }
    });

    if (imported) {
      await openImported(imported, target);
    }
  } catch (error) {
    notify(error.message, true);
  }
}

$('dump-file').onchange = async (event) => {
  const target = slotImportTarget;
  slotImportTarget = null;

  try {
    await importFile(event.target.files[0], target);
  } finally {
    event.target.value = '';
  }
};

$('dump-file').oncancel = () => {
  slotImportTarget = null;
};

$('mct-dialog').onclose = async () => {
  const file = pendingMct;
  pendingMct = null;
  if ($('mct-dialog').returnValue !== 'import' || !file) {
    return;
  }
  let imported;
  await workspaceTask(async (signal) => {
    const text = $('mct-uid').value.replace(/\s/g, '');
    imported = await importMct(
      file.text,
      file.name,
      Number($('mct-type').value),
      parseHex(text, text.length / 2),
      signal
    );
    if (signal.aborted) {
      imported = null;
    }
  });
  if (imported) {
    await openImported(imported, file.target);
  }
};

async function importToSlot(imported, target) {
  await workspaceTask(async (signal) => {
    const sense = imported.kind === 'lf' ? 1 : 2;
    if (sense !== target.sense) {
      throw new Error(
        `This file contains an ${sense === 2 ? 'NFC' : 'RFID'} tag. Choose a matching slot place.`
      );
    }
    encodeSlotImage(imported);
    const selected = await slots.choose(sense, target.slot);
    if (selected.place.type) {
      throw new Error('This slot place is no longer empty. Refresh slots and choose an empty place.');
    }

    const name = await ask({
      title: `Name on slot ${target.slot + 1}`,
      message: ['32 UTF-8 bytes maximum.', ...(imported.warnings || [])].join(' '),
      initial: imported.name,
      confirmLabel: 'Save'
    });
    if (name === null || signal.aborted) {
      return;
    }

    nickname(name);
    const device = new SlotDevice(signal);
    try {
      await withDevice(device, async () => {
        await device.begin();
        await device.save(target.slot, sense, imported, name.trim(), selected.place.revision, true);
        notify(`Saved and verified on slot ${target.slot + 1}`);
      });
    } finally {
      await slots.refresh();
      await views.refresh();
    }
  });
}

async function openImported(imported, target = null) {
  if (target) {
    await importToSlot(imported, target);
    return;
  }

  const snapshot = serializeDraft(imported);
  if (snapshot === state.cleanDocument || (state.document && snapshot === serializeDraft(state.document))) {
    return;
  }
  if (!(await canReplace())) {
    return;
  }

  openDocument(
    imported,
    imported.warnings?.length ? imported.warnings.join(' · ') : 'Imported document · not saved to a slot'
  );
}

$('dictionary').oninput = () => {
  try {
    localStorage.setItem(DICTIONARY, $('dictionary').value);
    $('dictionary-status').textContent =
      'Saved in this browser only. The shared system dictionary is also used.';
  } catch {
    $('dictionary-status').textContent = 'Browser storage unavailable. Export your keys to keep them.';
  }
  controls();
};

$('dictionary-import').onclick = () => $('dictionary-file').click();

$('dictionary-file').onchange = async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) {
      return;
    }
    if (file.size > 100000) {
      throw new Error('Dictionary exceeds 100 KB');
    }
    const text = await file.text();
    const invalidKey = text.split(/\r?\n/).some((line) => {
      const key = line.trim();
      return key && !key.startsWith('#') && !/^[\da-f]{12}$/i.test(key);
    });
    if (invalidKey) {
      throw new Error('Use one 12-character hexadecimal key per line');
    }

    $('dictionary').value = text;
    $('dictionary').oninput();
    $('dictionary-status').textContent = `Keys imported. ${$('dictionary-status').textContent}`;
  } catch (error) {
    $('dictionary-status').textContent = error.message;
  } finally {
    event.target.value = '';
  }
};

$('dictionary-export').onclick = () => {
  try {
    download($('dictionary').value, 'chameleon.keys');
  } catch (error) {
    $('dictionary-status').textContent = error.message;
  }
};

document.querySelectorAll('[data-open-dialog]').forEach((button) => {
  button.onclick = () => $(button.dataset.openDialog).showModal();
});

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.onclick = () => button.closest('dialog').close();
});

async function readProtectedSlix() {
  if (state.controller) {
    return;
  }
  const text = await ask({
    title: 'SLIX-L privacy password',
    message:
      'Enter four hexadecimal bytes in RF order. This password is used only for this read and is not saved.',
    initial: '',
    inputType: 'password',
    validateInput: (value) => {
      try {
        parseHex(value, 4);
        return '';
      } catch {
        return 'Enter four hexadecimal bytes.';
      }
    },
    confirmLabel: 'Read tag'
  });
  if (text === null) {
    return;
  }
  try {
    await readHfMemory(parseHex(text, 4));
  } catch (error) {
    notify(error.message, true);
  }
}

$('read-slix').onclick = () => readProtectedSlix();

// Resolves after the delay, or immediately when the read is stopped.
function tonieDelay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

// One-tap Tonie capture: start from an unbound SLIX-L draft so the read binds to
// the presented figure even while it is still privacy-locked and silent to
// inventory, retry the known-password unlock until the figure is held against
// the antenna (or Stop is pressed), then keep that password in the emulator
// secrets so the saved slot can play back to a Toniebox.
async function readTonie() {
  if (state.controller || !state.connected) {
    return;
  }
  if (!(await canReplace())) {
    return;
  }
  let draft;
  try {
    draft = blankNfcv(1500);
  } catch (error) {
    notify(error.message, true);
    return;
  }
  draft.name = 'Tonie';
  openDocument(draft, 'Hold the Tonie against the antenna…');
  let read = false;
  let sawTag = false;
  await workspaceTask(async (signal) => {
    startReadTime();
    try {
      for (let attempt = 0; attempt < TONIE_SCAN_ATTEMPTS && !signal.aborted; attempt++) {
        // Re-arm a fresh unbound draft if a prior attempt bound but could not dump.
        if (!state.document?.unbound) {
          const retry = blankNfcv(1500);
          retry.name = 'Tonie';
          state.document = retry;
        }
        const device = new Device(signal);
        try {
          await withDevice(device, async () => {
            await device.reserve();
            device.nfcvPassword = [...TONIE_PRIVACY_PASSWORD];
            await readHf(device, state.document, updateHf);
          });
          if (state.document?.capture?.complete) {
            read = true;
            return;
          }
          // A block glitched: the figure is present, so retry the whole read.
          sawTag = true;
          $('status').textContent = 'Partial read — hold the Tonie flat and still…';
          await tonieDelay(TONIE_SCAN_INTERVAL_MS, signal);
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          // 1 no tag, 2 comms glitch, 6 unlock not verified: all transient here.
          if (![1, 2, 3, 6].includes(error.status)) {
            throw error;
          }
          if (error.status === 6) {
            sawTag = true;
          }
          $('status').textContent = 'Searching for a Tonie — keep it on the antenna…';
          await tonieDelay(TONIE_SCAN_INTERVAL_MS, signal);
        }
      }
      if (!signal.aborted) {
        notify(
          sawTag
            ? 'Tonie found but not fully read. Hold it flat and steady, then tap Read Tonie again.'
            : 'No Tonie detected. Hold the figure flat on the antenna and tap Read Tonie again.',
          true
        );
      }
    } finally {
      finishReadTime();
    }
  });
  if (!read) {
    return;
  }
  const doc = state.document;
  if (doc?.card?.protocol !== 'nfc_v' || !doc.capture?.complete) {
    return;
  }
  if (needsHfDefaults(doc)) {
    applyHfDefaults(doc);
  }
  if (Array.isArray(doc.emulator?.secrets) && doc.emulator.secrets.length >= 4) {
    doc.emulator.secrets.splice(0, 4, ...TONIE_PRIVACY_PASSWORD);
    clearFeedback();
    render();
    saveDraft();
    notify('Tonie read; privacy password stored for emulation');
  }
}

$('read-tonie').onclick = () => readTonie().catch((error) => notify(error.message, true));

async function readDocument() {
  if (!state.document || state.controller || !state.connected) {
    return;
  }
  if (state.document.kind === 'desfire') {
    return readDesfireMemory();
  }
  if (['st25tb', 'nfc_v'].includes(state.document.card.protocol)) {
    return readHfMemory();
  }
  if (state.document.kind !== 'lf' && !state.document.card.protocol && state.document.card.sak === 0) {
    return readType2Memory();
  }
  if (!state.document.card.protocol && [8, 9, 16, 24].includes(state.document.card.sak & ~0x20)) {
    return readClassicMemory();
  }
}

$('read').onclick = readDocument;

$('close-doc').onclick = () => clearDocument();

$('rename').onclick = async () => {
  if (!state.document || state.controller) {
    return;
  }

  const name = await ask({
    title: 'Rename document',
    message: state.document.slot
      ? 'Renames this document and its device slot. Memory edits stay in Studio until saved.'
      : 'Changes the Studio document name.',
    initial: state.document.name,
    confirmLabel: 'Rename'
  });
  if (name === null || state.controller) {
    return;
  }

  try {
    const bytes = nickname(name);
    const nextName = name.trim();
    await workspaceTask(async (signal) => {
      const slot = state.document.slot;
      if (slot) {
        const device = new SlotDevice(signal);
        const saved = await withDevice(device, async () => {
          await device.begin();
          await device.action('nick', [slot.index, slot.sense, ...be32(slot.revision), ...bytes]);
          const row = decodeSlot(await request(`/api/slot/${slot.index}`));
          const place = row[slot.sense === 2 ? 'hf' : 'lf'];
          if (place.name !== nextName) {
            throw new Error('Slot rename unconfirmed; refresh before retrying.');
          }
          return place;
        });
        slot.revision = saved.revision;
        if (state.cleanDocument) {
          const baseline = JSON.parse(state.cleanDocument).document;
          state.cleanDocument = serializeDraft({ ...baseline, name: nextName });
        }
      }
      state.document.name = nextName;
      $('studio-name').textContent = nextName;
      saveDraft();
      notify(`Document renamed to “${nextName}”`);
    });
    if (state.document.slot) {
      await slots.refresh();
      await views.refresh();
    }
  } catch (error) {
    notify(error.message, true);
  }
};

$('dictionary-edit').onclick = () => $('dictionary-dialog').showModal();

$('dictionary-close').onclick = () => $('dictionary-dialog').close();

$('dictionary-done').onclick = () => {
  $('dictionary-dialog').close();
  readDocument();
};

// Only one popover stays open. Escape and outside clicks return to the workspace.

document.addEventListener('click', (event) => {
  document.querySelectorAll('.menu[open], .tag-details[open]').forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest('button')) {
      menu.open = false;
    }
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const menus = document.querySelectorAll('.menu[open], .tag-details[open]');
    if (menus.length) {
      event.preventDefault();
    }
    menus.forEach((menu) => {
      menu.open = false;
      menu.querySelector('summary').focus();
    });
  }
});

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }
  event.preventDefault();
  dragDepth++;
  $('drop-zone').hidden = !!state.controller;
});

window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
  }
});

window.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    $('drop-zone').hidden = true;
  }
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-zone').hidden = true;
  if (!state.controller && event.dataTransfer?.files.length === 1) {
    view('studio');
    importFile(event.dataTransfer.files[0]);
  }
});

async function refreshWithFeedback(id, refresh, message) {
  const button = $(id);
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');

  try {
    const result = await refresh();
    if (result?.error) {
      throw result.error;
    }
    notify(message);
  } catch (error) {
    notify(`Refresh failed: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

$('refresh-device').onclick = () =>
  refreshWithFeedback(
    'refresh-device',
    async () => {
      const [device] = await Promise.all([views.refresh(), offline.refresh()]);
      return device;
    },
    'Device refreshed'
  );

$('refresh-slots').onclick = () =>
  refreshWithFeedback('refresh-slots', () => slots.refresh(), 'Slots refreshed');

document.querySelectorAll('[data-view-target]').forEach((button) => {
  button.onclick = () => view(button.dataset.viewTarget);
});

// The development packager supplies the source commit in the shell metadata.
if (DEVELOPMENT) {
  document.documentElement.dataset.channel = 'development';
  for (const channel of document.querySelectorAll('.brand-channel')) {
    channel.querySelector('.brand-revision').textContent = DEVELOPMENT.slice(0, 7);
    channel.closest('.brand').title = `Development build ${DEVELOPMENT}`;
    channel.hidden = false;
  }
}

window.addEventListener('hashchange', () => view(location.hash.slice(1)));
render();
view(location.hash.slice(1));
views.refresh();

await workspaceTask(async (signal) => {
  try {
    $('dictionary').value = localStorage.getItem(DICTIONARY) || '';
  } catch {
    /* Browser storage is optional. */
  }
  await restoreBrowserDraft(signal);
});

window.addEventListener('online', () => offline.start());

setInterval(() => {
  if (!document.hidden && !state.controller && !$('device-settings').contains(document.activeElement)) {
    views.refresh();
  }
}, 30000);
