const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Interfaces = imports.misc.interfaces;
const Util = imports.misc.util;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Clutter = imports.gi.Clutter;
const Cvc = imports.gi.Cvc;
const NM = imports.gi.NM;
const Gettext = imports.gettext;

const UUID = 'quick-settings@Dimitry4Now';
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(text) {
    return Gettext.dgettext(UUID, text);
}

const POWER_CYCLE = { 'balanced': 'performance', 'performance': 'power-saver', 'power-saver': 'balanced' };
const POWER_LABELS = { 'balanced': _('Balanced'), 'performance': _('Performance'), 'power-saver': _('Power Saver') };

const BLUEZ = 'org.bluez';
const BLUEZ_ADAPTER = 'org.bluez.Adapter1';
const BLUEZ_DEVICE = 'org.bluez.Device1';
const BLUEZ_BATTERY = 'org.bluez.Battery1';
const MAX_OTHER_BT_DEVICES = 12;

function getSettings(schemaId) {
    let source = Gio.SettingsSchemaSource.get_default();
    if (!source.lookup(schemaId, true))
        return null;
    return new Gio.Settings({ schema_id: schemaId });
}

function run(command, callback) {
    Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
        if (callback)
            callback((stdout || '').trim(), exitCode);
    });
}

function symbolicIcon(iconName, size = 16) {
    return new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: size, y_align: Clutter.ActorAlign.CENTER });
}

function ssidToText(ssid) {
    return ssid ? NM.utils_ssid_to_utf8(ssid.get_data()) : '';
}

function signalIcon(strength) {
    if (strength > 80)
        return 'network-wireless-signal-excellent-symbolic';
    if (strength > 55)
        return 'network-wireless-signal-good-symbolic';
    if (strength > 30)
        return 'network-wireless-signal-ok-symbolic';
    if (strength > 5)
        return 'network-wireless-signal-weak-symbolic';
    return 'network-wireless-signal-none-symbolic';
}

function bluetoothIcon(iconName) {
    let symbolic = iconName ? `${iconName}-symbolic` : '';
    return symbolic && Gtk.IconTheme.get_default().has_icon(symbolic) ? symbolic : 'bluetooth-active-symbolic';
}

function proxyProperty(proxy, name) {
    let value = proxy.get_cached_property(name);
    return value ? value.deepUnpack() : null;
}

// Drops the "GDBus.Error:org.bluez.Error.Failed: " prefix from remote errors.
function errorText(error) {
    return error.message.replace(/^GDBus\.Error:[\w.]+: /, '');
}

// Left click runs onToggle, right click opens the related settings tool.
// With onOpen, the round icon toggles and the rest of the tile opens a detail view.
class Tile {
    constructor(iconName, title, onToggle, onOpen) {
        this.actor = new St.Button({
            style_class: 'qs-tile',
            can_focus: true,
            x_fill: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });

        let box = new St.BoxLayout({ style_class: 'qs-tile-box', x_expand: true });
        let iconBin = onOpen
            ? new St.Button({ style_class: 'qs-tile-icon-bin qs-tile-icon-button' })
            : new St.Bin({ style_class: 'qs-tile-icon-bin' });
        this.icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        iconBin.set_child(this.icon);
        if (onOpen)
            iconBin.connect('clicked', () => onToggle());

        let labels = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this.title = new St.Label({ text: title, style_class: 'qs-tile-title' });
        this.subtitle = new St.Label({ text: '', style_class: 'qs-tile-subtitle' });
        labels.add_child(this.title);
        labels.add_child(this.subtitle);

        box.add_child(iconBin);
        box.add_child(labels);
        if (onOpen)
            box.add_child(symbolicIcon('go-next-symbolic', 12));
        this.actor.set_child(box);

        this.actor.connect('clicked', (button, clickedButton) => {
            if (clickedButton === 3)
                this.onSettings();
            else if (onOpen)
                onOpen();
            else
                onToggle();
        });
        this.onSettings = () => {};
    }

    setState(active, subtitle) {
        this.actor.checked = active;
        this.subtitle.text = subtitle;
    }
}

// Slider with a clickable icon on the left (used for mute).
class QSSlider extends PopupMenu.PopupSliderMenuItem {
    constructor(iconName, onIconClicked) {
        super(0);

        this.iconButton = new St.Button({ style_class: 'qs-slider-icon', reactive: !!onIconClicked });
        this.icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        this.iconButton.set_child(this.icon);
        if (onIconClicked)
            this.iconButton.connect('clicked', onIconClicked);

        this.removeActor(this._slider);
        this.addActor(this.iconButton, { span: 0 });
        this.addActor(this._slider, { span: -1, expand: true });
    }
}

