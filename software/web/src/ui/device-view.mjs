import { request, hex, setDeviceTransport, deviceTransportType } from '../device/transport.mjs';
import { connectBluetooth } from '../device/bluetooth.mjs';
import { decodeSlot } from '../device/slots.mjs';
import { HOSTED } from '../runtime/environment.mjs';

export const $ = (id) => document.getElementById(id);

export const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );

const ACTIONS = [
  'Nothing',
  'Next slot',
  'Previous slot',
  'Clone a tag UID',
  'Show battery level',
  'NFC field on/off',
  'Open Bluetooth web app'
];
const SETTINGS = ['animation', 'press_a', 'press_b', 'long_a', 'long_b', 'sleep', 'long_ms', 'pairing'];

// Firmware cannot emulate these HF families while a BLE link is active. The
// image remains selected and emulation starts once Bluetooth disconnects.
export const BLE_PAUSED_TYPES = [1500, 1501, 2000];
const PAUSED_FAMILY = { 1500: 'NFC-V', 1501: 'NFC-V', 2000: 'NFC-B' };

const glyph = (body) =>
  `<svg class="cu-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  ble: glyph('<path d="M7 7.5 17 16.5 12 21V3l5 4.5L7 16.5"/>'),
  usb: glyph('<path d="M9 3v4M15 3v4M6.5 7h11v4a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>')
};
const SPINNER = '<span class="cu-spin" aria-hidden="true"></span>';

export function deviceViews({
  notify,
  onConnection,
  canConnect = () => true,
  open = () => {},
  onFirmwareUpdate = () => {}
}) {
  let info;
  let refreshPromise;
  let generation = 0;
  let bluetoothTransport;
  let connecting = false;
  let closing = false;
  let savingSettings = false;
  let checked = false;
  let lostReason = '';
  let lastError = '';
  const bluetoothAvailable = !!globalThis.navigator?.bluetooth && globalThis.isSecureContext;
  // The Ultra serves its USB app on plain HTTP, where Web Bluetooth does not
  // exist. Only localhost development and the hardware bench offer both.
  const dual = !HOSTED && bluetoothAvailable;
  const ble = () => deviceTransportType() === 'ble';

  function phase() {
    if (info) {
      return 'connected';
    }
    if (connecting) {
      return 'connecting';
    }
    if (ble() && bluetoothTransport) {
      return bluetoothTransport.closed ? 'lost' : 'error';
    }
    if (HOSTED) {
      return bluetoothAvailable ? 'idle' : 'unsupported';
    }
    return checked ? 'unreachable' : 'checking';
  }

  function pausedEmulation() {
    const hf = info?.slot.hf;
    return ble() && info && !info.reader && !info.busy && hf.enabled && BLE_PAUSED_TYPES.includes(hf.type)
      ? hf.type
      : 0;
  }

  function copy(current) {
    switch (current) {
      case 'connected':
        return ['Chameleon Ultra', `Connected over ${ble() ? 'Bluetooth' : 'USB'}`];
      case 'connecting':
        return ['Connecting…', 'Choose your Ultra in the browser window.'];
      case 'idle':
        return [
          'Connect your Ultra',
          'Press a button on the Ultra to wake it, then choose it in the browser window.'
        ];
      case 'lost':
        return ['Not connected', lostReason || 'Bluetooth disconnected. Reconnect to control the device.'];
      case 'error':
        return ['Device not responding', lastError || 'Refresh to read the device again.'];
      case 'unsupported':
        return [
          'Bluetooth unavailable',
          'This browser has no Web Bluetooth. Use Chrome or Edge on a computer or Android, or Bluefy on iPhone and iPad.'
        ];
      case 'unreachable':
        return [
          'Ultra not reachable',
          dual
            ? 'Check the USB cable and wake the Ultra, or connect over Bluetooth.'
            : 'Check the USB cable and wake the Ultra, then retry.'
        ];
      default:
        return ['Connecting…', 'Looking for your Ultra over USB.'];
    }
  }

  function paintPill(pill, current) {
    pill.removeAttribute('aria-label');
    if (current === 'connected') {
      const percent = info.battery_percent;
      pill.innerHTML = `${ICONS[ble() ? 'ble' : 'usb']}<span class="cu-batt" aria-hidden="true"><i
        style="width:${percent}%"></i></span>${percent}%`;
      pill.setAttribute(
        'aria-label',
        `Connected over ${ble() ? 'Bluetooth' : 'USB'}. Battery ${percent} percent. Open device details.`
      );
      pill.dataset.state = percent <= 15 ? 'low' : 'connected';
    } else if (current === 'checking' || current === 'connecting') {
      pill.innerHTML = `${SPINNER}Connecting…`;
      pill.dataset.state = 'pending';
    } else if ((current === 'idle' || current === 'lost') && bluetoothAvailable) {
      pill.innerHTML = `${ICONS.ble}${current === 'lost' ? 'Reconnect' : 'Connect'}`;
      pill.dataset.state = 'disconnected';
    } else {
      pill.textContent = current === 'unsupported' ? 'No Bluetooth' : 'Not connected';
      pill.dataset.state = 'offline';
    }
  }

  function paint() {
    for (const field of $('device-settings').querySelectorAll('[data-setting]')) {
      field.disabled = savingSettings;
    }
    const current = phase();
    const connected = current === 'connected';
    const [title, help] = copy(current);

    for (const pill of document.querySelectorAll('[data-connection]')) {
      paintPill(pill, current);
    }

    $('connection-card').dataset.state = current;
    $('connection-glyph').innerHTML =
      current === 'checking' || current === 'connecting' ? SPINNER : ICONS[ble() || HOSTED ? 'ble' : 'usb'];
    $('connection-title').textContent = title;
    $('connection-help').textContent = help;
    $('device-rows').hidden = !connected;
    $('device-settings').hidden = !connected;
    $('emulation-state').hidden = !connected;
    $('nav-slot').hidden = !connected;

    // Controls that change an existing link sit beside the status they change;
    // without a link, connecting is the card's primary action.
    const connectButton = $('connect-bluetooth');
    const place = $(connected ? 'connection-tools' : 'connection-actions');
    if (connectButton.parentElement !== place) {
      place.append(connectButton);
    }
    connectButton.hidden = !bluetoothAvailable || (connected && ble());
    connectButton.disabled = connecting;
    connectButton.className = connected ? 'mini-action' : 'btn primary';
    const connectLabel = bluetoothTransport ? 'Reconnect Bluetooth' : 'Connect Bluetooth';
    connectButton.textContent = connecting ? 'Connecting…' : connectLabel;
    $('use-usb').hidden = HOSTED || !ble();
    $('use-usb').disabled = connecting;
    $('disconnect-bluetooth').hidden = !bluetoothTransport || bluetoothTransport.closed;
    $('disconnect-bluetooth').disabled = connecting;
    $('connection-tools').hidden =
      $('use-usb').hidden && $('disconnect-bluetooth').hidden && (!connected || connectButton.hidden);
    $('connection-actions').hidden = connected || connectButton.hidden;

    const unavailable = (HOSTED || ble()) && !bluetoothAvailable;
    $('firmware-update-link').setAttribute('aria-disabled', String(unavailable));
    $('firmware-update-note').hidden = !unavailable;

    // Scan cannot work without a device: lead with the way to get one.
    const prompt = !connected && !['checking', 'error'].includes(current);
    $('scanner').hidden = prompt;
    $('scan-modes').hidden = prompt;
    $('tonie-actions').hidden = prompt;
    $('scan-connect').hidden = !prompt;
    $('scan-connect').dataset.state = current;
    $('scan-connect-glyph').innerHTML = $('connection-glyph').innerHTML;
    $('scan-connect-title').textContent = title;
    $('scan-connect-detail').textContent = help;
    const retryOnly = current === 'unreachable' && !bluetoothAvailable;
    $('scan-connect-button').hidden = current === 'unsupported';
    $('scan-connect-button').disabled = connecting;
    $('scan-connect-button').textContent = retryOnly ? 'Retry' : connectButton.textContent;
    $('scan-connect-secondary').hidden = !(current === 'unreachable' && bluetoothAvailable);
  }

  /** @param {boolean} [owned] The caller owns the device, as a firmware update does; errors are its own. */
  async function connect(owned = false, signal) {
    signal?.throwIfAborted();
    if (connecting) {
      if (owned) {
        throw new Error('A Bluetooth connection is already in progress.');
      }
      return;
    }
    if (!owned && !canConnect()) {
      notify('Finish or stop the current operation before changing the connection.', true);
      return;
    }
    connecting = true;
    paint();
    let transport;
    try {
      if (bluetoothTransport && !bluetoothTransport.closed) {
        closing = true;
        bluetoothTransport.disconnect();
      }
      transport = await connectBluetooth({
        onDisconnect: (reason) => disconnected(transport, reason)
      });
      signal?.throwIfAborted();
      bluetoothTransport = transport;
      lostReason = '';
      setDeviceTransport(transport);
      await refresh(true);
      signal?.throwIfAborted();
      return transport;
    } catch (error) {
      if (signal?.aborted) {
        transport?.disconnect(error);
      }
      if (owned) {
        throw error;
      }
      if (error.name !== 'NotFoundError') {
        notify(error.message, true);
      }
    } finally {
      closing = false;
      connecting = false;
      paint();
    }
  }

  function disconnected(transport, reason) {
    // Initialization failures and replaced or abandoned links are reported elsewhere.
    if (!transport || transport !== bluetoothTransport) {
      return;
    }
    const requested = closing;
    closing = false;
    const generic = !reason || /^Bluetooth (is )?disconnected/.test(reason.message);
    lostReason = generic ? '' : reason.message;
    info = null;
    paint();
    if (!requested) {
      notify(lostReason || 'Bluetooth connection lost.', true, { label: 'Reconnect', run: connect });
    }
    void refresh(true);
  }

  function disconnect() {
    if (!canConnect()) {
      notify('Finish or stop the current operation before changing the connection.', true);
      return false;
    }
    closing = true;
    bluetoothTransport?.disconnect();
    closing = false;
    return true;
  }

  async function retry() {
    const result = await refresh(true);
    if (!result.ok && !result.stale) {
      notify('The Ultra is still not reachable.', true);
    }
  }

  $('firmware-update-link').onclick = (event) => {
    if (!canConnect()) {
      event.preventDefault();
      notify('Finish the current operation before updating firmware.', true);
      return;
    }
    if (HOSTED || ble()) {
      event.preventDefault();
      if (!bluetoothAvailable) {
        notify('Finish the current operation and use a Web Bluetooth browser or connect over USB.', true);
        return;
      }
      Promise.resolve(
        onFirmwareUpdate(bluetoothTransport, () => {
          closing = true;
        })
      )
        .catch((error) => notify(error.message, true))
        .finally(() => {
          closing = false;
        });
    }
  };

  for (const pill of document.querySelectorAll('[data-connection]')) {
    pill.onclick = () => {
      if (['idle', 'lost'].includes(phase()) && bluetoothAvailable) {
        void connect();
      } else {
        open();
      }
    };
  }

  $('connect-bluetooth').onclick = () => connect();
  $('scan-connect-button').onclick = () =>
    phase() === 'unreachable' && !bluetoothAvailable ? retry() : connect();
  $('scan-connect-secondary').onclick = retry;
  $('disconnect-bluetooth').onclick = disconnect;
  $('emulation-resume').onclick = () => {
    const family = PAUSED_FAMILY[pausedEmulation()];
    if (disconnect()) {
      notify(`Bluetooth disconnected. ${family} emulation resumes on your Ultra.`);
    }
  };

  $('use-usb').onclick = async () => {
    if (HOSTED) {
      return;
    }
    if (!canConnect()) {
      notify('Finish or stop the current operation before changing the connection.', true);
      return;
    }
    const transport = bluetoothTransport;
    bluetoothTransport = null;
    transport?.disconnect();
    lostReason = '';
    setDeviceTransport(null);
    await refresh(true);
  };
  paint();

  function render() {
    const settings = info.settings;
    const paused = pausedEmulation();
    const places = ['hf', 'lf'].filter((sense) => info.slot[sense].type && info.slot[sense].enabled);
    const frequencies = places
      .map((sense) => {
        if (sense === 'lf') {
          return 'RFID';
        }
        // Non-breaking spaces: the narrow sidebar may wrap only before "+".
        return paused ? 'NFC paused' : 'NFC';
      })
      .join(' + ');
    let slotLabel = `Slot ${info.active_slot + 1}`;
    let emulationDetail = 'Enabled NFC and RFID places are available for emulation';
    let emulationState = info.reader ? '' : ' active';
    if (info.busy) {
      slotLabel = 'Device busy';
      emulationDetail = 'A reader operation owns the device';
    } else if (info.reader) {
      slotLabel = 'Reader mode';
      emulationDetail = 'Ready for a reader operation';
    } else if (paused) {
      emulationDetail = `${PAUSED_FAMILY[paused]} paused while Bluetooth is connected`;
      emulationState = places.length > 1 ? ' active' : ' paused';
    }

    $('nav-slot-title').textContent = slotLabel;
    $('nav-slot-detail').textContent = frequencies || 'tags disabled';
    $('nav-slot-detail').hidden = info.busy || info.reader;
    let navState = 'idle';
    if (!info.busy && !info.reader && places.length) {
      navState = emulationState === ' paused' ? 'paused' : 'emulating';
    }
    $('nav-slot').dataset.state = navState;
    $('emulation-state').className = `emulation-state${emulationState}`;
    $('emulation-title').textContent = info.reader ? 'Reader mode' : `Slot ${info.active_slot + 1} selected`;
    $('emulation-detail').textContent = emulationDetail;
    $('emulation-resume').hidden = !paused;
    $('device-rows').innerHTML = `
      <div class="device-row"><span>Firmware</span><strong>v${escape(info.version)}</strong></div>
      <div class="device-row">
        <span>Battery</span>
        <strong>${info.battery_percent}% · ${(info.battery_mv / 1000).toFixed(2)} V</strong>
      </div>
      <div class="device-row"><span>Active slot</span><strong>${info.active_slot + 1}</strong></div>
      <div class="device-row"><span>Build</span><strong>${escape(info.git)}</strong></div>
      <div class="device-row"><span>Chip ID</span><strong><code>${escape(info.chip)}</code></strong></div>`;

    const select = (key, label, options) => {
      const choices = options
        .map(([value, name]) => {
          const selected = Number(settings[key]) === value ? ' selected' : '';
          return `<option value="${value}"${selected}>${name}</option>`;
        })
        .join('');
      return `<label class="field">${label}<select data-setting="${key}">${choices}</select></label>`;
    };

    const field = (key, label, min, max) =>
      `<label class="field">${label}<input data-setting="${key}" type="number"
        min="${min}" max="${max}" value="${settings[key]}"></label>`;

    const buttonSettings = [
      ['press_a', 'A · press'],
      ['press_b', 'B · press'],
      ['long_a', 'A · long press'],
      ['long_b', 'B · long press']
    ]
      .map(([key, label]) =>
        select(
          key,
          label,
          ACTIONS.map((label, i) => [i, label])
        )
      )
      .join('');
    const animation = select('animation', 'LED animation', [
      [0, 'Full'],
      [1, 'Minimal'],
      [3, 'Symmetric'],
      [2, 'None']
    ]);
    const pairing = select('pairing', 'Require pairing', [
      [0, 'Off'],
      [1, 'On']
    ]);
    const pairingHint = ble()
      ? 'Pairing changes may require a device restart, which ends this Bluetooth connection.'
      : 'Pairing changes may require a device restart.';

    $('device-settings').innerHTML = `
      <div class="card">
        <h3 class="cu-h">Buttons</h3>
        <div class="cu-grid">
          ${buttonSettings}
          ${field('long_ms', 'Long press after · ms', 200, 65535)}
          ${field('sleep', 'Sleep after · seconds', 5, 60)}
        </div>
      </div>
      <div class="card">
        <h3 class="cu-h">LEDs</h3>
        <div class="cu-grid">${animation}</div>
      </div>
      <div class="card">
        <h3 class="cu-h">Bluetooth pairing</h3>
        <div class="cu-grid">
          ${pairing}
          <label class="field">New pairing PIN<input data-setting="pin" inputmode="numeric"
            maxlength="6" placeholder="6 digits" autocomplete="off"></label>
        </div>
        <p class="memory-hint">${pairingHint}</p>
      </div>`;
  }

  async function load(expectedGeneration) {
    try {
      const next = await request('/api/device');
      if (expectedGeneration !== generation) {
        return { ok: false, stale: true };
      }
      if (
        !next.settings ||
        !Number.isInteger(next.active_slot) ||
        next.active_slot < 0 ||
        next.active_slot > 7 ||
        !Number.isInteger(next.battery_percent) ||
        next.battery_percent < 0 ||
        next.battery_percent > 100
      ) {
        throw new Error('Invalid device response');
      }

      next.slot = decodeSlot(await request(`/api/slot/${next.active_slot}`));
      if (expectedGeneration !== generation) {
        return { ok: false, stale: true };
      }
      info = next;
      checked = true;
      lastError = '';
      render();
      paint();

      onConnection(true, info, ble() ? 'ble' : 'usb');
      return { ok: true };
    } catch (error) {
      if (expectedGeneration !== generation) {
        return { ok: false, stale: true };
      }
      info = null;
      checked = true;
      lastError = error.message;
      paint();
      onConnection(false, null, phase());
      return { ok: false, error };
    }
  }

  function refresh(force = false) {
    if (force) {
      generation++;
      refreshPromise = null;
    }
    if (!refreshPromise) {
      const promise = load(generation).finally(() => {
        if (refreshPromise === promise) {
          refreshPromise = null;
        }
      });
      refreshPromise = promise;
    }
    return refreshPromise;
  }

  $('device-settings').onchange = async (event) => {
    const field = event.target;
    const key = field.dataset.setting;
    if (!key || savingSettings) {
      return;
    }

    const value = field.value.trim();
    let payload;
    if (key === 'pin') {
      if (!/^\d{6}$/.test(value)) {
        notify('The pairing PIN must be exactly 6 digits.', true);
        return;
      }
      payload = [8, ...new TextEncoder().encode(value)];
    } else {
      const id = SETTINGS.indexOf(key);
      const number = Number(value);
      if (id < 0 || !/^\d+$/.test(value) || !field.checkValidity()) {
        notify('Enter a value within the allowed range.', true);
        return;
      }
      payload = id === 6 ? [id, number >> 8, number & 255] : [id, number];
    }

    savingSettings = true;
    paint();
    try {
      const bytes = await request('/api/settings', new Uint8Array(payload));
      if (bytes.length !== 2 || bytes[0] !== 0 || bytes[1] !== 0x68) {
        throw new Error(`Settings save unconfirmed (${hex(bytes)})`);
      }
      notify('Saved on the device.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      // A refresh started before this write may contain the old settings.
      // Invalidate it and keep the edited field disabled through confirmation.
      await refresh(true);
      savingSettings = false;
      paint();
    }
  };

  return {
    refresh,
    connect,
    disconnect,
    bluetooth: () => !!info && ble(),
    emulationPaused: () => !!pausedEmulation()
  };
}
