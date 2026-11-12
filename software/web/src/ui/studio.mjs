import { type2ContentView } from './type2-content.mjs';
import { amiiboInfo, type2Changes } from '../documents/type2-content.mjs';
import {
  classicMagicSignatures,
  classicMagicEvidence,
  magicGenerationDetected,
  magicGen1aDetected,
  magicGen2Confirmed,
  classicObservationMatches
} from '../documents/classic-magic.mjs';
import { renderDesfire } from './desfire-view.mjs';
import { needsHfDefaults } from '../documents/hf-image.mjs';
import { supportsPhysicalCopy } from '../device/tag-write.mjs';
import { classicChanges } from '../documents/classic-write.mjs';
import { classicDocumentKeys, classicDictionaryKeys } from '../documents/classic-document-keys.mjs';
import { renderLfChip } from './lf-chip.mjs';
import { lfIdentity } from '../documents/lf.mjs';
import { lfEditor } from './lf-editor.mjs';
import { $, BLE_PAUSED_TYPES } from './device-view.mjs';
import {
  canExportNfc,
  editBlock,
  knownBlock,
  serializeDraft,
  needsType2Defaults,
  TYPE2_NOTES
} from '../documents/workspace.mjs';
import { memoryEditor, EDITOR_LEGENDS } from './memory-editor.mjs';
import { ST25TB } from '../device/st25tb-protocol.mjs';
import { encodeSlotImage, identityLabel, typeName, isByte } from '../documents/slot-image.mjs';
import { hex } from '../device/transport.mjs';

export function hfDetails(document) {
  const { card, capture } = document;
  if (card.protocol === 'nfc_b') {
    return `Application ${hex(card.application)} · Protocol ${hex(card.protocol_info)} · Memory is application-specific`;
  }

  if (card.protocol === 'st25tb') {
    const system = card.system ?? capture?.system;
    const chipId = isByte(card.chip_id) ? hex([card.chip_id]) : 'unknown';
    const systemOtp = system ? hex(system) : 'unknown';
    return `Chip ID ${chipId} · System OTP ${systemOtp}`;
  }

  if (card.protocol !== 'nfc_v') {
    return '';
  }
  return [
    ['DSFID', card.dsfid],
    ['AFI', card.afi],
    ['IC reference', card.ic_ref]
  ]
    .map(([label, value]) => `${label} ${isByte(value) ? hex([value]) : 'unknown'}`)
    .join(' · ');
}