// Second-level page (Wi-Fi networks, Bluetooth devices) shown in place of the tiles.
// footerButtons: [[label, callback], ...]; the last one is pushed to the right.
class DetailView {
    constructor(title, onBack, onToggle, footerButtons) {
        this.section = new PopupMenu.PopupMenuSection();
        this.section.actor.hide();

        let view = new St.BoxLayout({ vertical: true, style_class: 'qs-detail-view' });

        let header = new St.BoxLayout({ style_class: 'qs-detail-header' });
        let back = new St.Button({ style_class: 'qs-round-button', can_focus: true });
        back.set_child(symbolicIcon('go-previous-symbolic'));
        back.connect('clicked', onBack);
        this.pill = new St.Button({
            style_class: 'qs-pill',
            can_focus: true,
            label: _('Off'),
            x_align: St.Align.MIDDLE,
            y_align: St.Align.MIDDLE,
        });
        this.pill.connect('clicked', onToggle);
        header.add_child(back);
        header.add_child(new St.Label({ text: title, style_class: 'qs-detail-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        header.add_child(new St.Bin({ child: this.pill, y_align: St.Align.MIDDLE, y_fill: false }));

        this.status = new St.Label({ text: '', style_class: 'qs-detail-status' });

        this.list = new St.BoxLayout({ vertical: true, style_class: 'qs-list' });
        let scroll = new St.ScrollView({
            style_class: 'qs-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scroll.add_actor(this.list);

        let footer = new St.BoxLayout({ style_class: 'qs-detail-footer' });
        footerButtons.forEach(([label, callback], i) => {
            if (i === footerButtons.length - 1)
                footer.add_child(new St.Widget({ x_expand: true }));
            let button = new St.Button({ style_class: 'qs-text-button', can_focus: true, label: label });
            button.connect('clicked', callback);
            footer.add_child(button);
        });

        view.add_child(header);
        view.add_child(this.status);
        view.add_child(scroll);
        view.add_child(footer);
        this.section.addActor(view);
    }

    get visible() {
        return this.section.actor.visible;
    }

    setEnabled(enabled) {
        this.pill.label = enabled ? _('On') : _('Off');
        this.pill.checked = enabled;
    }

    clear() {
        this.list.destroy_all_children();
    }

    addHeading(text) {
        this.list.add_child(new St.Label({ text: text, style_class: 'qs-list-heading' }));
    }

    addMessage(text) {
        this.list.add_child(new St.Label({ text: text, style_class: 'qs-detail-status' }));
    }

    // Row with icon, name, optional detail line, lock icon, two-step forget button and check mark.
    addRow({ icon, name, detail, secure, connected, onClick, onForget }) {
        let row = new St.Button({ style_class: 'qs-list-row', can_focus: true, x_expand: true, x_fill: true });
        if (connected)
            row.add_style_pseudo_class('connected');

        let box = new St.BoxLayout({ style_class: 'qs-list-row-box', x_expand: true });
        box.add_child(symbolicIcon(icon));

        let labels = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        labels.add_child(new St.Label({ text: name, style_class: 'qs-list-name' }));
        if (detail)
            labels.add_child(new St.Label({ text: detail, style_class: 'qs-tile-subtitle' }));
        box.add_child(labels);

        if (secure)
            box.add_child(symbolicIcon('network-wireless-encrypted-symbolic', 14));

        if (onForget) {
            // First click arms the button, second click forgets.
            let forget = new St.Button({ style_class: 'qs-list-forget', can_focus: true });
            forget.set_child(symbolicIcon('edit-delete-symbolic', 14));
            forget.connect('clicked', () => {
                if (forget._armed) {
                    onForget();
                    return;
                }
                forget._armed = true;
                forget.add_style_pseudo_class('armed');
                forget.set_child(new St.Label({ text: 'Forget?' }));
            });
            box.add_child(forget);
        }

        if (connected)
            box.add_child(symbolicIcon('object-select-symbolic'));

        row.set_child(box);
        row.connect('clicked', onClick);
        this.list.add_child(row);
    }
}

class QuickSettingsApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_icon_symbolic_path(metadata.path + '/icons/quick-settings-symbolic.svg');
        this.set_applet_tooltip(_('Quick Settings'));

        // Dark Mode tile: the themes it switches between (empty = leave that theme alone).
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        for (let key of ['dark-gtk-theme', 'light-gtk-theme', 'dark-cinnamon-theme', 'light-cinnamon-theme',
                         'dark-icon-theme', 'light-icon-theme'])
            this.settings.bind(key, key.replace(/-(\w)/g, (m, c) => c.toUpperCase()), () => this._syncSettingsTiles());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.box.add_style_class_name('qs-menu');
        this.menuManager.addMenu(this.menu);

        this._notifSettings = getSettings('org.cinnamon.desktop.notifications');
        this._colorSettings = getSettings('org.cinnamon.settings-daemon.plugins.color');
        this._ifaceSettings = getSettings('org.cinnamon.desktop.interface');
        this._themeSettings = getSettings('org.cinnamon.theme');
        this._portalSettings = getSettings('org.x.apps.portal');

        this._settingsSignals = [];
        this._syncIds = {};
        this._buildMenu();
        this._setupNetwork();
        this._setupBluetooth();

        for (let settings of [this._notifSettings, this._colorSettings, this._ifaceSettings]) {
            if (settings)
                this._settingsSignals.push([settings, settings.connect('changed', () => this._syncSettingsTiles())]);
        }

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._refresh();
            else
                this._showMain();
        });
        this._refresh();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        for (let [settings, id] of this._settingsSignals)
            settings.disconnect(id);
        this._disconnectSink();
        if (this._control)
            this._control.close();
        for (let [object, id] of this._nmSignals)
            object.disconnect(id);
        this._setWifiDevice(null);
        this._stopDiscovery();
        for (let [object, id] of this._btSignals)
            object.disconnect(id);
        for (let id of Object.values(this._syncIds)) {
            if (id)
                GLib.source_remove(id);
        }
    }

    // Coalesces bursts of D-Bus signals (scans, discovery) into one redraw per key.
    _queueSync(key, callback) {
        if (this._syncIds[key])
            return;
        this._syncIds[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._syncIds[key] = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildMenu() {
        this._mainSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._mainSection);

        let content = new St.BoxLayout({ vertical: true, style_class: 'qs-content' });

        this._wifi = new Tile('network-wireless-signal-excellent-symbolic', _('Wi-Fi'),
            () => this._toggleWifi(), () => this._showWifi());
        this._bluetooth = new Tile('bluetooth-active-symbolic', _('Bluetooth'),
            () => this._toggleBluetooth(), () => this._showBluetooth());
        this._dnd = new Tile('notifications-disabled-symbolic', _('Do Not Disturb'), () => this._toggleDnd());
        this._nightLight = new Tile('night-light-symbolic', _('Night Light'), () => this._toggleNightLight());
        this._darkMode = new Tile('weather-clear-night-symbolic', _('Dark Mode'), () => this._toggleDarkMode());
        this._power = new Tile('power-profile-balanced-symbolic', _('Power Mode'), () => this._cyclePowerMode());

        this._setTileSettings(this._wifi, 'nm-connection-editor');
        this._setTileSettings(this._bluetooth, 'blueman-manager');
        this._setTileSettings(this._dnd, 'cinnamon-settings notifications');
        this._setTileSettings(this._nightLight, 'cinnamon-settings nightlight');
        this._setTileSettings(this._darkMode, 'cinnamon-settings themes');
        this._setTileSettings(this._power, 'cinnamon-settings power');

        let tiles = [this._wifi, this._bluetooth, this._dnd, this._nightLight, this._darkMode, this._power];
        for (let i = 0; i < tiles.length; i += 2) {
            let row = new St.BoxLayout({ style_class: 'qs-row' });
            row.add_child(tiles[i].actor);
            row.add_child(tiles[i + 1].actor);
            content.add_child(row);
        }
        this._mainSection.addActor(content);

        this._mainSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._brightness = new QSSlider('display-brightness-symbolic', null);
        this._brightness.actor.hide();
        this._brightness.connect('value-changed', (slider, value) => this._setBrightness(value));
        this._mainSection.addMenuItem(this._brightness);
        this._setupBrightness();

        this._volume = new QSSlider('audio-volume-high-symbolic', () => this._toggleMute());
        this._volume.actor.hide();
        this._volume.connect('value-changed', (slider, value) => this._setVolume(value));
        this._mainSection.addMenuItem(this._volume);
        this._setupVolume();

        this._mainSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let bottom = new St.BoxLayout({ style_class: 'qs-bottom' });
        bottom.add_child(this._roundButton('preferences-system-symbolic', 'cinnamon-settings'));
        bottom.add_child(new St.Widget({ x_expand: true }));
        bottom.add_child(this._roundButton('system-lock-screen-symbolic', 'cinnamon-screensaver-command --lock'));
        bottom.add_child(this._roundButton('system-shutdown-symbolic', 'cinnamon-session-quit --power-off'));
        this._mainSection.addActor(bottom);

        this._wifiView = new DetailView(_('Wi-Fi'), () => this._showMain(), () => this._toggleWifi(), [
            [_('Hidden Network…'), () => this._launch('nm-connection-editor --create --type=802-11-wireless')],
            [_('Wi-Fi Settings…'), () => this._launch('nm-connection-editor')],
        ]);
        this._bluetoothView = new DetailView(_('Bluetooth'), () => this._showMain(), () => this._toggleBluetooth(), [
            [_('Bluetooth Settings…'), () => this._launch('blueman-manager')],
        ]);
        this._detailViews = [this._wifiView, this._bluetoothView];
        for (let view of this._detailViews)
            this.menu.addMenuItem(view.section);
    }

    _launch(command) {
        this.menu.close();
        Util.spawnCommandLine(command);
    }

    _setTileSettings(tile, command) {
        tile.onSettings = () => this._launch(command);
    }

    _roundButton(iconName, command) {
        let button = new St.Button({ style_class: 'qs-round-button', can_focus: true });
        button.set_child(symbolicIcon(iconName));
        button.connect('clicked', () => this._launch(command));
        return button;
    }

    _showMain() {
        this._stopDiscovery();
        for (let view of this._detailViews)
            view.section.actor.hide();
        this._mainSection.actor.show();
    }

    _showDetail(view) {
        this._mainSection.actor.hide();
        for (let other of this._detailViews)
            other.section.actor.visible = other === view;
    }

    _refresh() {
        this._syncWifi();
        this._syncBluetooth();
        this._refreshPower();
        this._syncSettingsTiles();
    }

    // Wi-Fi

    _setupNetwork() {
        this._nmSignals = [];
        this._deviceSignals = [];
        this._wifiDevice = null;
        NM.Client.new_async(null, (object, res) => {
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                global.logError(`quick-settings: NetworkManager unavailable: ${e.message}`);
                return;
            }
            for (let signal of ['notify::wireless-enabled', 'device-added', 'device-removed',
                                'connection-added', 'connection-removed'])
                this._nmSignals.push([this._client, this._client.connect(signal, () => this._queueWifiSync())]);
            this._syncWifi();
        });
    }

    _setWifiDevice(device) {
        if (device === this._wifiDevice)
            return;
        if (this._wifiDevice) {
            // NM.Device.disconnect() shadows GObject's, so disconnect handlers explicitly.
            for (let id of this._deviceSignals)
                GObject.signal_handler_disconnect(this._wifiDevice, id);
        }
        this._deviceSignals = [];
        this._wifiDevice = device;
        if (device) {
            for (let signal of ['access-point-added', 'access-point-removed', 'notify::active-access-point', 'state-changed'])
                this._deviceSignals.push(device.connect(signal, () => this._queueWifiSync()));
        }
    }

    _queueWifiSync() {
        this._queueSync('wifi', () => this._syncWifi());
    }

    _showWifi() {
        this._showDetail(this._wifiView);
        this._syncWifi();
        if (this._wifiDevice)
            this._wifiDevice.request_scan_async(null, (device, res) => {
                try {
                    device.request_scan_finish(res);
                } catch (e) {
                    // Scans are rate limited by NetworkManager; the cached list is still fine.
                }
            });
    }

    _syncWifi() {
        if (!this._client)
            return;
        this._setWifiDevice(this._client.get_devices().find(d => d.get_device_type() === NM.DeviceType.WIFI) || null);

        let device = this._wifiDevice;
        let enabled = this._client.wireless_enabled;
        let activeAp = device ? device.get_active_access_point() : null;
        let activeConnection = device ? device.get_active_connection() : null;
        let name = activeAp ? ssidToText(activeAp.get_ssid()) : (activeConnection ? activeConnection.get_id() : '');
        let connected = device && device.get_state() === NM.DeviceState.ACTIVATED;

        let subtitle, status;
        if (!enabled) {
            subtitle = _('Off');
            status = _('Wi-Fi is turned off');
        } else if (!device) {
            subtitle = status = _('No Wi-Fi adapter');
        } else if (activeConnection && connected) {
            subtitle = name;
            status = _('Connected to %s').format(name);
        } else if (activeConnection) {
            subtitle = _('Connecting…');
            status = _('Connecting to %s…').format(name);
        } else {
            subtitle = status = _('Not connected');
        }

        this._wifi.setState(enabled, subtitle);
        this._wifi.icon.icon_name = !enabled ? 'network-wireless-disabled-symbolic'
            : signalIcon(activeAp ? activeAp.get_strength() : 100);
        this._wifiView.setEnabled(enabled);
        this._wifiView.status.text = status;

        if (this._wifiView.visible)
            this._buildNetworkList();
    }

    _buildNetworkList() {
        let view = this._wifiView;
        view.clear();
        let device = this._wifiDevice;
        if (!this._client.wireless_enabled || !device)
            return;

        let activeAp = device.get_active_access_point();
        // filter_connections() crashes cjs when releasing its array argument, so filter by hand
        // like Cinnamon's network applet does.
        let connections = this._client.get_connections().filter(c => c.is_type(NM.SETTING_WIRELESS_SETTING_NAME));
        let privacy = NM['80211ApFlags'].PRIVACY;

        // One row per SSID, using the active or strongest access point.
        let networks = new Map();
        for (let ap of device.get_access_points()) {
            let name = ssidToText(ap.get_ssid());
            if (!name)
                continue;
            let active = activeAp !== null && ap.get_path() === activeAp.get_path();
            let current = networks.get(name);
            if (current && (current.active || (!active && current.ap.get_strength() >= ap.get_strength())))
                continue;
            networks.set(name, { name, ap, active });
        }

        let list = [...networks.values()];
        for (let network of list) {
            network.saved = connections.filter(c => network.ap.connection_valid(c));
            network.secure = (network.ap.get_flags() & privacy) !== 0 ||
                network.ap.get_wpa_flags() !== 0 || network.ap.get_rsn_flags() !== 0;
        }
        list.sort((a, b) => (b.active - a.active) ||
            ((b.saved.length > 0) - (a.saved.length > 0)) ||
            (b.ap.get_strength() - a.ap.get_strength()));

        if (list.length === 0) {
            view.addMessage(_('Searching for networks…'));
            return;
        }
        for (let network of list) {
            view.addRow({
                icon: signalIcon(network.ap.get_strength()),
                name: network.name,
                detail: network.active ? _('Connected · click to disconnect') : (network.saved.length > 0 ? _('Saved') : ''),
                secure: network.secure,
                connected: network.active,
                onClick: () => this._activateNetwork(network),
                onForget: network.saved.length > 0 ? () => this._forgetNetwork(network) : null,
            });
        }
    }

    _activateNetwork(network) {
        let device = this._wifiDevice;
        if (!device)
            return;

        if (network.active) {
            device.disconnect_async(null, (d, res) => {
                try {
                    d.disconnect_finish(res);
                } catch (e) {
                    this._wifiError(e);
                }
            });
            return;
        }

        this._wifiView.status.text = _('Connecting to %s…').format(network.name);
        let onDone = (client, res, finish) => {
            try {
                finish.call(client, res);
            } catch (e) {
                this._wifiError(e);
            }
        };
        if (network.saved.length > 0) {
            this._client.activate_connection_async(network.saved[0], device, network.ap.get_path(), null,
                (client, res) => onDone(client, res, client.activate_connection_finish));
        } else {
            // New network: Cinnamon's network agent shows the password dialog, so get the menu out of the way.
            if (network.secure)
                this.menu.close();
            this._client.add_and_activate_connection_async(null, device, network.ap.get_path(), null,
                (client, res) => onDone(client, res, client.add_and_activate_connection_finish));
        }
    }

    _forgetNetwork(network) {
        for (let connection of network.saved) {
            connection.delete_async(null, (c, res) => {
                try {
                    c.delete_finish(res);
                } catch (e) {
                    this._wifiError(e);
                }
            });
        }
    }

    _wifiError(error) {
        if (error.matches && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        this._wifiView.status.text = error.message;
        Main.notify(_('Wi-Fi'), error.message);
    }

    _toggleWifi() {
        let enable = !this._wifi.actor.checked;
        this._wifi.setState(enable, enable ? _('Turning on…') : _('Off'));
        run(`nmcli radio wifi ${enable ? 'on' : 'off'}`, () => this._syncWifi());
    }

    // Bluetooth (BlueZ over D-Bus; blueman's agent handles pairing prompts)

    _setupBluetooth() {
        this._btSignals = [];
        this._btBusy = new Map();
        this._discovering = false;
        Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusObjectManagerClientFlags.NONE,
            BLUEZ, '/', null, null, (object, res) => {
            try {
                this._btManager = Gio.DBusObjectManagerClient.new_for_bus_finish(res);
            } catch (e) {
                global.logError(`quick-settings: BlueZ unavailable: ${e.message}`);
                return;
            }
            for (let signal of ['object-added', 'object-removed', 'interface-proxy-properties-changed'])
                this._btSignals.push([this._btManager, this._btManager.connect(signal, () => this._queueBluetoothSync())]);
            this._syncBluetooth();
        });
    }

    _queueBluetoothSync() {
        this._queueSync('bluetooth', () => this._syncBluetooth());
    }

    _getAdapter() {
        if (!this._btManager)
            return null;
        for (let object of this._btManager.get_objects()) {
            let adapter = object.get_interface(BLUEZ_ADAPTER);
            if (adapter)
                return adapter;
        }
        return null;
    }

    _getBluetoothDevices(adapter) {
        let prefix = adapter.get_object_path() + '/';
        let devices = [];
        for (let object of this._btManager.get_objects()) {
            let proxy = object.get_interface(BLUEZ_DEVICE);
            if (!proxy || !proxy.get_object_path().startsWith(prefix))
                continue;
            let battery = object.get_interface(BLUEZ_BATTERY);
            devices.push({
                proxy,
                path: proxy.get_object_path(),
                name: proxyProperty(proxy, 'Alias'),
                hasName: proxyProperty(proxy, 'Name') !== null,
                icon: proxyProperty(proxy, 'Icon'),
                paired: proxyProperty(proxy, 'Paired'),
                connected: proxyProperty(proxy, 'Connected'),
                rssi: proxyProperty(proxy, 'RSSI'),
                battery: battery ? proxyProperty(battery, 'Percentage') : null,
            });
        }
        return devices;
    }

    _showBluetooth() {
        this._showDetail(this._bluetoothView);
        this._syncBluetooth();
        this._startDiscovery();
    }

    _startDiscovery() {
        let adapter = this._getAdapter();
        if (!adapter || this._discovering || !proxyProperty(adapter, 'Powered'))
            return;
        this._discovering = true;
        adapter.call('StartDiscovery', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._discovering = false;
            }
        });
    }

    _stopDiscovery() {
        let adapter = this._getAdapter();
        if (!adapter || !this._discovering)
            return;
        this._discovering = false;
        adapter.call('StopDiscovery', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                // Discovery already stopped (adapter powered off or reset).
            }
        });
    }

    _syncBluetooth() {
        let adapter = this._getAdapter();
        let enabled = adapter !== null && proxyProperty(adapter, 'Powered');
        let devices = adapter ? this._getBluetoothDevices(adapter) : [];
        let connected = devices.filter(d => d.connected);

        let subtitle;
        if (!adapter)
            subtitle = _('No adapter');
        else if (!enabled)
            subtitle = _('Off');
        else if (connected.length > 1)
            subtitle = _('%d devices').format(connected.length);
        else
            subtitle = connected.length === 1 ? connected[0].name : _('On');
        this._bluetooth.setState(enabled, subtitle);
        this._bluetoothView.setEnabled(enabled);

        if (!this._bluetoothView.visible)
            return;

        let view = this._bluetoothView;
        if (!adapter)
            view.status.text = _('No Bluetooth adapter');
        else if (!enabled)
            view.status.text = _('Bluetooth is turned off');
        else
            view.status.text = _('Visible as “%s”').format(proxyProperty(adapter, 'Alias')) + (this._discovering ? _(' · searching…') : '');

        if (enabled && !this._discovering)
            this._startDiscovery();

        view.clear();
        if (!enabled)
            return;

        let paired = devices.filter(d => d.paired)
            .sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name));
        // Unnamed devices only have a MAC address as alias; they are noise in a picker.
        let others = devices.filter(d => !d.paired && d.hasName && d.rssi !== null)
            .sort((a, b) => b.rssi - a.rssi)
            .slice(0, MAX_OTHER_BT_DEVICES);

        view.addHeading(_('My Devices'));
        if (paired.length === 0)
            view.addMessage(_('No paired devices'));
        for (let device of paired)
            this._addBluetoothRow(device);

        view.addHeading(_('Other Devices'));
        if (others.length === 0)
            view.addMessage(_('Searching…'));
        for (let device of others)
            this._addBluetoothRow(device);
    }

    _addBluetoothRow(device) {
        let detail;
        let busy = this._btBusy.get(device.path);
        if (busy)
            detail = busy;
        else if (device.connected)
            detail = device.battery !== null
                ? _('Connected · %d%% · click to disconnect').format(device.battery)
                : _('Connected · click to disconnect');
        else
            detail = device.paired ? _('Not connected') : _('Click to pair');

        this._bluetoothView.addRow({
            icon: bluetoothIcon(device.icon),
            name: device.name,
            detail: detail,
            connected: device.connected,
            onClick: () => this._activateBluetoothDevice(device),
            onForget: device.paired ? () => this._forgetBluetoothDevice(device) : null,
        });
    }

    _activateBluetoothDevice(device) {
        if (this._btBusy.has(device.path))
            return;

        if (device.connected) {
            this._callDevice(device, 'Disconnect', _('Disconnecting…'));
        } else if (device.paired) {
            this._callDevice(device, 'Connect', _('Connecting…'));
        } else {
            // Pairing may need a PIN/confirmation dialog from blueman's agent.
            this.menu.close();
            this._callDevice(device, 'Pair', _('Pairing…'), () => {
                Gio.DBus.system.call(BLUEZ, device.path, 'org.freedesktop.DBus.Properties', 'Set',
                    new GLib.Variant('(ssv)', [BLUEZ_DEVICE, 'Trusted', new GLib.Variant('b', true)]),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
                this._callDevice(device, 'Connect', _('Connecting…'));
            });
        }
    }

    _callDevice(device, method, busyText, onSuccess) {
        this._btBusy.set(device.path, busyText);
        this._queueBluetoothSync();
        device.proxy.call(method, null, Gio.DBusCallFlags.NONE, 60000, null, (proxy, res) => {
            this._btBusy.delete(device.path);
            try {
                proxy.call_finish(res);
                if (onSuccess)
                    onSuccess();
            } catch (e) {
                Main.notify(_('Bluetooth'), `${device.name}: ${errorText(e)}`);
            }
            this._queueBluetoothSync();
        });
    }

    _forgetBluetoothDevice(device) {
        let adapter = this._getAdapter();
        if (!adapter)
            return;
        adapter.call('RemoveDevice', new GLib.Variant('(o)', [device.path]), Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                Main.notify(_('Bluetooth'), `${device.name}: ${errorText(e)}`);
            }
        });
    }

    _toggleBluetooth() {
        let enable = !this._bluetooth.actor.checked;
        this._bluetooth.setState(enable, enable ? _('Turning on…') : _('Off'));
        let command = enable ? 'rfkill unblock bluetooth; bluetoothctl power on' : 'bluetoothctl power off';
        run(command, () => this._syncBluetooth());
    }

    // Do Not Disturb, Night Light, Dark Mode (gsettings backed)

    _syncSettingsTiles() {
        if (this._notifSettings) {
            let dnd = !this._notifSettings.get_boolean('display-notifications');
            this._dnd.setState(dnd, dnd ? _('On') : _('Off'));
        }
        if (this._colorSettings) {
            let night = this._colorSettings.get_boolean('night-light-enabled');
            let auto = this._colorSettings.get_string('night-light-schedule-mode') === 'auto';
            this._nightLight.setState(night, night ? (auto ? _('Sunset to sunrise') : _('Scheduled')) : _('Off'));
        }
        let dark = this._isDarkMode();
        this._darkMode.setState(dark, dark ? _('On') : _('Off'));
    }

    _toggleDnd() {
        if (this._notifSettings)
            this._notifSettings.set_boolean('display-notifications', this._dnd.actor.checked);
    }

    _toggleNightLight() {
        if (this._colorSettings)
            this._colorSettings.set_boolean('night-light-enabled', !this._nightLight.actor.checked);
    }

    _isDarkMode() {
        if (this._portalSettings)
            return this._portalSettings.get_string('color-scheme') === 'prefer-dark';
        return this._ifaceSettings !== null && this._ifaceSettings.get_string('gtk-theme').toLowerCase().includes('dark');
    }

    _toggleDarkMode() {
        let dark = !this._isDarkMode();
        let gtk = dark ? this.darkGtkTheme : this.lightGtkTheme;
        let icons = dark ? this.darkIconTheme : this.lightIconTheme;
        let cinnamon = dark ? this.darkCinnamonTheme : this.lightCinnamonTheme;

        if (this._ifaceSettings && gtk)
            this._ifaceSettings.set_string('gtk-theme', gtk);
        if (this._ifaceSettings && icons)
            this._ifaceSettings.set_string('icon-theme', icons);
        if (this._portalSettings)
            this._portalSettings.set_string('color-scheme', dark ? 'prefer-dark' : 'prefer-light');
        if (this._themeSettings && cinnamon)
            this._themeSettings.set_string('name', cinnamon);
    }

    // Power mode

    _refreshPower() {
        run('powerprofilesctl get', (out, exitCode) => {
            if (exitCode !== 0 || !POWER_LABELS[out]) {
                this._power.actor.hide();
                return;
            }
            this._powerProfile = out;
            this._power.icon.icon_name = `power-profile-${out}-symbolic`;
            this._power.setState(out !== 'balanced', POWER_LABELS[out]);
        });
    }

    _cyclePowerMode() {
        let next = POWER_CYCLE[this._powerProfile || 'balanced'];
        run(`powerprofilesctl set ${next}`, () => this._refreshPower());
    }

    // Brightness

    _setupBrightness() {
        Interfaces.getDBusProxyAsync('org.cinnamon.SettingsDaemon.Power.Screen', (proxy, error) => {
            if (error)
                return;
            this._brightnessProxy = proxy;
            proxy.GetPercentageRemote((result, error) => {
                if (error)
                    return;
                this._brightness.setValue(result / 100);
                this._brightness.actor.show();
                proxy.connectSignal('Changed', () => this._syncBrightness());
                this.menu.connect('open-state-changed', (menu, open) => {
                    if (open)
                        this._syncBrightness();
                });
            });
        });
    }

    _syncBrightness() {
        if (!this._brightnessProxy || this._brightness._dragging)
            return;
        this._brightnessProxy.GetPercentageRemote((result, error) => {
            if (!error)
                this._brightness.setValue(result / 100);
        });
    }

    _setBrightness(value) {
        if (this._brightnessProxy)
            this._brightnessProxy.SetPercentageRemote(Math.max(1, Math.round(value * 100)), () => {});
    }

    // Volume

    _setupVolume() {
        this._control = new Cvc.MixerControl({ name: 'Quick Settings Volume Control' });
        this._control.connect('state-changed', () => {
            if (this._control.get_state() === Cvc.MixerControlState.READY)
                this._readSink();
        });
        this._control.connect('default-sink-changed', () => this._readSink());
        this._control.open();
    }

    _disconnectSink() {
        if (this._sink) {
            for (let id of this._sinkSignals)
                this._sink.disconnect(id);
        }
        this._sink = null;
        this._sinkSignals = [];
    }

    _readSink() {
        this._disconnectSink();
        this._sink = this._control.get_default_sink();
        if (!this._sink) {
            this._volume.actor.hide();
            return;
        }
        this._sinkSignals.push(this._sink.connect('notify::volume', () => this._syncVolume()));
        this._sinkSignals.push(this._sink.connect('notify::is-muted', () => this._syncVolume()));
        this._volume.actor.show();
        this._syncVolume();
    }

    _syncVolume() {
        if (!this._sink)
            return;
        let norm = this._control.get_vol_max_norm();
        let value = this._sink.is_muted ? 0 : this._sink.volume / norm;
        if (!this._volume._dragging)
            this._volume.setValue(value);

        let icon = 'audio-volume-high-symbolic';
        if (value <= 0)
            icon = 'audio-volume-muted-symbolic';
        else if (value < 0.33)
            icon = 'audio-volume-low-symbolic';
        else if (value < 0.66)
            icon = 'audio-volume-medium-symbolic';
        this._volume.icon.icon_name = icon;
    }

    _setVolume(value) {
        if (!this._sink)
            return;
        this._sink.volume = Math.round(value * this._control.get_vol_max_norm());
        this._sink.push_volume();
        if (this._sink.is_muted !== (value <= 0))
            this._sink.change_is_muted(value <= 0);
    }

    _toggleMute() {
        if (this._sink)
            this._sink.change_is_muted(!this._sink.is_muted);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new QuickSettingsApplet(metadata, orientation, panelHeight, instanceId);
}
