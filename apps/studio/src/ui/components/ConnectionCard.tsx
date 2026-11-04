import { useEffect, useState } from 'react';
import type { DeviceInfo, SessionInfo } from '../../shared/api-types.ts';
import { RefreshIcon } from './Icons.tsx';

type Props = {
  devices: DeviceInfo[];
  deviceId: string;
  appId: string;
  session: SessionInfo;
  busy: string | null;
  caseActive: boolean;
  onDeviceChange: (deviceId: string) => void;
  onAppIdChange: (appId: string) => void;
  onRefreshDevices: () => void;
  onOpen: () => void;
  onClose: () => void;
  onOpenSetup: () => void;
};

function deviceName(devices: DeviceInfo[], id: string | undefined): string {
  return devices.find((device) => device.id === id)?.name ?? id ?? '';
}

/**
 * Above the Record and Cases tabs: which phone and app the studio is on. Connected,
 * it is one line; Change opens the device and app id fields again.
 */
export function ConnectionCard(props: Props) {
  const { devices, deviceId, appId, session, busy, caseActive } = props;
  const [changing, setChanging] = useState(false);

  // A new connection, or losing one, closes the fields again.
  useEffect(() => {
    setChanging(false);
  }, [session.open, session.deviceId, session.appId]);

  if (session.open && !changing) {
    return (
      <section className="connection connection-on" aria-label="Device">
        <span className="connection-dot" aria-hidden="true" />
        <span className="connection-summary" title={`${session.deviceId} · ${session.appId}`}>
          <strong>{deviceName(devices, session.deviceId)}</strong>
          <span className="connection-meta">{session.deviceId}</span>
          <span className="connection-app">{session.appId}</span>
        </span>
        <button
          type="button"
          onClick={() => setChanging(true)}
          disabled={Boolean(busy) || caseActive}
          title={caseActive ? 'Finish or discard the case first' : 'Connect to another device or app'}
        >
          Change
        </button>
        <button type="button" onClick={props.onClose} disabled={Boolean(busy)}>
          Disconnect
        </button>
      </section>
    );
  }

  return (
    <section className="connection" aria-label="Device">
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.onOpen();
        }}
      >
        <label className="connection-field">
          <span className="field-label">Device</span>
          <span className="connection-device">
            <select aria-label="Device" value={deviceId} onChange={(event) => props.onDeviceChange(event.target.value)} disabled={Boolean(busy)}>
              {devices.length === 0 && <option value="">No device found</option>}
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} ({device.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button"
              onClick={props.onRefreshDevices}
              disabled={Boolean(busy)}
              title="Reload the device list"
              aria-label="Reload the device list"
            >
              <RefreshIcon />
            </button>
          </span>
        </label>
        <label className="connection-field">
          <span className="field-label">App id</span>
          <input
            aria-label="App id"
            value={appId}
            onChange={(event) => props.onAppIdChange(event.target.value)}
            placeholder="com.example.app"
            spellCheck={false}
          />
        </label>
        <span className="connection-actions">
          <button type="submit" className="primary" disabled={Boolean(busy) || !deviceId || !appId.trim() || caseActive}>
            Connect
          </button>
          {session.open && (
            <button type="button" onClick={() => setChanging(false)} disabled={Boolean(busy)}>
              Cancel
            </button>
          )}
        </span>
      </form>
      <p className="connection-help">
        {devices.length === 0 ? 'No emulator or phone found. ' : 'Device not listed? '}
        <button type="button" className="link" onClick={props.onOpenSetup}>
          Device setup
        </button>
      </p>
    </section>
  );
}