export function studioView(state, { saveDraft, renderRecents, onLfFormat }) {
  const lf = lfEditor(state, {
    onFormat: onLfFormat,
    onChange() {
      renderIdentity(state.document);
      $('status').textContent = 'Document edited · physical tag and slots are unchanged';
      saveDraft();
      controls();
    }
  });

  const content = type2ContentView($('type2-content'), () => {
    $('status').textContent = 'Content updated · physical tag and slots are unchanged';
    saveDraft();
    renderMemory();
    controls();
  });

  let readStartedAt = null;
  let readInterval;

  function showReadTime() {
    const seconds = Math.max(0, (performance.now() - readStartedAt) / 1000);
    $('read-elapsed').textContent = `${seconds.toFixed(1)} s`;
  }

  function clearFeedback() {
    clearInterval(readInterval);
    readInterval = null;
    readStartedAt = null;
    $('read-elapsed').hidden = true;
    $('copy-progress').hidden = true;
  }

  function startReadTime() {
    clearFeedback();
    readStartedAt = performance.now();
    $('read-elapsed').hidden = false;
    showReadTime();
    readInterval = setInterval(showReadTime, 100);
  }

  function finishReadTime() {
    if (readStartedAt === null) {
      return;
    }
    clearInterval(readInterval);
    readInterval = null;
    showReadTime();
    readStartedAt = null;
  }

  function isClassic(doc) {
    return (
      doc?.kind === 'classic' || (doc?.kind === 'identity' && [8, 9, 16, 24].includes(doc.card.sak & ~0x20))
    );
  }

  function renderIdentity(doc) {
    const amiibo = doc.kind === 'type2' ? amiiboInfo(doc) : null;
    $('amiibo-badge').hidden = !amiibo;
    $('amiibo-identity').hidden = !amiibo?.id;
    $('amiibo-id').textContent = amiibo?.id ? hex(amiibo.id) : '';
    const label = $('card-label');
    const value = $('card-value');
    if (doc.kind === 'lf') {
      const identity = lfIdentity(doc);
      const hasId = identity.startsWith('ID ');
      label.textContent = hasId ? 'ID' : 'Identity';
      value.textContent = hasId ? identity.slice(3) : identity;
      return;
    }
    const [name, identity] = identityLabel(doc).split(' ');
    label.textContent = name;
    value.textContent = identity;
  }

  function classicDetails() {
    const doc = state.document;
    const classic = isClassic(doc);
    const physical = $('classic-physical');
    const prng = $('classic-prng');
    const emulation = $('classic-emulation');
    physical.hidden = !classic;
    $('classic-details').hidden = !classic;
    emulation.hidden = !classic || !doc.emulator;
    $('classic-physical-value').textContent = '';
    prng.hidden = true;
    prng.removeAttribute('data-type');
    $('classic-prng-type').textContent = '';
    emulation.textContent = '';
    if (!classic) {
      return;
    }
    const observation = doc.classicObservation;
    const observed = classicObservationMatches(observation, doc.card);
    if (observed && observation.prng) {
      prng.hidden = false;
      prng.dataset.type = observation.prng;
      $('classic-prng-type').textContent = observation.prng;
    }
    let label = 'Not checked';
    let description = 'A dump cannot establish whether the physical tag UID is writable.';
    let confirmed = false;
    if (observed && observation.magic) {
      const magic = observation.magic;
      const signatures = classicMagicSignatures(magic);
      confirmed = magicGenerationDetected(magic);
      label = 'Unknown';
      if (magicGen2Confirmed(magic)) {
        label = 'CUID · Writable';
      } else if (magicGen1aDetected(magic)) {
        label = 'Gen1A · Writable';
      } else if (confirmed) {
        label = signatures[0];
      }
      description = confirmed
        ? `${signatures.join(', ')} confirmed · no data written.`
        : `${classicMagicEvidence(magic)}. UID writability unconfirmed.`;
    } else if (classic && busyInspection()) {
      label = 'Checking…';
      description = 'Checking signatures and essential sector-0 keys · memory not read.';
    } else if (observed && observation.unavailable) {
      label = 'Unknown';
      description = 'Physical tag detection unavailable. UID writability could not be checked.';
    }
    $('classic-physical-value').textContent = label;
    physical.classList.toggle('confirmed', confirmed);
    $('classic-activation').textContent = [
      `ATQA ${hex(doc.card.atqa)} · SAK ${hex([doc.card.sak])}`,
      doc.card.ats?.length ? `ATS ${hex(doc.card.ats)}` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    $('classic-evidence').textContent = description;
    if (doc.emulator) {
      const options = doc.emulator.options;
      emulation.textContent = `Emulation · Gen1A ${options[1] ? 'enabled' : 'disabled'} · Gen2 ${options[2] ? 'enabled' : 'disabled'}`;
      emulation.title =
        'Document settings applied when saved to a slot; these do not describe the original physical tag.';
    }
  }

  function busyInspection() {
    return !!state.controller && state.document?.kind === 'identity' && !state.document.classicObservation;
  }

  function controls() {
    classicDetails();
    const doc = state.document;
    const busy = !!state.controller;
    const connected = state.connected;
    const invalidEdit =
      !!$('memory').querySelector('[aria-invalid="true"]') ||
      (doc?.kind === 'lf' && doc.memory.length > 0 && !knownBlock(doc.memory[0]));

    content.setBusy(busy || invalidEdit);
    $('read-slix').disabled = !connected || busy;
    $('read-slix').hidden = doc?.card?.protocol !== 'nfc_v' || doc.card.uid.slice(0, 3).join() !== '224,4,3';
    $('scan').disabled = !connected || busy;
    $('read-tonie').disabled = !connected || busy;
    $('change-uid').hidden = !isClassic(doc) || doc.card?.uid?.length !== 4;
    $('change-uid').disabled = !connected || busy;
    $('repair-tag').hidden = !isClassic(doc);
    $('format-tag').hidden = !isClassic(doc);
    $('scan-repair').disabled = !connected || busy;
    $('repair-tag').disabled = !connected || busy;
    $('format-tag').disabled = !connected || busy;
    const copyable = supportsPhysicalCopy(doc);
    $('copy-tag').hidden = !copyable;
    $('copy-tag-divider').hidden = !copyable;
    $('copy-tag').disabled = !connected || busy || invalidEdit || !copyable;
    const changes = doc?.kind === 'type2' ? type2Changes(doc) : classicChanges(doc);
    const st25tb = doc?.kind === 'st25tb' && doc.type === ST25TB.TYPE;
    $('write-changes').hidden = doc?.kind !== 'classic' && !(doc?.kind === 'type2' && copyable) && !st25tb;
    $('write-changes').textContent = changes ? `Write changes (${changes.writes.length})` : 'Write changes';
    $('write-changes').disabled =
      !connected || busy || invalidEdit || (!st25tb && (!changes?.writes.length || !!changes.unknown.length));
    let writeReason = 'Read this tag in the current session before writing changes';
    if (!connected) {
      writeReason = 'Connect the Chameleon first';
    } else if (busy) {
      writeReason = 'Wait for the current operation';
    } else if (invalidEdit) {
      writeReason = 'Correct the highlighted memory first';
    } else if (changes?.unknown.length) {
      writeReason = `${doc.kind === 'type2' ? 'Pages' : 'Blocks'} ${changes.unknown.join(', ')} need complete original and edited bytes`;
    } else if (changes) {
      writeReason = doc.kind === 'type2' ? 'No user-page changes to write' : 'No data block changes to write';
    }
    let writeTitle = 'Write to the tag last read';
    if (st25tb) {
      writeTitle = 'Check the tag and write changes';
    }
    $('write-changes').title = $('write-changes').disabled ? writeReason : writeTitle;
    document.querySelectorAll('[data-scan-mode]').forEach((button) => {
      button.disabled = busy;
    });
    $('stop').disabled = !busy;
    $('studio-new').disabled = busy;
    $('create').disabled = busy;
    $('import').disabled = busy;

    const exportable =
      doc?.kind === 'desfire'
        ? doc.capture.complete
        : !!doc?.memory?.length &&
          doc.memory.every(knownBlock) &&
          canExportNfc(doc) &&
          (doc.emulator?.extra || []).every(Boolean);
    $('export').disabled = busy || invalidEdit || !exportable;

    let complete;
    try {
      encodeSlotImage(doc);
      complete = true;
    } catch {
      complete = false;
    }

    $('type2-profile').disabled = busy;
    $('type2-defaults').hidden = !needsType2Defaults(doc);
    $('type2-defaults').disabled = busy;
    $('save-slot').disabled = !connected || busy || invalidEdit || !complete;
    const emulating = isEmulating();
    $('emulate').disabled = !connected || busy || invalidEdit || !complete || emulating;
    $('export-mct').disabled = busy || invalidEdit || doc?.kind !== 'classic' || !doc?.memory?.length;
    for (const id of ['export-json', 'export-document']) {
      $(id).disabled = busy || invalidEdit || !doc;
    }
    const keyCount = classicDictionaryKeys(doc).length;
    const keyLabel = `${keyCount} unique ${keyCount === 1 ? 'key' : 'keys'}`;
    let keyExportReason = '';
    if (busy) {
      keyExportReason = 'Wait for the current operation to finish';
    } else if (invalidEdit) {
      keyExportReason = 'Fix the invalid memory edit before exporting';
    } else if (!keyCount) {
      keyExportReason = 'No known keys to export';
    }
    for (const id of ['export-keys', 'keys-export']) {
      $(id).disabled = !!keyExportReason;
      $(id).title = keyExportReason || `Export ${keyLabel} as a dictionary`;
    }
    $('export-keys-format').textContent = keyCount
      ? `.dic · ${keyCount} ${keyCount === 1 ? 'key' : 'keys'}`
      : 'None known';
    $('keys-export-summary').textContent = keyCount
      ? `${keyLabel} · .dic dictionary\nOne key per line, without sector assignments.`
      : 'No known keys to export. Read the tag or open a document with known keys.';
    if (keyCount && keyExportReason) {
      $('keys-export-summary').textContent += ` ${keyExportReason}.`;
    }
    $('hf-defaults').hidden = !needsHfDefaults(doc);
    $('hf-defaults').disabled = busy;

    for (const input of $('memory').querySelectorAll('input, textarea')) {
      input.disabled = busy;
      input.readOnly = busy;
    }
    $('memory').querySelector('.hx')?.classList.toggle('busy', busy);

    $('rename').disabled = busy;
    $('close-doc').disabled = busy;

    if (!doc) {
      $('more-menu').hidden = true;
      renderRecents();
      return;
    }

    const classic = isClassic(doc);
    const type2 = doc.kind !== 'lf' && !doc.card.protocol && doc.card.sak === 0;
    const hf = ['st25tb', 'nfc_v'].includes(doc.card.protocol) && !!doc.memory.length;
    const readable = classic || type2 || hf || doc.kind === 'desfire';

    $('read-group').hidden = !readable && !busy;
    $('read').hidden = busy;
    $('stop').hidden = !busy;
    $('read').disabled = !connected || busy || !readable;
    $('read').title = !connected ? 'Connect the Chameleon to read' : '';

    const readOptions = !busy && (classic || type2 || !$('read-slix').hidden);
    $('read-menu').hidden = !readOptions;
    if (!readOptions) {
      $('read-menu').open = false;
    }
    $('read-group').classList.toggle('single', !readOptions);

    $('save-menu').hidden =
      (doc.kind === 'lf' && !doc.memory.length) ||
      doc.kind === 'identity' ||
      (doc.kind === 'st25tb' && doc.type !== ST25TB.TYPE) ||
      (doc.kind === 'nfcv' && !doc.type);
    $('copy-tag').textContent = doc.kind === 'lf' ? 'Program a tag…' : 'Copy to a tag…';
    $('emulate').textContent = emulating ? 'Emulating' : 'Slot & emulate';
    let disabledReason = 'Complete memory and emulator metadata are required';
    if (!connected) {
      disabledReason = 'Connect the Chameleon first';
    } else if (busy) {
      disabledReason = 'Wait for the current operation';
    } else if (invalidEdit) {
      disabledReason = 'Correct the highlighted memory first';
    }

    for (const id of ['save-slot', 'emulate', 'copy-tag', 'export']) {
      $(id).title = $(id).disabled ? disabledReason : '';
    }
    // The firmware keeps NFC-V and NFC-B emulation off while BLE is linked.
    if (state.transport === 'ble' && BLE_PAUSED_TYPES.includes(doc.type) && !$('emulate').disabled) {
      $('emulate').title = 'Emulation starts once Bluetooth disconnects';
    }
    if (emulating && state.transport === 'ble' && BLE_PAUSED_TYPES.includes(doc.type)) {
      $('emulate').textContent = 'Selected';
      $('emulate').title = 'Emulation starts once Bluetooth disconnects';
    }

    $('export').hidden =
      !['classic', 'type2', 'st25tb', 'nfcv', 'desfire'].includes(doc.kind) ||
      (doc.kind === 'classic' && doc.card.uid.length !== 4) ||
      (doc.kind === 'st25tb' && doc.type !== ST25TB.TYPE);
    $('export-mct').hidden = doc.kind !== 'classic';
    $('export-keys').hidden = !classic;
    const jsonOnly = $('export').hidden && $('export-mct').hidden && $('export-keys').hidden;
    $('export-json').hidden = !jsonOnly;
    $('export-menu').hidden = jsonOnly;
    if (jsonOnly) {
      $('export-menu').open = false;
    }
    for (const input of $('lf-card').querySelectorAll('input, select')) {
      input.disabled = busy;
    }
    $('dictionary-edit').disabled = busy;

    const entries = $('dictionary')
      .value.split(/\r?\n/)
      .filter((line) => /^[\da-f]{12}$/i.test(line.trim())).length;
    $('dictionary-count').textContent = `${entries} keys`;

    const defaults = needsType2Defaults(doc) || needsHfDefaults(doc);
    const unread = doc.memory.filter(
      (block, index) => !knownBlock(block) && !(type2 && doc.geometry?.credentials.includes(index))
    ).length;
    const captureDetails = [...new Set(doc.warnings || [])]
      .flatMap((note) => {
        if (type2 && note === TYPE2_NOTES.defaults) {
          return [
            'Emulator defaults: unread passwords become FFFFFFFF, PACK becomes 0000, and an unread Ultralight C key becomes zero.',
            'Missing counters and signature become zero. Original authentication and missing originality data are not reproduced.'
          ];
        }
        return [note];
      })
      .map((note) => {
        const item = document.createElement('li');
        item.textContent = note;
        return item;
      });
    $('capture-details-list').replaceChildren(...captureDetails);
    $('capture-details').hidden = !captureDetails.length;
    $('capture-details-divider').hidden = !classic || !captureDetails.length;
    $('more-menu').hidden = !classic && !captureDetails.length;

    const actions = [];
    if (defaults) {
      actions.push('Some credentials or metadata are missing. Use defaults to prepare emulation.');
    }
    if (unread && !busy && doc.kind !== 'lf') {
      const units = type2 ? 'pages' : 'blocks';
      actions.push(`${unread} ${units} still unread. Read again or keep ?? for unknown bytes.`);
    }
    if (changes?.unknown.length) {
      actions.push(
        `Write changes needs complete original and edited bytes for ${type2 ? 'pages' : 'blocks'} ${changes.unknown.join(', ')}.`
      );
    }
    $('doc-notes-text').textContent = actions.join(' ');
    $('doc-notes').hidden = !actions.length;

    $('studio-target').dataset.target = 'draft';
    if (doc.slot) {
      $('studio-target').dataset.target = emulating ? 'live' : 'slot';
      let slotStatus = '';
      if (emulating) {
        slotStatus = ' · emulating';
      } else if (isDirty()) {
        slotStatus = ' · edited';
      }
      const frequency = doc.slot.sense === 2 ? 'NFC' : 'RFID';
      $('studio-target').textContent = `Slot ${doc.slot.index + 1} · ${frequency}${slotStatus}`;
    }

    $('read-progress').hidden = readStartedAt === null || $('read-elapsed').hidden;
    const mapping = doc.recoveredKeys;
    let total = doc.memory.length;
    let done = doc.memory.filter(knownBlock).length;
    let progressUnit = 'Blocks';
    if (classic && mapping) {
      total = mapping.length * 2;
      done = mapping.reduce((sum, keys) => sum + !!keys.key_a + !!keys.key_b, 0);
      progressUnit = 'Keys';
    } else if (type2) {
      progressUnit = 'Pages';
    } else if (doc.kind === 'lf') {
      progressUnit = 'Records';
    }

    $('progress').max = total || 1;
    $('progress').value = done;
    $('progress-label').textContent = total ? `${progressUnit} ${done}/${total}` : 'Preparing…';
    if (doc.kind === 'desfire') {
      $('progress-label').textContent = 'Public data';
      $('progress').max = 1;
      $('progress').value = +doc.capture.complete;
    }
  }

  function renderDocumentKeys() {
    const doc = state.document;
    $('keys').replaceChildren(
      ...classicDocumentKeys(doc).map((keys, index) => {
        const row = document.createElement('tr');
        for (const value of [index, keys.key_a, keys.key_b]) {
          const cell = document.createElement('td');
          if (Array.isArray(value)) {
            cell.textContent = hex(value);
          } else {
            cell.textContent = value === null ? '------------' : String(value);
          }
          row.append(cell);
        }
        return row;
      })
    );
  }

  function isDirty() {
    return (
      !!state.document &&
      (serializeDraft(state.document) !== state.cleanDocument ||
        !!$('memory').querySelector('[aria-invalid="true"]') ||
        (state.document.kind === 'lf' && !!$('lf-fields').querySelector('[aria-invalid="true"]')))
    );
  }

  function isEmulating() {
    const slot = state.document?.slot;
    const place = state.deviceInfo?.slot?.[slot?.sense === 2 ? 'hf' : 'lf'];
    return (
      !!slot &&
      !isDirty() &&
      !state.deviceInfo?.reader &&
      !state.deviceInfo?.busy &&
      state.deviceInfo?.active_slot === slot.index &&
      !!place?.enabled &&
      place.revision === slot.revision
    );
  }

  function renderMemory() {
    const doc = state.document;
    if (doc) {
      renderIdentity(doc);
    }
    content.render(doc, !!state.controller);
    $('memory-title').textContent = doc?.kind === 'desfire' ? 'Applications & files' : 'Memory';
    if (doc?.kind === 'desfire') {
      $('memory-section').hidden = false;
      $('identity-card').hidden = true;
      $('memory-legend').replaceChildren();
      $('memory-status').textContent = doc.capture.complete ? 'Public read complete' : 'Partial capture';
      renderDesfire(doc, $('memory'));
      return;
    }

    const blocks = doc?.memory || [];
    $('memory-section').hidden = !blocks.length || doc?.kind === 'lf';
    $('identity-card').hidden = !doc || !!blocks.length;
    const noun = { type2: 'pages', lf: 'records' }[doc?.kind] || 'blocks';
    const known = blocks.filter(knownBlock).length;
    $('memory-status').textContent = blocks.length ? `${known}/${blocks.length} ${noun} known` : '';
    $('memory-status').className = `count ${known === blocks.length ? 'ok' : 'partial'}`;
    $('memory-status').hidden = doc?.kind === 'lf';
    if (!doc || !blocks.length) {
      renderDocumentKeys();
      $('memory').replaceChildren();
      return;
    }
    if (doc.kind === 'lf') {
      $('memory').replaceChildren();
      lf.render();
      return;
    }

    renderDocumentKeys();
    $('memory').replaceChildren(
      ...memoryEditor(doc, {
        busy: !!state.controller,
        onInput(parsed) {
          if (parsed) {
            // Validate every row before committing any bytes to the document.
            if (doc.kind === 'st25tb') {
              doc.memory = parsed.slice(0, blocks.length);
              doc.card.system = parsed[blocks.length];
            } else {
              parsed.forEach((bytes, block) => {
                if (bytes) {
                  editBlock(doc, block, bytes);
                } else {
                  doc.memory[block] = null;
                }
              });
            }
            $('status').textContent = 'Document edited · physical tag and slots are unchanged';
            renderIdentity(doc);
            renderDocumentKeys();
            content.render(doc, false);
            const count = doc.memory.filter(knownBlock).length;
            $('memory-status').textContent = `${count}/${blocks.length} ${noun} known`;
            $('memory-status').className = `count ${count === blocks.length ? 'ok' : 'partial'}`;
            saveDraft();
          }
          controls();
        }
      })
    );

    $('memory-legend').replaceChildren(
      ...(EDITOR_LEGENDS[doc.kind] || []).map(([tone, label]) => {
        const item = document.createElement('span');
        item.className = `t-${tone}`;
        const swatch = document.createElement('i');
        const text = document.createElement('span');
        text.textContent = label;
        item.append(swatch, text);
        return item;
      })
    );
  }

  function render() {
    const doc = state.document;
    $('capture-details-dialog').close();
    $('keys').replaceChildren();
    $('progress').value = 0;

    const classic = isClassic(doc);
    document.querySelectorAll('[data-classic]').forEach((element) => {
      element.hidden = !classic;
    });
    $('type2-controls').hidden = !doc?.card || doc.kind === 'lf' || doc.card.sak !== 0;
    $('studio-empty').hidden = !!doc;
    $('studio-document').hidden = !doc;
    $('close-doc').hidden = !doc;

    if (!doc) {
      $('empty-context').textContent =
        'Import a file, drop one anywhere on this page, or create a Classic, NTAG, Ultralight or RFID document.';
      controls();
      return;
    }

    $('studio-name').textContent = doc.name;
    let familyName = 'NFC-A';
    if (doc.kind === 'lf' && !doc.type) {
      familyName = 'RFID · chip only';
    } else if (doc.kind === 'desfire') {
      familyName = doc.geometry.name;
    } else if (doc.type) {
      familyName = typeName(doc.type);
    } else if (doc.geometry?.name) {
      familyName = doc.geometry.name;
    } else if (classic) {
      const type = { 9: 1000, 8: 1001, 16: 1002, 24: 1003 }[doc.card.sak & ~0x20];
      familyName = typeName(type);
    } else if (doc.card.sak === 0) {
      familyName = 'Type 2 candidate';
    }
    $('studio-family').textContent = familyName;

    $('hf-details').hidden = !doc.card.protocol;
    $('hf-details').textContent = '';
    $('lf-chip').hidden = doc.kind !== 'lf';
    if (doc.kind === 'lf') {
      renderLfChip($('lf-chip'), doc.lf?.chip);
    }
    if (doc.card.protocol) {
      $('hf-details').textContent = doc.kind === 'desfire' ? 'ISO-DEP · Public data' : hfDetails(doc);
    }

    $('studio-target').textContent = 'Draft · not saved to a slot';
    if (doc.slot) {
      const frequency = doc.slot.sense === 2 ? 'NFC' : 'RFID';
      $('studio-target').textContent = `Slot ${doc.slot.index + 1} · ${frequency}`;
    }
    $('save-slot').textContent = doc.slot ? `Update slot ${doc.slot.index + 1}` : 'Save to slot…';
    $('memory-section').hidden = !doc.memory.length || doc.kind === 'lf';
    $('lf-card').hidden = doc.kind !== 'lf' || !doc.memory.length;
    $('identity-card').hidden = doc.kind !== 'identity' && !(doc.kind === 'lf' && !doc.memory.length);
    const unreadClassic = classic && doc.kind === 'identity';
    $('identity-unreadable-mark').setAttribute('visibility', unreadClassic ? 'hidden' : 'visible');
    $('identity-title').textContent = unreadClassic ? 'Memory not read' : 'Memory not readable';
    $('identity-reason').textContent = unreadClassic
      ? 'Choose Read to recover keys and read the card memory.'
      : (doc.warnings || []).join(' ') || 'Memory reading is unsupported for this tag.';
    $('identity-help').textContent = unreadClassic
      ? 'Use the … menu to change UID, repair or factory format the tag.'
      : 'The identity above is all this capture holds. Export JSON keeps it.';
    if (doc.kind === 'type2') {
      // A document's model is not a manual choice for the next physical read.
      $('type2-profile').value = 'auto';
    }

    renderMemory();
    controls();
  }

  return {
    controls,
    render,
    renderMemory,
    isDirty,
    isEmulating,
    renderDocumentKeys,
    clearFeedback,
    startReadTime,
    finishReadTime
  };
}
